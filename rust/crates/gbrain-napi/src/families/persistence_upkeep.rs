//! The write journal's upkeep statements (`persistenceUpkeepStore()`,
//! `engine-sql/persistence-upkeep.ts`): one binding that takes the statement's name and its
//! arguments as a JSON array, in the order of the TypeScript method (rust/docs/store/persistence.md,
//! "Upkeep").

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `persistenceUpkeepStore().<op>(...args)`: resolves what the statement answers.
    #[napi]
    pub fn persistence_upkeep<'env>(
        &self,
        env: &'env Env,
        op: String,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: Vec<Value> = required(args, "persistenceUpkeepStore arguments")?;
            s.persistence_upkeep(&op, &a)
        })
    }
}
