//! JavaScript-facing exports. Everything here is a thin shell around `error` and `pool`.
//!
//! Rules every export follows:
//! - the body runs inside `guard`, so a panic is a JavaScript `Error` with code `internal_error`
//!   and the process keeps running;
//! - async work runs on the Rust worker pool and settles a promise, so the Bun event loop is
//!   never blocked;
//! - errors are real `Error` objects with a stable `code` (and, for `cancelled`, the number of
//!   `completedSteps`), never a bare message.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use napi::bindgen_prelude::{
    Float32Array, FromNapiValue, Function, Object, ToNapiValue, TypeName, ValidateNapiValue,
};
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use napi::{Env, JsDeferred, JsValue, Status, ValueType, sys};
use napi_derive::napi;

use crate::error::{Detail, TaskError, guard};
use crate::pool::{self, CancelToken as Token, Task};

type TaskResult<T> = std::result::Result<T, TaskError>;

/// Build the JavaScript `Error` for a typed error: `message`, a stable `code`, and its details.
fn js_error(env: &Env, error: TaskError) -> napi::Error {
    let build = || -> napi::Result<napi::Error> {
        let mut object = env.create_error(napi::Error::new(
            Status::GenericFailure,
            error.message.clone(),
        ))?;
        object.set("code", error.code)?;
        for (key, detail) in &error.details {
            match detail {
                Detail::Count(n) => object.set(*key, *n)?,
                Detail::Flag(flag) => object.set(*key, *flag)?,
                Detail::Text(text) => object.set(*key, text.as_str())?,
            }
        }
        Ok(napi::Error::from(object.to_unknown()))
    };
    build().unwrap_or_else(|_| {
        napi::Error::new(
            Status::GenericFailure,
            format!("{}: {}", error.code, error.message),
        )
    })
}

/// Run a synchronous export: panic to `internal_error`, typed error to a thrown `Error`.
fn sync_call<T>(env: &Env, work: impl FnOnce() -> TaskResult<T>) -> napi::Result<T> {
    guard(work).map_err(|error| js_error(env, error))
}

#[napi(module_exports)]
pub fn module_exports(mut exports: Object, env: Env) -> napi::Result<()> {
    // Plain data properties, so the loader reads them without calling anything.
    exports.set("target", crate::target())?;
    exports.set("engineAbi", crate::ENGINE_ABI)?;
    exports.set("engineBuild", crate::ENGINE_BUILD)?;
    exports.set("catalogVersion", crate::CATALOG_VERSION)?;
    exports.set("formatVersions", env.create_array(0)?)?;
    exports.set("sinkMaxQueueSize", SINK_QUEUE_SIZE as u32)?;
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Typed arrays
// ---------------------------------------------------------------------------------------------

/// Adds in `f64`, starting from +0.0. (`Iterator::sum` on floats starts from -0.0, which would
/// turn an empty array into `-0` in JavaScript.)
fn sum_as_f64(values: &[f32]) -> f64 {
    values.iter().fold(0.0, |total, v| total + f64::from(*v))
}

/// A `Float32Array` argument whose memory no other thread can reach. Rust reads, copies and
/// writes these arrays without locks, which is only sound when the backing buffer is a plain
/// `ArrayBuffer`. A view of a `SharedArrayBuffer` can be written by another Worker during the
/// call, so it is refused with the same `InvalidArg` error as an argument of the wrong type.
pub struct PlainF32(Float32Array);

impl TypeName for PlainF32 {
    fn type_name() -> &'static str {
        "Float32Array"
    }

    fn value_type() -> ValueType {
        ValueType::Object
    }
}

impl ValidateNapiValue for PlainF32 {}

impl FromNapiValue for PlainF32 {
    unsafe fn from_napi_value(env: sys::napi_env, value: sys::napi_value) -> napi::Result<Self> {
        // SAFETY: `env` and `value` come straight from Node-API for this call.
        if unsafe { backed_by_shared_memory(env, value) } {
            return Err(napi::Error::new(
                Status::InvalidArg,
                "a Float32Array over a SharedArrayBuffer is not accepted; copy it into a plain Float32Array first",
            ));
        }
        // SAFETY: as above.
        Ok(Self(unsafe { Float32Array::from_napi_value(env, value) }?))
    }
}

