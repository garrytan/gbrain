//! The store as an addon class. `Brain` owns at most one open brain and runs every call on the
//! worker pool it was built with, so the JavaScript thread only queues work and settles results.
//!
//! Rules every method follows (the contract is documented in `rust/README.md`):
//! - arguments are plain JSON-shaped values; results are plain JSON-shaped values, with `null`
//!   where PGLite returns null;
//! - the call returns a promise; a failure rejects with an `Error` whose `code` is one of the
//!   store codes in the README;
//! - a call made while the brain is closed rejects with `store_closed`.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use gbrain_store::{OpenOptions, Store, StoreError};
use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::binding::{Pool, spawn};
use crate::error::TaskError;
use crate::pool;
use crate::store_bind::bind_into;

type Slot = Arc<Mutex<Option<Arc<Store>>>>;

/// How long `close` waits for calls already running before it reports `store_io`.
const CLOSE_WAIT: Duration = Duration::from_secs(30);

/// The `Instant` of `at_ms`, milliseconds since the Unix epoch (a past time is now).
pub(crate) fn instant_at(at_ms: f64) -> Instant {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0);
    let ahead = if at_ms.is_finite() {
        (at_ms - now_ms).max(0.0)
    } else {
        0.0
    };
    Instant::now() + Duration::from_secs_f64(ahead / 1000.0)
}

pub(crate) fn task_error(error: StoreError) -> TaskError {
    TaskError::new(error.code, error.message)
}

/// Decodes a JSON argument. `null` and a missing argument are the same thing.
pub(crate) fn arg<T: DeserializeOwned + Default>(
    value: Option<Value>,
    what: &str,
) -> Result<T, StoreError> {
    match value {
        None | Some(Value::Null) => Ok(T::default()),
        Some(value) => {
            serde_json::from_value(value).map_err(|e| StoreError::invalid(format!("{what}: {e}")))
        }
    }
}

/// Like `arg`, for an argument that must be given.
pub(crate) fn required<T: DeserializeOwned>(value: Value, what: &str) -> Result<T, StoreError> {
    serde_json::from_value(value).map_err(|e| StoreError::invalid(format!("{what}: {e}")))
}

/// Options for `Brain#open`.
#[napi(object)]
pub struct BrainOpenOptions {
    /// What a fresh brain stores as config `version` (the TypeScript `LATEST_SCHEMA_VERSION`).
    pub schema_version: Option<u32>,
    /// Recorded in `FORMAT` when the brain is created.
    pub created_by: Option<String>,
    /// Opt-in: let many write transactions run at once. Off unless this is true or
    /// `GBRAIN_RUST_CONCURRENT_WRITES=1` is set.
    pub concurrent_writes: Option<bool>,
    /// The embedding identity a fresh brain records as config `embedding_model` and
    /// `embedding_dimensions`, resolved by the caller the way the SQL engines resolve it.
    pub embedding_model: Option<String>,
    pub embedding_dimensions: Option<u32>,
    /// What a fresh brain records as config `chunk_strategy`.
    pub chunk_strategy: Option<String>,
    /// A fresh brain records the write gate's scan baseline under this detector version (the
    /// TypeScript `WRITE_GATE_DETECTOR_VERSION`).
    pub write_gate_detector_version: Option<u32>,
    /// Multi-user mode (I-0), resolved by the caller for this brain (`GBRAIN_RUST_MULTIUSER=1` or the brain's config
    /// `engine.rust.multiuser: true`). It implies concurrent writes. Absent or false: the open is unchanged.
    pub multiuser: Option<bool>,
}

#[napi]
pub struct Brain {
    pool: pool::Pool,
    slot: Slot,
    /// Bumped by every `close`. An `open` still queued when `close` is called sees a newer value
    /// and refuses, so a close never resolves while a queued open can still take the brain's lock.
    pub(crate) closes: Arc<AtomicU64>,
    /// True while a `bind` on this handle is running, so a second one is refused at once.
    binding: Arc<AtomicBool>,
    /// The deadline every call of this handle runs under (`withDeadline`, multi-user mode only):
    /// installed for the one call on the worker thread (`gbrain_store::call_context`). `None` on
    /// every handle `new Brain` makes.
    deadline: Option<Instant>,
    /// Multi-user sessions opened on this handle (`families/access_scope.rs`); unused unless one is minted.
    pub(crate) scopes: Arc<Mutex<crate::families::access_scope::ScopeTable>>,
}

