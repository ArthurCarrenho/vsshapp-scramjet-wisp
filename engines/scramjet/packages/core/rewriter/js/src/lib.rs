use std::cell::RefCell;

use oxc::{
	allocator::{Allocator, Vec},
	ast_visit::Visit,
	diagnostics::OxcDiagnostic,
	parser::{ParseOptions, Parser},
	span::SourceType,
};
use thiserror::Error;

pub mod cfg;
mod changes;
mod rewrite;
mod visitor;

use cfg::{Config, Flags, UrlRewriter};
use changes::JsChanges;
use visitor::Visitor;

#[derive(Error, Debug)]
pub enum RewriterError {
	#[error("transformer error: {0}")]
	Transformer(#[from] transform::TransformError),
	#[error("url rewriter error: {0}")]
	Url(Box<dyn std::error::Error + Sync + Send>),
	#[error("formatting error: {0}")]
	Formatting(#[from] std::fmt::Error),

	/// The source is not parseable javascript. See [`RewriterError::is_source_fault`].
	///
	/// This used to be spelled `OxcPanicked`, after oxc's `ParserReturn::panicked` flag, and the
	/// name cost real debugging time: it reads as "the parser crashed", so it looks like our bug
	/// and like something `catch_unwind` would contain. It is neither. oxc's own docs define the
	/// flag as "the parser cannot recover, so it aborted and `program` is empty" -- an ordinary
	/// fatal syntax error, reported by return value. No Rust panic happens (and none could be
	/// caught anyway: this workspace builds with `panic = "abort"`).
	#[error("source is not parseable javascript: {0}")]
	InvalidSource(String),
	#[error("Already rewriting")]
	AlreadyRewriting,
	#[error("Not rewriting")]
	NotRewriting,
	#[error("Changes left over")]
	Leftover,
}

impl RewriterError {
	/// Is the SOURCE at fault (invalid javascript), rather than the rewriter?
	///
	/// This is the one question that decides whether the original source may be served when a
	/// rewrite fails, and until now nothing asked it -- every failure took the same path.
	///
	/// Invalid source is harmless to hand back: it does not execute. The browser raises the same
	/// SyntaxError with or without the proxy, which is usually the point -- Google evaluates
	/// `x='` on purpose, as an environment probe, and expects to catch the throw.
	///
	/// Our own failure is a different thing entirely. That source was valid and was going to run;
	/// handing it back unrewritten runs it WITHOUT the wrap, so it reads the real `location`, the
	/// real origin and the real cookies. Unwrapped code seeing the real origin is exactly the
	/// family of bugs that broke the YouTube chat panel and reCAPTCHA.
	pub fn is_source_fault(&self) -> bool {
		matches!(self, Self::InvalidSource(_))
	}
}

#[derive(Debug)]
pub struct RewriteResult<'alloc> {
	pub js: Vec<'alloc, u8>,
	pub sourcemap: Vec<'alloc, u8>,

	pub errors: std::vec::Vec<OxcDiagnostic>,
	pub flags: Flags,
}

pub struct Rewriter {
	changes: RefCell<Option<JsChanges<'static, 'static>>>,
}

impl Rewriter {
	fn take_changes<'alloc: 'data, 'data>(
		&'data self,
		alloc: &'alloc Allocator,
	) -> Result<JsChanges<'alloc, 'data>, RewriterError> {
		let mut slot = self
			.changes
			.try_borrow_mut()
			.map_err(|_| RewriterError::AlreadyRewriting)?;

		slot.take()
			.ok_or(RewriterError::AlreadyRewriting)
			.and_then(|x| {
				let mut x = unsafe {
					std::mem::transmute::<JsChanges<'static, 'static>, JsChanges<'alloc, 'data>>(x)
				};
				x.set_alloc(alloc)?;
				Ok(x)
			})
	}

