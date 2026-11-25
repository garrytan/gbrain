//! The deadline of the call a thread is running (multi-user mode, interface I-1 and review g3 F2).
//!
//! The binding runs each call of a handle that carries a deadline inside [`with_deadline`]; the store
//! reads it with [`deadline`] where a call can wait: the row-lock queue a retried `Store::write` takes
//! (`occ_kv.rs` `KeyLocks`). The value belongs to the one call on the one thread that installed it,
//! never to a `Store` shared by every caller, and it is gone when the call returns. No call installs
//! one unless multi-user mode is on, so every other path reads `None` and waits as before.

use std::cell::Cell;
use std::time::Instant;

thread_local! {
    static DEADLINE: Cell<Option<Instant>> = const { Cell::new(None) };
}

/// Restores the previous deadline when the call ends, a panic included.
struct Restore(Option<Instant>);

impl Drop for Restore {
    fn drop(&mut self) {
        DEADLINE.with(|d| d.set(self.0));
    }
}

/// Runs `f` with `deadline` as the deadline of the call on this thread. A nested call keeps the
/// earlier of the two deadlines.
pub fn with_deadline<T>(deadline: Option<Instant>, f: impl FnOnce() -> T) -> T {
    let previous = DEADLINE.with(Cell::get);
    let effective = match (previous, deadline) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    };
    DEADLINE.with(|d| d.set(effective));
    let _restore = Restore(previous);
    f()
}

/// The deadline of the call this thread runs, if it has one.
pub fn deadline() -> Option<Instant> {
    DEADLINE.with(Cell::get)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn a_deadline_lasts_one_call_and_nesting_keeps_the_earlier_one() {
        assert_eq!(deadline(), None);
        let soon = Instant::now() + Duration::from_secs(1);
        let later = soon + Duration::from_secs(1);
        with_deadline(Some(later), || {
            assert_eq!(deadline(), Some(later));
            with_deadline(Some(soon), || assert_eq!(deadline(), Some(soon)));
            with_deadline(None, || assert_eq!(deadline(), Some(later)));
            assert_eq!(deadline(), Some(later));
        });
        assert_eq!(deadline(), None);
    }
}