impl Brain {
    /// Runs `work` on the pool against the open store. The store handle is taken now, on the
    /// calling thread, so calls run against the brain that was open when they were made.
    pub(crate) fn run<'env, T: Serialize + Send + 'static>(
        &self,
        env: &'env Env,
        work: impl FnOnce(&Store) -> Result<T, StoreError> + Send + 'static,
    ) -> napi::Result<Object<'env>> {
        let store = self.slot.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let deadline = self.deadline;
        spawn(env, &self.pool, move || {
            let store = store.ok_or_else(|| {
                TaskError::new(gbrain_store::error::STORE_CLOSED, "the brain is not open")
            })?;
            let value = match deadline {
                None => work(&store),
                Some(at) => gbrain_store::call_context::with_deadline(Some(at), || work(&store)),
            }
            .map_err(task_error)?;
            serde_json::to_value(value).map_err(|e| {
                TaskError::new(
                    gbrain_store::error::STORE_CORRUPT,
                    format!("a result could not be encoded: {e}"),
                )
            })
        })
    }

    /// The open store, taken now on the calling thread; `None` when the handle is closed.
    pub(crate) fn current(&self) -> Option<Arc<Store>> {
        self.slot.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Runs `open` on this handle's pool and makes the store it returns this handle's store: how a
    /// handle comes to run on a store bound to a transaction (`families/transactions.rs`). Rejects
    /// `invalid_state` when this handle is already open or binding, and `store_closed` when `close`
    /// was called on it after the bind was queued. `run` then works unchanged. The wait inside
    /// `open` does not hold the handle's slot (`store_bind.rs`).
    pub(crate) fn bind<'env>(
        &self,
        env: &'env Env,
        open: impl FnOnce() -> Result<Store, StoreError> + Send + 'static,
    ) -> napi::Result<Object<'env>> {
        let slot = self.slot.clone();
        let binding = self.binding.clone();
        let closes = self.closes.clone();
        let closes_at_call = closes.load(Ordering::SeqCst);
        spawn(env, &self.pool, move || {
            bind_into(&slot, &binding, &closes, closes_at_call, open)
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
            closes: Arc::new(AtomicU64::new(0)),
            binding: Arc::new(AtomicBool::new(false)),
            deadline: None,
            scopes: Arc::new(Mutex::new(Default::default())),
        }
    }

    /// `withDeadline(deadlineAtMs)`: a handle on the same brain and pool whose calls run under the
    /// absolute deadline `deadlineAtMs` (milliseconds since the Unix epoch). A write that queues for
    /// a busy key ends `timeout` (reason `key_wait`) at it. Multi-user mode only; nothing else makes
    /// one.
    #[napi]
    pub fn with_deadline(&self, deadline_at_ms: f64) -> Self {
        Self {
            pool: self.pool.clone(),
            slot: self.slot.clone(),
            closes: self.closes.clone(),
            binding: self.binding.clone(),
            deadline: Some(instant_at(deadline_at_ms)),
            // The same handle's sessions: the deadline view is the handle, not a new one.
            scopes: self.scopes.clone(),
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

    /// True while the open brain runs in multi-user mode (I-0); false when closed or off. A bound transaction handle
    /// answers for the brain it runs on.
    #[napi(getter)]
    pub fn multiuser(&self) -> bool {
        self.slot
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .is_some_and(|s| s.multiuser())
    }

    /// `open(path, options?)`: opens the brain in directory `path` (created when empty) and
    /// resolves `{ brain_id, format_version, schema_version, created }`.
    ///
    /// Rejects `store_locked` when another handle or process owns the brain, `format_unknown` for
    /// a format this build does not read, `invalid_state` when this handle is already open, and
    /// `store_closed` when `close` was called on this handle before the open ran.
    #[napi]
    pub fn open<'env>(
        &self,
        env: &'env Env,
        path: String,
        options: Option<BrainOpenOptions>,
    ) -> napi::Result<Object<'env>> {
        let slot = self.slot.clone();
        let closes = self.closes.clone();
        let closes_at_call = closes.load(Ordering::SeqCst);
        spawn(env, &self.pool, move || {
            let mut opts = OpenOptions {
                engine_abi: crate::ENGINE_ABI,
                catalog_version: crate::CATALOG_VERSION,
                concurrent_writes: std::env::var("GBRAIN_RUST_CONCURRENT_WRITES")
                    .is_ok_and(|v| v == "1"),
                ..OpenOptions::default()
            };
            if let Some(options) = options {
                if let Some(on) = options.concurrent_writes {
                    opts.concurrent_writes = on;
                }
                if let Some(v) = options.schema_version {
                    opts.schema_version = v;
                }
                if let Some(by) = options.created_by {
                    opts.created_by = by;
                }
                if let Some(model) = options.embedding_model {
                    opts.initial_config.push(("embedding_model".into(), model));
                }
                if let Some(dims) = options.embedding_dimensions {
                    opts.initial_config
                        .push(("embedding_dimensions".into(), dims.to_string()));
                }
                if let Some(strategy) = options.chunk_strategy {
                    opts.initial_config
                        .push(("chunk_strategy".into(), strategy));
                }
                opts.write_gate_detector_version = options.write_gate_detector_version;
                opts.multiuser = options.multiuser.unwrap_or(false);
            }
            // Holding the slot while opening makes a second `open` on this handle wait, then see
            // the brain open.
            let mut guard = slot.lock().unwrap_or_else(|e| e.into_inner());
            // `close` bumps the counter before it takes the slot lock, so a close called after this
            // open was queued is seen here, or else waits for this open and releases what it opened.
            if closes.load(Ordering::SeqCst) != closes_at_call {
                return Err(TaskError::new(
                    gbrain_store::error::STORE_CLOSED,
                    "the brain was closed before it opened",
                ));
            }
            if guard.is_some() {
                return Err(TaskError::new(
                    gbrain_store::error::INVALID_STATE,
                    "this handle already has a brain open; close it first",
                ));
            }
            let store = Store::open_dir(std::path::Path::new(&path), opts).map_err(task_error)?;
            let info = serde_json::to_value(store.info())
                .map_err(|e| TaskError::new(gbrain_store::error::STORE_CORRUPT, e.to_string()))?;
            *guard = Some(Arc::new(store));
            Ok(info)
        })
    }

    /// `close()`: waits for calls already running, then releases the brain and its lock. Resolves
    /// `undefined`; closing a closed handle is a no-op. An `open` queued before the close and not
    /// yet run rejects `store_closed` and opens nothing.
    #[napi]
    pub fn close<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.closes.fetch_add(1, Ordering::SeqCst);
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
