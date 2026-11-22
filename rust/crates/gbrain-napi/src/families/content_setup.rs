//! Content-root setup: the source it is for (rust/docs/store/content-setup.md).

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `readContentSetupSource(sourceId)`: `{ id, incarnation, local_path }` of the active source, or null.
    #[napi]
    pub fn read_content_setup_source<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_content_setup_source(&source_id))
    }
}
