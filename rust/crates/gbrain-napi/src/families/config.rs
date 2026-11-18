//! Config: `getConfig`, `setConfig`, `unsetConfig`, `listConfigKeys`, `getAllConfig`.
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`,
//! and resolves plain JSON (rust/README.md, "The brain store").

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `getConfig(key)`: the value or `null`.
    #[napi]
    pub fn get_config<'env>(&self, env: &'env Env, key: String) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.get_config(&key))
    }

    /// `setConfig(key, value)`: upsert. Resolves `null`.
    #[napi]
    pub fn set_config<'env>(
        &self,
        env: &'env Env,
        key: String,
        value: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.set_config(&key, &value))
    }

    /// `unsetConfig(key)`: the number of rows removed (0 or 1).
    #[napi]
    pub fn unset_config<'env>(&self, env: &'env Env, key: String) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.unset_config(&key))
    }

    /// `listConfigKeys(prefix)`: sorted keys that start with `prefix` (a literal prefix).
    #[napi]
    pub fn list_config_keys<'env>(
        &self,
        env: &'env Env,
        prefix: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_config_keys(&prefix))
    }

    /// `getAllConfig()`: `{ [key]: value }`.
    #[napi]
    pub fn get_all_config<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, |s| s.get_all_config())
    }

    /// `getConfigValues(keys)`: `{ key, value }[]` of the stored keys, ordered by key.
    #[napi]
    pub fn get_config_values<'env>(
        &self,
        env: &'env Env,
        keys: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.get_config_values(&required::<Vec<String>>(keys, "getConfigValues keys")?)
        })
    }
}
