//! How `Brain#bind` puts a store on a handle (`families/transactions.rs` uses it to start a
//! transaction). It holds no JavaScript types, so plain `cargo test` covers it.

use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Mutex};

use gbrain_store::StoreError;
use serde_json::Value;

use crate::error::TaskError;
use crate::store_binding::task_error;

/// Makes the store `open` returns this handle's store. Rejects `invalid_state` when the handle
/// already has one.
pub(crate) fn bind_into<S>(
    slot: &Mutex<Option<Arc<S>>>,
    _binding: &AtomicBool,
    _closes: &AtomicU64,
    _closes_at_call: u64,
    open: impl FnOnce() -> Result<S, StoreError>,
) -> Result<Value, TaskError> {
    let mut guard = slot.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_some() {
        return Err(TaskError::new(
            gbrain_store::error::INVALID_STATE,
            "this handle already has a brain open; close it first",
        ));
    }
    *guard = Some(Arc::new(open().map_err(task_error)?));
    Ok(Value::Null)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::Ordering;
    use std::sync::mpsc::{Receiver, Sender, channel};
    use std::thread;
    use std::time::{Duration, Instant};

    use super::*;

    const PATIENCE: Duration = Duration::from_secs(3);

    type Slot = Arc<Mutex<Option<Arc<Opened>>>>;

    /// A stand-in store that says when it is dropped.
    struct Opened(Sender<()>);

    impl Drop for Opened {
        fn drop(&mut self) {
            let _ = self.0.send(());
        }
    }

    struct Handle {
        slot: Slot,
        binding: Arc<AtomicBool>,
        closes: Arc<AtomicU64>,
    }

    impl Handle {
        fn new() -> Self {
            Self {
                slot: Arc::new(Mutex::new(None)),
                binding: Arc::new(AtomicBool::new(false)),
                closes: Arc::new(AtomicU64::new(0)),
            }
        }

        /// What `Brain#bind` does on the pool: `open` stands in for the transaction's wait for
        /// the writer.
        fn bind(
            &self,
            open: impl FnOnce() -> Result<Opened, StoreError> + Send + 'static,
        ) -> Receiver<Result<Value, TaskError>> {
            let (slot, binding, closes) =
                (self.slot.clone(), self.binding.clone(), self.closes.clone());
            let at_call = closes.load(Ordering::SeqCst);
            let (done, result) = channel();
            thread::spawn(move || {
                let _ = done.send(bind_into(&slot, &binding, &closes, at_call, open));
            });
            result
        }

        /// What the JavaScript thread does on this handle (`isOpen`, `run`, `close`): take the
        /// slot. Reports whether it got the slot within a bounded wait instead of hanging.
        fn js_can_take_the_slot(&self) -> bool {
            let until = Instant::now() + PATIENCE;
            while Instant::now() < until {
                if self.slot.try_lock().is_ok() {
                    return true;
                }
                thread::sleep(Duration::from_millis(5));
            }
            false
        }

        fn is_open(&self) -> bool {
            self.slot.lock().unwrap().is_some()
        }
    }

    /// An `open` that tells the test it started, then waits to be let go.
    fn waits_for_writer(
        dropped: Sender<()>,
    ) -> (
        impl FnOnce() -> Result<Opened, StoreError> + Send + 'static,
        Receiver<()>,
        Sender<()>,
    ) {
        let (started_tx, started) = channel();
        let (release, released) = channel::<()>();
        let open = move || {
            started_tx.send(()).unwrap();
            released.recv().unwrap();
            Ok(Opened(dropped))
        };
        (open, started, release)
    }

    fn never_opens() -> impl FnOnce() -> Result<Opened, StoreError> + Send + 'static {
        || panic!("open must not run")
    }

    #[test]
    fn a_bind_waiting_for_the_writer_does_not_block_the_handle() {
        let handle = Handle::new();
        let (dropped, _) = channel();
        let (open, started, release) = waits_for_writer(dropped);
        let result = handle.bind(open);
        started.recv_timeout(PATIENCE).unwrap();
        let free = handle.js_can_take_the_slot();
        release.send(()).unwrap();
        result.recv_timeout(PATIENCE).unwrap().unwrap();
        assert!(
            free,
            "bind kept the slot locked while it waited for the writer, so `isOpen`, `run` and \
             `close` on this handle would block the JavaScript thread"
        );
        assert!(handle.is_open());
    }

    #[test]
    fn a_bind_after_close_was_called_opens_nothing() {
        let handle = Handle::new();
        let at_call = handle.closes.load(Ordering::SeqCst);
        handle.closes.fetch_add(1, Ordering::SeqCst);
        let outcome = bind_into(
            &handle.slot,
            &handle.binding,
            &handle.closes,
            at_call,
            never_opens(),
        );
        assert_eq!(outcome.unwrap_err().code, gbrain_store::error::STORE_CLOSED);
        assert!(!handle.is_open());
    }

    #[test]
    fn a_close_during_the_wait_releases_what_the_bind_opened() {
        let handle = Handle::new();
        let (dropped, was_dropped) = channel();
        let (open, started, release) = waits_for_writer(dropped);
        let result = handle.bind(open);
        started.recv_timeout(PATIENCE).unwrap();
        handle.closes.fetch_add(1, Ordering::SeqCst);
        release.send(()).unwrap();
        let outcome = result.recv_timeout(PATIENCE).unwrap();
        assert_eq!(outcome.unwrap_err().code, gbrain_store::error::STORE_CLOSED);
        assert!(!handle.is_open(), "a closed handle must not end up open");
        assert!(
            was_dropped.recv_timeout(PATIENCE).is_ok(),
            "the store the bind opened must be released"
        );
    }

    #[test]
    fn a_second_bind_while_one_waits_is_refused_at_once() {
        let handle = Handle::new();
        let (dropped, _) = channel();
        let (open, started, release) = waits_for_writer(dropped);
        let first = handle.bind(open);
        started.recv_timeout(PATIENCE).unwrap();
        let second = handle.bind(never_opens());
        let refused = second.recv_timeout(PATIENCE);
        release.send(()).unwrap();
        first.recv_timeout(PATIENCE).unwrap().unwrap();
        let outcome = refused.expect("the second bind waited behind the first");
        assert_eq!(
            outcome.unwrap_err().code,
            gbrain_store::error::INVALID_STATE
        );
    }

    #[test]
    fn a_bind_on_an_open_handle_is_refused_without_opening() {
        let handle = Handle::new();
        let (dropped, _) = channel();
        handle
            .bind(move || Ok(Opened(dropped)))
            .recv_timeout(PATIENCE)
            .unwrap()
            .unwrap();
        let outcome = handle.bind(never_opens()).recv_timeout(PATIENCE).unwrap();
        assert_eq!(
            outcome.unwrap_err().code,
            gbrain_store::error::INVALID_STATE
        );
        assert!(handle.is_open());
    }

    #[test]
    fn a_failed_open_leaves_the_handle_closed_and_free_to_bind_again() {
        let handle = Handle::new();
        let failed = handle
            .bind(|| Err(StoreError::new(gbrain_store::error::STORE_LOCKED, "busy")))
            .recv_timeout(PATIENCE)
            .unwrap();
        assert_eq!(failed.unwrap_err().code, gbrain_store::error::STORE_LOCKED);
        assert!(!handle.is_open());
        let (dropped, _) = channel();
        handle
            .bind(move || Ok(Opened(dropped)))
            .recv_timeout(PATIENCE)
            .unwrap()
            .unwrap();
        assert!(handle.is_open());
    }
}
