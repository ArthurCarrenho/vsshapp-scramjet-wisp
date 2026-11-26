pub mod error;

use error::{Result, RewriterError};
use js::cfg::{Config, Flags};
use js_sys::{Object, Reflect};
use jsr::{JsRewriter, JsRewriterOutput, create_js, create_js_output};
use oxc::allocator::Allocator;
use wasm_bindgen::prelude::*;

use crate::jsr::{WasmUrlRewriter, get_url_rewriter, scramtag};

mod jsr;

#[wasm_bindgen]
extern "C" {
	#[wasm_bindgen(js_namespace = console, js_name = error)]
	fn console_error(s: &str);
	#[wasm_bindgen(js_namespace = console, js_name = error)]
	fn console_error2(s: &JsValue);
}

fn get_obj(obj: &JsValue, k: &'static str) -> Result<JsValue> {
	Ok(Reflect::get(obj, &k.into())?)
}

fn get_str(obj: &JsValue, k: &'static str) -> Result<String> {
	Reflect::get(obj, &k.into())?
		.as_string()
		.ok_or_else(|| RewriterError::not_str(k))
}
fn get_bool(obj: &JsValue, k: &'static str) -> Result<bool> {
	Reflect::get(obj, &k.into())?
		.as_bool()
		.ok_or_else(|| RewriterError::not_bool(k))
}

fn set_obj(obj: &Object, k: &str, v: &JsValue) -> Result<()> {
	if Reflect::set(&obj.into(), &k.into(), v)? {
		Ok(())
	} else {
		Err(RewriterError::ReflectSetFail(k.to_string()))
	}
}

fn get_js_config(config: &Object) -> Result<Config> {
	Ok(Config {
		prefix: get_str(config, "prefix")?,

		wrapfn: get_str(config, "wrapfn")?,
		wrappropertybase: get_str(config, "wrappropertybase")?,
		wrappropertyfn: get_str(config, "wrappropertyfn")?,
		cleanrestfn: get_str(config, "cleanrestfn")?,
		importfn: get_str(config, "importfn")?,
		rewritefn: get_str(config, "rewritefn")?,
		wrappostmessagefn: get_str(config, "wrappostmessagefn")?,
		metafn: get_str(config, "metafn")?,
		pushsourcemapfn: get_str(config, "pushsourcemapfn")?,

		trysetfn: get_str(config, "trysetfn")?,
		templocid: get_str(config, "templocid")?,
		tempunusedid: get_str(config, "tempunusedid")?,
	})
}

// As cinco flags booleanas, na ordem do `Flags`.
type FlagsLidas = [bool; 5];

fn ler_js_flags(obj: &Object) -> Result<FlagsLidas> {
	Ok([
		get_bool(obj, "sourcemaps")?,
		get_bool(obj, "captureErrors")?,
		get_bool(obj, "scramitize")?,
		get_bool(obj, "disableComputedWrap")?,
		get_bool(obj, "destructureRewrites")?,
	])
}

fn get_js_flags(lidas: FlagsLidas, base: String, is_module: bool) -> Flags {
	let [do_sourcemaps, capture_errors, scramitize, disable_computed_wrap, destructure_rewrites] =
		lidas;
	Flags {
		base,
		sourcetag: scramtag(),
		is_module,

		do_sourcemaps,
		capture_errors,
		scramitize,
		disable_computed_wrap,
		destructure_rewrites,
	}
}

#[wasm_bindgen]
pub struct Rewriter {
	alloc: Allocator,

	js: JsRewriter,

	// vssh fork: a configuração e as flags lidas da última chamada, com o objeto de onde vieram.
	// Ler cada campo atravessa a fronteira com o JS duas vezes (o nome e o valor), e o cliente
	// manda o mesmo objeto a cada reescrita; o mesmo objeto devolve o que já foi lido.
	config_lida: Option<(JsValue, Config)>,
	flags_lidas: Option<(JsValue, FlagsLidas)>,
}

impl Rewriter {
	fn config_de(&mut self, jsconfig: &Object) -> Result<Config> {
		if let Some((obj, cfg)) = &self.config_lida {
			if Object::is(obj, jsconfig) {
				return Ok(cfg.clone());
			}
		}
		let cfg = get_js_config(jsconfig)?;
		self.config_lida = Some((jsconfig.clone().into(), cfg.clone()));
		Ok(cfg)
	}

	fn flags_de(&mut self, jsflags: &Object, base: String, module: bool) -> Result<Flags> {
		if let Some((obj, lidas)) = &self.flags_lidas {
			if Object::is(obj, jsflags) {
				return Ok(get_js_flags(*lidas, base, module));
			}
		}
		let lidas = ler_js_flags(jsflags)?;
		self.flags_lidas = Some((jsflags.clone().into(), lidas));
		Ok(get_js_flags(lidas, base, module))
	}
}

#[wasm_bindgen]
impl Rewriter {
	#[wasm_bindgen(constructor)]
	pub fn new() -> Result<Self> {
		Ok(Self {
			alloc: Allocator::default(),

			js: create_js()?,

			config_lida: None,
			flags_lidas: None,
		})
	}

	#[wasm_bindgen]
	pub fn rewrite_js(
		&mut self,
		jsconfig: &Object,
		jsflags: &Object,
		encode_url: Object,
		js: String,
		base: String,
		url: String,
		module: bool,
	) -> Result<JsRewriterOutput> {
		let config = self.config_de(jsconfig)?;
		let flags = self.flags_de(jsflags, base, module)?;
		let rewriter = get_url_rewriter(encode_url)?;

		let out = match self.js.rewrite(&self.alloc, &js, config, flags, &rewriter) {
			Ok(x) => x,
			Err(x) => {
				self.alloc.reset();
				Err(x)?
			}
		};

		let ret = create_js_output(out, url, js);

		self.alloc.reset();
		ret
	}

	#[wasm_bindgen]
	pub fn rewrite_js_bytes(
		&mut self,
		jsconfig: &Object,
		jsflags: &Object,
		encode_url: Object,
		js: Vec<u8>,
		base: String,
		url: String,
		module: bool,
	) -> Result<JsRewriterOutput> {
		// SAFETY: we know the js is a valid utf-8 string
		let js = unsafe { std::string::String::from_utf8_unchecked(js) };

		self.rewrite_js(jsconfig, jsflags, encode_url, js, base, url, module)
	}

}