/// True when `value` is a typed array over memory that may be shared, or when that cannot be
/// told. A value that is not a typed array returns false, so the `Float32Array` conversion
/// reports its own wrong-type error.
///
/// # Safety
/// `env` and `value` must be live handles of the current Node-API call.
unsafe fn backed_by_shared_memory(env: sys::napi_env, value: sys::napi_value) -> bool {
    let ok = sys::Status::napi_ok;
    let mut kind = 0;
    let mut length = 0;
    let mut data = std::ptr::null_mut();
    let mut buffer = std::ptr::null_mut();
    let mut offset = 0;
    // SAFETY: every out pointer is a valid local.
    let status = unsafe {
        sys::napi_get_typedarray_info(
            env,
            value,
            &mut kind,
            &mut length,
            &mut data,
            &mut buffer,
            &mut offset,
        )
    };
    if status != ok {
        return false;
    }
    if buffer.is_null() {
        return true;
    }
    let mut plain = false;
    // SAFETY: `buffer` is the live handle the call above returned.
    if unsafe { sys::napi_is_arraybuffer(env, buffer, &mut plain) } != ok || !plain {
        return true;
    }
    // Some runtimes report a SharedArrayBuffer as an ArrayBuffer too, so ask its constructor.
    let mut global = std::ptr::null_mut();
    let mut shared_class = std::ptr::null_mut();
    let mut class_type = 0;
    // SAFETY: valid out pointers and a NUL-terminated property name.
    unsafe {
        if sys::napi_get_global(env, &mut global) != ok
            || sys::napi_get_named_property(
                env,
                global,
                c"SharedArrayBuffer".as_ptr(),
                &mut shared_class,
            ) != ok
            || sys::napi_typeof(env, shared_class, &mut class_type) != ok
        {
            return true;
        }
    }
    if class_type != sys::ValueType::napi_function {
        // No SharedArrayBuffer in this runtime, so no buffer can be one.
        return false;
    }
    let mut is_shared = false;
    // SAFETY: `shared_class` is a function, checked above.
    if unsafe { sys::napi_instanceof(env, buffer, shared_class, &mut is_shared) } != ok {
        return true;
    }
    is_shared
}

/// Sum of a `Float32Array`, added in `f64`. Reads the JavaScript memory in place for the length
/// of the call (a view with a byte offset is honoured); nothing is copied and nothing is kept.
#[napi]
pub fn sum_f32(env: &Env, values: PlainF32) -> napi::Result<f64> {
    let values = values.0;
    sync_call(env, || Ok(sum_as_f64(&values)))
}

/// A new `Float32Array` with every value multiplied by `factor`. The input is left alone and the
/// result is a separate array.
#[napi]
pub fn scale_f32(env: &Env, values: PlainF32, factor: f64) -> napi::Result<Float32Array> {
    let values = values.0;
    sync_call(env, || {
        let scaled: Vec<f32> = values
            .iter()
            .map(|v| (f64::from(*v) * factor) as f32)
            .collect();
        Ok(Float32Array::new(scaled))
    })
}

/// Multiplies every value of the caller's array by `factor`, writing into the same memory.
/// Synchronous only: the JavaScript thread is blocked for the whole call, so nothing else can
/// touch the array while it is written.
#[napi]
pub fn scale_in_place_f32(env: &Env, values: PlainF32, factor: f64) -> napi::Result<u32> {
    let mut values = values.0;
    sync_call(env, || {
        // SAFETY: the call is synchronous on the JavaScript thread, the buffer is not shared with
        // another thread (`PlainF32`), and no other Rust reference to it exists while the slice
        // is alive.
        let slice = unsafe { values.as_mut() };
        for v in slice.iter_mut() {
            *v = (f64::from(*v) * factor) as f32;
        }
        Ok(slice.len() as u32)
    })
}

// ---------------------------------------------------------------------------------------------
// Panics
// ---------------------------------------------------------------------------------------------

