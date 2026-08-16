use std::cell::BorrowMutError;

use js::RewriterError as JsRewriterError;
use js_sys::{Error, Reflect};
use thiserror::Error;
use wasm_bindgen::{JsError, JsValue};

#[derive(Debug, Error)]
pub enum RewriterError {
	#[error("JS: {0}")]
	Js(String),
	#[error("JS Rewriter: {0}")]
	JsRewriter(#[from] JsRewriterError),

	#[error("str fromutf8 error: {0}")]
	Str(#[from] std::str::Utf8Error),
	#[error("reflect set failed: {0}")]
	ReflectSetFail(String),
	#[error("Rewriter was already rewriting")]
	AlreadyRewriting(#[from] BorrowMutError),

	#[error("{0} was not {1}")]
	Not(&'static str, &'static str),
}

impl From<JsValue> for RewriterError {
	fn from(value: JsValue) -> Self {
		Self::Js(Error::from(value).to_string().into())
	}
}

impl From<RewriterError> for JsValue {
	fn from(value: RewriterError) -> Self {
		let source_fault = value.is_source_fault();
		let value: JsValue = JsError::from(value).into();

		// The JS side has to tell "this source does not parse" (safe to hand back untouched, it
		// cannot execute) from "we failed" (must NOT be handed back: valid code served unrewritten
		// runs without the wrap). thiserror's Display is not a contract worth grepping, so the
		// answer travels as a property on the error itself. See rewriteJs in shared/rewriters/js.ts.
		let _ = Reflect::set(&value, &"scramjetSourceFault".into(), &source_fault.into());

		value
	}
}

impl RewriterError {
	/// Is the SOURCE at fault (invalid javascript), rather than the rewriter?
	///
	/// Only the js rewriter can answer yes. Everything else in this enum is a failure of ours --
	/// a bad config object, a reflect that did not take, a rewriter already borrowed -- and those
	/// happen on source that was perfectly valid and was about to run.
	pub fn is_source_fault(&self) -> bool {
		matches!(self, Self::JsRewriter(err) if err.is_source_fault())
	}

	pub fn not_str(x: &'static str) -> Self {
		Self::Not(x, "string")
	}

	pub fn not_arr(x: &'static str) -> Self {
		Self::Not(x, "array")
	}

	pub fn not_fn(x: &'static str) -> Self {
		Self::Not(x, "function")
	}

	pub fn not_bool(x: &'static str) -> Self {
		Self::Not(x, "bool")
	}
}

pub type Result<T> = std::result::Result<T, RewriterError>;
