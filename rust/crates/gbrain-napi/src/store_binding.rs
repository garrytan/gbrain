//! The store as an addon class. `Brain` owns at most one open brain and runs every call on the
//! worker pool it was built with, so the JavaScript thread only queues work and settles results.
//!
//! Rules every method follows (the contract is documented in `rust/README.md`):
//! - arguments are plain JSON-shaped values; results are plain JSON-shaped values, with `null`
//!   where PGLite returns null;
//! - the call returns a promise; a failure rejects with an `Error` whose `code` is one of the
//!   store codes in the README;
//! - a call made while the brain is closed rejects with `store_closed`.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use gbrain_store::{OpenOptions, Store, StoreError};
use napi::bindgen_prelude::Object;
use napi::Env;
use napi_derive::napi;
use serde::Serialize;

use crate::binding::{Pool, spawn};
use crate::error::TaskError;
use crate::pool;

type Slot = Arc<Mutex<Option<Arc<Store>>>>;

/// How long `close` waits for calls already running before it reports `store_io`.
const CLOSE_WAIT: Duration = Duration::from_secs(30);

pub(crate) fn task_error(error: StoreError) -> TaskError {
    TaskError::new(error.code, error.message)
}

/// Options for `Brain#open`.
#[napi(object)]
pub struct BrainOpenOptions {
    /// What a fresh brain stores as config `version` (the TypeScript `LATEST_SCHEMA_VERSION`).
    pub schema_version: Option<u32>,
    /// Recorded in `FORMAT` when the brain is created.
    pub created_by: Option<String>,
}

#[napi]
pub struct Brain {
    pool: pool::Pool,
    slot: Slot,
}

impl Brain {
    /// Runs `work` on the pool against the open store. The store handle is taken now, on the
    /// calling thread, so calls run against the brain that was open when they were made.
    fn run<'env, T: Serialize + Send + 'static>(
        &self,
        env: &'env Env,
        work: impl FnOnce(&Store) -> Result<T, StoreError> + Send + 'static,
    ) -> napi::Result<Object<'env>> {
        let store = self.slot.lock().unwrap_or_else(|e| e.into_inner()).clone();
        spawn(env, &self.pool, move || {
            let store = store.ok_or_else(|| {
                TaskError::new(gbrain_store::error::STORE_CLOSED, "the brain is not open")
            })?;
            let value = work(&store).map_err(task_error)?;
            serde_json::to_value(value).map_err(|e| {
                TaskError::new(
                    gbrain_store::error::STORE_CORRUPT,
                    format!("a result could not be encoded: {e}"),
                )
            })
        })
    }
}

#[napi]
impl Brain {
    /// `new Brain(pool)`. The brain is closed until `open` resolves.
    #[napi(constructor)]
    pub fn new(pool: &Pool) -> Self {
        Self {
            pool: pool.pool.clone(),
            slot: Arc::new(Mutex::new(None)),
        }
    }

    /// True while a brain is open on this handle.
    #[napi(getter)]
    pub fn is_open(&self) -> bool {
        self.slot
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some()
    }

    /// `open(path, options?)`: opens the brain in directory `path` (created when empty) and
    /// resolves `{ brain_id, format_version, schema_version, created }`.
    ///
    /// Rejects `store_locked` when another handle or process owns the brain, `format_unknown` for
    /// a format this build does not read, `invalid_state` when this handle is already open.
    #[napi]
    pub fn open<'env>(
        &self,
        env: &'env Env,
        path: String,
        options: Option<BrainOpenOptions>,
    ) -> napi::Result<Object<'env>> {
        let slot = self.slot.clone();
        spawn(env, &self.pool, move || {
            let mut opts = OpenOptions {
                engine_abi: crate::ENGINE_ABI,
                catalog_version: crate::CATALOG_VERSION,
                ..OpenOptions::default()
            };
            if let Some(options) = options {
                if let Some(v) = options.schema_version {
                    opts.schema_version = v;
                }
                if let Some(by) = options.created_by {
                    opts.created_by = by;
                }
            }
            // Holding the slot while opening makes a second `open` on this handle wait, then see
            // the brain open.
            let mut guard = slot.lock().unwrap_or_else(|e| e.into_inner());
            if guard.is_some() {
                return Err(TaskError::new(
                    gbrain_store::error::INVALID_STATE,
                    "this handle already has a brain open; close it first",
                ));
            }
            let store = Store::open_dir(std::path::Path::new(&path), opts).map_err(task_error)?;
            let info = serde_json::to_value(store.info()).map_err(|e| {
                TaskError::new(gbrain_store::error::STORE_CORRUPT, e.to_string())
            })?;
            *guard = Some(Arc::new(store));
            Ok(info)
        })
    }

    /// `close()`: waits for calls already running, then releases the brain and its lock. Resolves
    /// `undefined`; closing a closed handle is a no-op.
    #[napi]
    pub fn close<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        let taken = self.slot.lock().unwrap_or_else(|e| e.into_inner()).take();
        spawn(env, &self.pool, move || {
            let Some(mut store) = taken else {
                return Ok(());
            };
            let deadline = Instant::now() + CLOSE_WAIT;
            loop {
                match Arc::try_unwrap(store) {
                    Ok(owned) => {
                        owned.close();
                        return Ok(());
                    }
                    Err(shared) => {
                        if Instant::now() > deadline {
                            return Err(TaskError::new(
                                gbrain_store::error::STORE_IO,
                                "calls were still running 30 seconds after close",
                            ));
                        }
                        store = shared;
                        std::thread::sleep(Duration::from_millis(1));
                    }
                }
            }
        })
    }

    /// `info()`: `{ brain_id, format_version, schema_version, created }` of the open brain.
    #[napi]
    pub fn info<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, |store| Ok(store.info().clone()))
    }
}