	fn put_changes<'alloc: 'data, 'data>(
		&'data self,
		mut changes: JsChanges<'alloc, 'data>,
	) -> Result<(), RewriterError> {
		if !changes.empty() {
			return Err(RewriterError::Leftover);
		}

		let mut slot = self
			.changes
			.try_borrow_mut()
			.map_err(|_| RewriterError::AlreadyRewriting)?;

		if slot.is_some() {
			Err(RewriterError::NotRewriting)
		} else {
			changes.take_alloc()?;

			let changes = unsafe {
				std::mem::transmute::<JsChanges<'alloc, 'data>, JsChanges<'static, 'static>>(
					changes,
				)
			};

			slot.replace(changes);

			Ok(())
		}
	}

	/// Put the changes back after a failed rewrite, discarding whatever was half-built.
	///
	/// ⚠ This is not tidiness. It is the difference between one failed rewrite and a Rewriter that
	/// is broken for the rest of the page's life.
	///
	/// `take_changes` empties the slot and only `put_changes` refills it. Every early return
	/// between the two used to skip the refill, leaving the slot empty forever -- and `take_changes`
	/// reads an empty slot as [`RewriterError::AlreadyRewriting`], so every later `rewrite` on this
	/// instance failed too. Two paths could do it: the url rewriter reporting an error, and
	/// `perform` failing.
	///
	/// The instance is then reused, which is what turns a local bug into a page-wide one.
	/// `getRewriter` (`shared/rewriters/wasm.ts`) keeps a module-level pool that never evicts, so
	/// the broken Rewriter goes right back in and is handed out again. On the JS side a failed
	/// rewrite falls back to `allowInvalidJs` -- on by default -- which returns the ORIGINAL source.
	/// So one transient error would quietly turn the rewriter into a pass-through: every script
	/// after it served unwrapped, reading the real origin, with nothing in the log but a warning
	/// that looks like the harmless `x='` one.
	///
	/// Not observed in production (the console dump has no `Already rewriting`), so this is a hole
	/// being closed, not an outage being explained.
	fn restore(&self, mut changes: JsChanges<'_, '_>) {
		// Before anything else: these changes borrow from the allocator, and the caller resets it
		// as soon as we return.
		changes.clear();
		let _ = changes.take_alloc();

		if let Ok(mut slot) = self.changes.try_borrow_mut() {
			if slot.is_none() {
				// SAFETY: same as put_changes. The allocator reference is gone and the change list
				// is empty, so nothing in here borrows from the arena any more.
				let changes = unsafe {
					std::mem::transmute::<JsChanges<'_, '_>, JsChanges<'static, 'static>>(changes)
				};

				slot.replace(changes);
			}
		}
	}

	pub fn new() -> Self {
		Self {
			changes: RefCell::new(Some(JsChanges::new())),
		}
	}

	pub fn rewrite<'alloc: 'data, 'data, E: UrlRewriter>(
		&'data self,
		alloc: &'alloc Allocator,
		js: &'data str,
		config: Config,
		flags: Flags,
		rewriter: &E,
	) -> Result<RewriteResult<'alloc>, RewriterError> {
		let source_type = SourceType::unambiguous()
			.with_javascript(true)
			.with_module(flags.is_module)
			.with_standard(true);
		let parsed = Parser::new(alloc, js, source_type)
			.with_options(ParseOptions {
				allow_v8_intrinsics: true,
				allow_return_outside_function: true,
				..Default::default()
			})
			.parse();

		if parsed.panicked {
			use std::fmt::Write;

			let mut errors = String::new();
			for error in parsed.errors {
				writeln!(errors, "{error}")?;
			}
			return Err(RewriterError::InvalidSource(errors));
		}

		let jschanges = self.take_changes(alloc)?;

		// The slot is empty from here down, and only `put_changes` refills it. Every exit below has
		// to go through one of the two, or this Rewriter is bricked -- see `restore`.
		let mut visitor = Visitor {
			alloc,
			jschanges,
			error: None,

			config: &config,
			rewriter: rewriter,
			flags,
		};
		visitor.visit_program(&parsed.program);
		if let Some(error) = visitor.error {
			self.restore(visitor.jschanges);

			return Err(RewriterError::Url(error));
		}
		let mut jschanges = visitor.jschanges;

		let changed = match jschanges.perform(js, &config, &visitor.flags) {
			Ok(changed) => changed,
			Err(err) => {
				self.restore(jschanges);

				return Err(err);
			}
		};

		self.put_changes(jschanges)?;

		let js: Vec<'alloc, u8> = changed.source;
		let sourcemap: Vec<'alloc, u8> = changed.map;

		Ok(RewriteResult {
			js,
			sourcemap,
			errors: parsed.errors,
			flags: visitor.flags,
		})
	}
}