/// Panics on purpose, to prove a synchronous panic becomes a JavaScript error.
#[napi]
pub fn probe_panic_sync(env: &Env) -> napi::Result<()> {
    sync_call(env, || -> TaskResult<()> {
        panic!("probe_panic_sync panicked on purpose")
    })
}

// ---------------------------------------------------------------------------------------------
// Cancellation token
// ---------------------------------------------------------------------------------------------

/// What a JavaScript `AbortSignal` is mapped to: `signal.addEventListener('abort', () => token.cancel())`.
#[napi]
pub struct CancelToken {
    token: Token,
}

#[napi]
impl CancelToken {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            token: Token::new(),
        }
    }

    #[napi]
    pub fn cancel(&self) {
        self.token.cancel();
    }

    #[napi(getter)]
    pub fn cancelled(&self) -> bool {
        self.token.is_cancelled()
    }
}

// ---------------------------------------------------------------------------------------------
// The worker pool
// ---------------------------------------------------------------------------------------------

type Resolver<T> = Box<dyn FnOnce(Env) -> napi::Result<T> + Send>;
type Work<T> = Box<dyn FnOnce() -> TaskResult<T> + Send>;

/// A pool task that settles a JavaScript promise: resolved with the work's value, or rejected
/// with a typed `Error`.
struct PromiseTask<T: ToNapiValue + Send + 'static> {
    deferred: JsDeferred<T, Resolver<T>>,
    work: Work<T>,
}

impl<T: ToNapiValue + Send + 'static> Task for PromiseTask<T> {
    fn run(self: Box<Self>) {
        let PromiseTask { deferred, work } = *self;
        let outcome = guard(work);
        settle(deferred, outcome);
    }

    fn cancel(self: Box<Self>, error: TaskError) {
        settle(self.deferred, Err(error));
    }
}

fn settle<T: ToNapiValue + Send + 'static>(
    deferred: JsDeferred<T, Resolver<T>>,
    outcome: TaskResult<T>,
) {
    // The error object is built on the JavaScript thread, where Node-API may be called.
    deferred.resolve(Box::new(move |env| {
        outcome.map_err(|error| js_error(&env, error))
    }));
}

/// Start `work` on the pool and return its promise. A pool that no longer takes work returns a
/// promise already rejected with `engine_shutdown`.
fn spawn<'env, T: ToNapiValue + Send + 'static>(
    env: &'env Env,
    pool: &pool::Pool,
    work: impl FnOnce() -> TaskResult<T> + Send + 'static,
) -> napi::Result<Object<'env>> {
    let (deferred, promise) = env.create_deferred::<T, Resolver<T>>()?;
    let task = Box::new(PromiseTask {
        deferred,
        work: Box::new(work) as Work<T>,
    });
    if let Err(refused) = pool.submit(task) {
        refused.cancel(TaskError::shutdown());
    }
    Ok(promise)
}

/// Worker threads still running across every pool in this process. A pool that is shut down,
/// or whose object was collected, stops counting once its threads exit.
#[napi]
pub fn live_workers() -> u32 {
    pool::live_workers()
}

/// What `shutdown` reports.
#[napi(object)]
pub struct ShutdownReport {
    /// Tasks that were queued and never started; each was rejected with `cancelled`.
    pub cancelled_queued: u32,
    /// Tasks that were running when shutdown began and finished inside the wait.
    pub finished_running: u32,
    /// Tasks still running when the wait ended; they finish on their own later.
    pub abandoned_running: u32,
}

/// A pool of Rust worker threads. Its calls return promises; the JavaScript thread only queues
/// work and settles results.
#[napi]
pub struct Pool {
    pool: pool::Pool,
}

#[napi]
impl Pool {
    /// Starts `workers` threads: at least 1, at most 256. If a thread cannot start, throws
    /// `internal_error` and stops the threads that did start.
    #[napi(constructor)]
    pub fn new(env: &Env, workers: u32) -> napi::Result<Self> {
        sync_call(env, || pool::Pool::new(workers as usize)).map(|pool| Self { pool })
    }

    /// Worker threads still running their loop.
    #[napi(getter)]
    pub fn workers(&self) -> u32 {
        self.pool.workers()
    }

    /// `running`, `shutting_down` or `closed`.
    #[napi(getter)]
    pub fn state(&self) -> String {
        self.pool.phase().as_str().to_owned()
    }

