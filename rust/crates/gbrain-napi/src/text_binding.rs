//! Prototype, measure only: the mention scanner from `gbrain-text` (rust-outside-engine bench).
//! Not used by gbrain; nothing outside the bench script calls it.

use gbrain_text::{ScanPage, Scanner, Scratch};
use napi::JsString;
use napi::bindgen_prelude::Uint32Array;
use napi_derive::napi;

#[napi]
pub struct MentionScanner {
    inner: Scanner,
}

#[napi]
impl MentionScanner {
    /// `gazetteerJson` is `JSON.stringify([...gazetteer])`.
    #[napi(constructor)]
    pub fn new(gazetteer_json: String) -> napi::Result<Self> {
        Scanner::from_json(&gazetteer_json)
            .map(|inner| MentionScanner { inner })
            .map_err(|e| napi::Error::from_reason(format!("gazetteer: {e}")))
    }

    #[napi(getter)]
    pub fn entries(&self) -> u32 {
        self.inner.len() as u32
    }

    /// Scan a batch: `texts` is every stripped page text joined with no separator, `bounds[k]`
    /// and `bounds[k + 1]` delimit page k in UTF-16 units. Returns flat triples
    /// `(page, entry, offset)` in page order, then mention order.
    #[napi]
    pub fn scan(
        &self,
        texts: JsString,
        bounds: Uint32Array,
        from_sources: Vec<String>,
        from_slugs: Vec<String>,
        allow_cross_source: bool,
    ) -> napi::Result<Uint32Array> {
        let units = texts.into_utf16()?;
        let units: &[u16] = units.as_slice();
        let b: &[u32] = &bounds;
        let mut scratch = Scratch::default();
        let mut pairs = Vec::new();
        let mut out = Vec::new();
        for k in 0..b.len().saturating_sub(1) {
            let page = ScanPage {
                text: &units[b[k] as usize..b[k + 1] as usize],
                from_source: &from_sources[k],
                from_slug: &from_slugs[k],
                ignored: None,
            };
            pairs.clear();
            self.inner
                .scan(&page, allow_cross_source, &mut scratch, &mut pairs);
            for &(e, o) in &pairs {
                out.extend_from_slice(&[k as u32, e, o]);
            }
        }
        Ok(Uint32Array::new(out))
    }
}