#[cfg(test)]
mod tests {
	use std::error::Error;

	use oxc::allocator::{Allocator, StringBuilder};

	use super::{
		Rewriter, RewriterError,
		cfg::{Config, Flags, UrlRewriter},
	};

	fn config() -> Config {
		Config {
			prefix: "/scramjet/".to_string(),

			wrapfn: "$wrap".to_string(),
			wrappropertybase: "$sj_".to_string(),
			wrappropertyfn: "$prop".to_string(),
			cleanrestfn: "$clean".to_string(),
			importfn: "$import".to_string(),
			rewritefn: "$rewrite".to_string(),
			wrappostmessagefn: "$wrapPostMessage".to_string(),
			metafn: "$meta".to_string(),
			pushsourcemapfn: "$pushsourcemap".to_string(),

			trysetfn: "$tryset".to_string(),
			templocid: "$temploc".to_string(),
			tempunusedid: "$tempunused".to_string(),
		}
	}

	fn flags(is_module: bool) -> Flags {
		Flags {
			base: "https://example.com/".to_string(),
			sourcetag: "test".to_string(),

			is_module,
			capture_errors: false,
			scramitize: false,
			do_sourcemaps: false,
			disable_computed_wrap: false,
			destructure_rewrites: false,
		}
	}

	struct UrlOk;
	impl UrlRewriter for UrlOk {
		fn rewrite(
			&self,
			_cfg: &Config,
			_flags: &Flags,
			url: &str,
			builder: &mut StringBuilder,
			_module: bool,
		) -> Result<(), Box<dyn Error + Sync + Send>> {
			builder.push_str(url);

			Ok(())
		}
	}

	/// Stands in for the real one refusing: on the wasm side it is a callback into JS, so anything
	/// it throws arrives here as an error.
	struct UrlRefuses;
	impl UrlRewriter for UrlRefuses {
		fn rewrite(
			&self,
			_cfg: &Config,
			_flags: &Flags,
			_url: &str,
			_builder: &mut StringBuilder,
			_module: bool,
		) -> Result<(), Box<dyn Error + Sync + Send>> {
			Err("refused".into())
		}
	}

	#[test]
	fn unterminated_string_is_the_sources_fault() {
		let alloc = Allocator::default();
		let rewriter = Rewriter::new();

		// Google evaluates exactly this on purpose, as an environment probe. Nine lines of the
		// production console dump were this and nothing else.
		let err = rewriter
			.rewrite(&alloc, "x='", config(), flags(false), &UrlOk)
			.expect_err("`x='` does not parse");

		assert!(err.is_source_fault(), "got {err:?}");
		assert!(err.to_string().contains("Unterminated string"), "got {err}");

		rewriter
			.rewrite(&alloc, "let x = 1;", config(), flags(false), &UrlOk)
			.expect("a source that does not parse must not affect the next rewrite");
	}

	#[test]
	fn a_url_rewriter_failure_does_not_brick_the_rewriter() {
		let alloc = Allocator::default();
		let rewriter = Rewriter::new();

		let err = rewriter
			.rewrite(&alloc, "import \"./a.js\";", config(), flags(true), &UrlRefuses)
			.expect_err("the url rewriter refused, so the rewrite has to fail");

		assert!(matches!(err, RewriterError::Url(_)), "got {err:?}");
		assert!(
			!err.is_source_fault(),
			"the source parsed fine -- the fault is ours, and serving it unrewritten would run it \
			 without the wrap"
		);

		// The regression. Without `restore`, the changes never went back in the slot, and this
		// second call failed with AlreadyRewriting -- as would every later call on this instance,
		// which the module-level pool in wasm.ts keeps handing out.
		rewriter
			.rewrite(&alloc, "let x = location.href;", config(), flags(false), &UrlOk)
			.expect("the rewriter has to survive a url rewriter failure");
	}

	#[test]
	fn only_invalid_source_is_the_sources_fault() {
		assert!(RewriterError::InvalidSource(String::new()).is_source_fault());

		assert!(!RewriterError::AlreadyRewriting.is_source_fault());
		assert!(!RewriterError::NotRewriting.is_source_fault());
		assert!(!RewriterError::Leftover.is_source_fault());
		assert!(!RewriterError::Url("refused".into()).is_source_fault());
	}
}