    #[napi(getter)]
    pub fn queued(&self) -> u32 {
        self.pool.queued()
    }

    #[napi(getter)]
    pub fn running(&self) -> u32 {
        self.pool.running()
    }

    /// Holds a worker for `ms` milliseconds, then resolves with `ms`. The event loop stays free.
    #[napi]
    pub fn block_for<'env>(&self, env: &'env Env, ms: u32) -> napi::Result<Object<'env>> {
        spawn(env, &self.pool, move || {
            std::thread::sleep(Duration::from_millis(u64::from(ms)));
            Ok(ms)
        })
    }

    /// `steps` steps of `step_ms` each. Resolves with the steps done. If `token` is cancelled
    /// after the task started, rejects with `cancelled` and `completedSteps`.
    #[napi]
    pub fn run_steps<'env>(
        &self,
        env: &'env Env,
        steps: u32,
        step_ms: u32,
        token: Option<&CancelToken>,
    ) -> napi::Result<Object<'env>> {
        let token = token.map(|t| t.token.clone());
        spawn(env, &self.pool, move || {
            pool::run_steps(
                steps,
                Duration::from_millis(u64::from(step_ms)),
                token.as_ref(),
            )
        })
    }

    /// Async sum. The values are copied before the call returns, because the JavaScript array
    /// may change or be freed while a worker runs.
    #[napi]
    pub fn sum_f32<'env>(&self, env: &'env Env, values: PlainF32) -> napi::Result<Object<'env>> {
        let copy: Vec<f32> = values.0.to_vec();
        spawn(env, &self.pool, move || Ok(sum_as_f64(&copy)))
    }

    /// Async scale. The result is a new `Float32Array` made on the JavaScript thread.
    #[napi]
    pub fn scale_f32<'env>(
        &self,
        env: &'env Env,
        values: PlainF32,
        factor: f64,
    ) -> napi::Result<Object<'env>> {
        let copy: Vec<f32> = values.0.to_vec();
        spawn(env, &self.pool, move || {
            Ok(Float32Array::new(
                copy.iter()
                    .map(|v| (f64::from(*v) * factor) as f32)
                    .collect(),
            ))
        })
    }

    /// Panics on a worker, to prove an async panic becomes a rejected promise and the pool lives on.
    #[napi]
    pub fn probe_panic<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        spawn(env, &self.pool, || -> TaskResult<u32> {
            panic!("probe_panic panicked on purpose")
        })
    }

    /// Stop admission, cancel queued tasks, wait up to `wait_ms` for running ones, then close.
    /// Admission closes before this returns: any call made after it, even while the returned
    /// promise is pending, rejects with `engine_shutdown`.
    #[napi]
    pub fn shutdown<'env>(&self, env: &'env Env, wait_ms: u32) -> napi::Result<Object<'env>> {
        let (deferred, promise) =
            env.create_deferred::<ShutdownReport, Resolver<ShutdownReport>>()?;
        let draining = self.pool.begin_shutdown();
        let wait = Duration::from_millis(u64::from(wait_ms));
        // The thread takes the work out of this slot. If the thread cannot start, the slot still
        // holds it here, so no queued task or promise is left unsettled.
        let slot = Arc::new(Mutex::new(Some((draining, deferred))));
        let thread_slot = Arc::clone(&slot);
        // The wait blocks, so it runs on its own thread, not the JavaScript thread or a worker.
        let spawned = std::thread::Builder::new()
            .name("gbrain-shutdown".into())
            .spawn(move || {
                if let Some((draining, deferred)) = take(&thread_slot) {
                    settle_shutdown(deferred, draining.finish(wait));
                }
            });
        if spawned.is_err()
            && let Some((draining, deferred)) = take(&slot)
        {
            draining.finish(Duration::ZERO);
            let error = TaskError::internal();
            deferred.resolve(Box::new(move |env| Err(js_error(&env, error))));
        }
        Ok(promise)
    }
}

/// A pool whose JavaScript object is collected without `shutdown` closes at once, so its idle
/// workers exit instead of waiting forever. Queued tasks are cancelled; running ones finish.
impl Drop for Pool {
    fn drop(&mut self) {
        self.pool.close_now();
    }
}

type PendingShutdown = (
    pool::Draining,
    JsDeferred<ShutdownReport, Resolver<ShutdownReport>>,
);

fn take(slot: &Mutex<Option<PendingShutdown>>) -> Option<PendingShutdown> {
    slot.lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take()
}

fn settle_shutdown(
    deferred: JsDeferred<ShutdownReport, Resolver<ShutdownReport>>,
    report: pool::ShutdownReport,
) {
    deferred.resolve(Box::new(move |_| {
        Ok(ShutdownReport {
            cancelled_queued: report.cancelled_queued,
            finished_running: report.finished_running,
            abandoned_running: report.abandoned_running,
        })
    }));
}

// ---------------------------------------------------------------------------------------------
// Threadsafe-function queue
// ---------------------------------------------------------------------------------------------

/// The bounded queue size of a [`Sink`]. A const generic in napi-rs, so one fixed value.
const SINK_QUEUE_SIZE: usize = 4;

type SinkFunction = napi::threadsafe_function::ThreadsafeFunction<
    u32,
    (),
    u32,
    Status,
    false,
    true,
    SINK_QUEUE_SIZE,
>;

/// A JavaScript callback fed through a bounded threadsafe-function queue. `emit` never blocks and
/// says what the queue did with the value: `ok`, `queue_full` or `closing`.
///
/// `queue_full` comes from the runtime (Bun) itself. `closing` is reported by this crate from its
/// own closed flag after `close()`; the underlying function is released when the Sink is dropped.
#[napi]
pub struct Sink {
    function: Arc<SinkFunction>,
    closed: Arc<AtomicBool>,
}

fn status_name(status: Status) -> &'static str {
    match status {
        Status::Ok => "ok",
        Status::QueueFull => "queue_full",
        Status::Closing => "closing",
        _ => "error",
    }
}

#[napi]
impl Sink {
    #[napi(constructor)]
    pub fn new(callback: Function<'_, u32, ()>) -> napi::Result<Self> {
        let function = callback
            .build_threadsafe_function::<u32>()
            .callee_handled::<false>()
            .weak::<true>()
            .max_queue_size::<SINK_QUEUE_SIZE>()
            .build()?;
        Ok(Self {
            function: Arc::new(function),
            closed: Arc::new(AtomicBool::new(false)),
        })
    }

    /// Queue `value` for the callback without blocking.
    #[napi]
    pub fn emit(&self, value: u32) -> String {
        let status = guard(|| {
            Ok(if self.closed.load(Ordering::SeqCst) {
                Status::Closing
            } else {
                self.function
                    .call(value, ThreadsafeFunctionCallMode::NonBlocking)
            })
        });
        status.map_or("error", status_name).to_owned()
    }

    /// Emit `count` values from a Rust thread instead of the JavaScript thread; resolves with
    /// the status of each.
    #[napi]
    pub fn emit_from_thread<'env>(&self, env: &'env Env, count: u32) -> napi::Result<Object<'env>> {
        let (deferred, promise) = env.create_deferred::<Vec<String>, Resolver<Vec<String>>>()?;
        let function = Arc::clone(&self.function);
        let closed = Arc::clone(&self.closed);
        let spawned = std::thread::Builder::new()
            .name("gbrain-sink-emit".into())
            .spawn(move || {
                let statuses: Vec<String> = (0..count)
                    .map(|n| {
                        if closed.load(Ordering::SeqCst) {
                            Status::Closing
                        } else {
                            function.call(n, ThreadsafeFunctionCallMode::NonBlocking)
                        }
                    })
                    .map(|status| status_name(status).to_owned())
                    .collect();
                deferred.resolve(Box::new(move |_| Ok(statuses)));
            });
        if spawned.is_err() {
            return Err(js_error(env, TaskError::internal()));
        }
        Ok(promise)
    }

    /// Mark the sink closed: later `emit` calls return `closing`. Values already queued are still delivered.
    #[napi]
    pub fn close(&self) -> napi::Result<()> {
        self.closed.store(true, Ordering::SeqCst);
        Ok(())
    }
}
