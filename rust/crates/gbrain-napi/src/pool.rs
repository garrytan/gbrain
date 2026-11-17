//! A small worker pool with a clean shutdown, and a cancellable step runner.
//!
//! The pool is plain Rust: it knows nothing about JavaScript. The binding wraps each call in a
//! [`Task`] that settles a JavaScript promise when the work finishes or is cancelled.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use crate::error::{TaskError, guard};

/// One unit of queued work. Exactly one of `run` and `cancel` is called, exactly once.
pub trait Task: Send + 'static {
    /// Runs on a worker thread.
    fn run(self: Box<Self>);
    /// The pool shut down before the task started.
    fn cancel(self: Box<Self>, error: TaskError);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Running,
    ShuttingDown,
    Closed,
}

impl Phase {
    pub fn as_str(self) -> &'static str {
        match self {
            Phase::Running => "running",
            Phase::ShuttingDown => "shutting_down",
            Phase::Closed => "closed",
        }
    }
}

/// What `shutdown` found and did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ShutdownReport {
    /// Tasks that were still queued; each was cancelled before it started.
    pub cancelled_queued: u32,
    /// Tasks that were running when shutdown began and finished within the wait.
    pub finished_running: u32,
    /// Tasks still running when the wait ended. They finish on their own later.
    pub abandoned_running: u32,
}

struct State {
    phase: Phase,
    queue: VecDeque<Box<dyn Task>>,
    running: u32,
}

struct Shared {
    state: Mutex<State>,
    changed: Condvar,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        // A task panic is caught before it can poison this lock; if one ever does, keep going.
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[derive(Clone)]
pub struct Pool {
    shared: Arc<Shared>,
}

impl Pool {
    pub fn new(workers: usize) -> Self {
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                phase: Phase::Running,
                queue: VecDeque::new(),
                running: 0,
            }),
            changed: Condvar::new(),
        });
        for index in 0..workers.max(1) {
            let shared = Arc::clone(&shared);
            // Detached on purpose: at process exit the operating system ends the workers.
            thread::Builder::new()
                .name(format!("gbrain-worker-{index}"))
                .spawn(move || worker_loop(&shared))
                .expect("start a worker thread");
        }
        Self { shared }
    }

    pub fn phase(&self) -> Phase {
        self.shared.lock().phase
    }

    pub fn queued(&self) -> u32 {
        self.shared.lock().queue.len() as u32
    }

    pub fn running(&self) -> u32 {
        self.shared.lock().running
    }

    /// Queue a task. A pool that is shutting down or closed hands the task back.
    pub fn submit(&self, task: Box<dyn Task>) -> Result<(), Box<dyn Task>> {
        let mut state = self.shared.lock();
        if state.phase != Phase::Running {
            return Err(task);
        }
        state.queue.push_back(task);
        self.shared.changed.notify_one();
        Ok(())
    }

    /// Stop admission, cancel queued tasks, wait up to `wait` for running ones, then close.
    /// Blocks the calling thread; the binding runs it off the JavaScript thread. Calling it
    /// again waits for whatever is still running and reports the later outcome.
    pub fn shutdown(&self, wait: Duration) -> ShutdownReport {
        let (queued, running_at_start) = {
            let mut state = self.shared.lock();
            if state.phase == Phase::Running {
                state.phase = Phase::ShuttingDown;
            }
            (std::mem::take(&mut state.queue), state.running)
        };
        self.shared.changed.notify_all();
        let cancelled_queued = queued.len() as u32;
        for task in queued {
            // Settling a promise must not take the pool down if it panics.
            let _ = guard(|| {
                task.cancel(TaskError::cancelled(0, false));
                Ok(())
            });
        }
        let deadline = Instant::now() + wait;
        let mut state = self.shared.lock();
        while state.running > 0 {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            state = self
                .shared
                .changed
                .wait_timeout(state, deadline - now)
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .0;
        }
        let abandoned_running = state.running;
        state.phase = Phase::Closed;
        drop(state);
        self.shared.changed.notify_all();
        ShutdownReport {
            cancelled_queued,
            finished_running: running_at_start.saturating_sub(abandoned_running),
            abandoned_running,
        }
    }
}

fn worker_loop(shared: &Shared) {
    loop {
        let task = {
            let mut state = shared.lock();
            loop {
                if let Some(task) = state.queue.pop_front() {
                    state.running += 1;
                    break task;
                }
                if state.phase != Phase::Running {
                    return;
                }
                state = shared
                    .changed
                    .wait(state)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
            }
        };
        // A task settles its own promise and turns its own panic into an error. This second
        // guard only keeps the worker alive if a task fails to.
        let _ = guard(|| {
            task.run();
            Ok(())
        });
        shared.lock().running -= 1;
        shared.changed.notify_all();
    }
}

/// A flag one side sets and the other checks between steps.
#[derive(Clone, Default)]
pub struct CancelToken {
    flag: Arc<AtomicBool>,
}

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }
}

/// Do `steps` steps of `step` each. The token is checked before every step, so a task cancelled
/// after it started stops at the next boundary and reports how many steps it finished.
pub fn run_steps(
    steps: u32,
    step: Duration,
    token: Option<&CancelToken>,
) -> Result<u32, TaskError> {
    let mut completed = 0;
    while completed < steps {
        if token.is_some_and(CancelToken::is_cancelled) {
            return Err(TaskError::cancelled(completed, true));
        }
        thread::sleep(step);
        completed += 1;
    }
    Ok(completed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::{CANCELLED, Detail, ENGINE_SHUTDOWN};
    use std::sync::mpsc;

    struct Probe {
        done: mpsc::Sender<&'static str>,
        hold: Duration,
    }

    impl Task for Probe {
        fn run(self: Box<Self>) {
            thread::sleep(self.hold);
            let _ = self.done.send("ran");
        }
        fn cancel(self: Box<Self>, error: TaskError) {
            assert_eq!(error.code, CANCELLED);
            let _ = self.done.send("cancelled");
        }
    }

    struct Panics;
    impl Task for Panics {
        fn run(self: Box<Self>) {
            panic!("a task panicked on purpose");
        }
        fn cancel(self: Box<Self>, _: TaskError) {}
    }

    #[test]
    fn steps_report_how_many_finished_when_cancelled_after_the_start() {
        let token = CancelToken::new();
        let worker = {
            let token = token.clone();
            thread::spawn(move || run_steps(1000, Duration::from_millis(5), Some(&token)))
        };
        thread::sleep(Duration::from_millis(60));
        token.cancel();
        let error = worker.join().unwrap().expect_err("cancelled");
        assert_eq!(error.code, CANCELLED);
        let completed = error
            .details
            .iter()
            .find_map(|(key, detail)| match (*key, detail) {
                ("completedSteps", Detail::Count(n)) => Some(*n),
                _ => None,
            });
        assert!(
            matches!(completed, Some(n) if n > 0 && n < 1000),
            "{completed:?}"
        );
        assert!(error.details.contains(&("started", Detail::Flag(true))));
    }

    #[test]
    fn steps_finish_when_nobody_cancels() {
        assert_eq!(run_steps(3, Duration::from_millis(1), None), Ok(3));
    }

    #[test]
    fn shutdown_cancels_queued_waits_for_running_and_then_refuses() {
        let pool = Pool::new(1);
        let (tx, rx) = mpsc::channel();
        let hold = Duration::from_millis(150);
        for _ in 0..3 {
            assert!(
                pool.submit(Box::new(Probe {
                    done: tx.clone(),
                    hold
                }))
                .is_ok()
            );
        }
        // Let the single worker take the first task.
        thread::sleep(Duration::from_millis(40));
        let report = pool.shutdown(Duration::from_secs(5));
        assert_eq!(
            report,
            ShutdownReport {
                cancelled_queued: 2,
                finished_running: 1,
                abandoned_running: 0
            }
        );
        assert_eq!(pool.phase(), Phase::Closed);
        let mut seen: Vec<_> = rx.try_iter().collect();
        seen.sort_unstable();
        assert_eq!(seen, ["cancelled", "cancelled", "ran"]);
        let refused = pool.submit(Box::new(Probe { done: tx, hold }));
        assert!(refused.is_err(), "a closed pool takes no work");
        assert_eq!(TaskError::shutdown().code, ENGINE_SHUTDOWN);
    }

    #[test]
    fn shutdown_gives_up_waiting_after_the_bound() {
        let pool = Pool::new(1);
        let (tx, _rx) = mpsc::channel();
        assert!(
            pool.submit(Box::new(Probe {
                done: tx,
                hold: Duration::from_millis(600)
            }))
            .is_ok()
        );
        thread::sleep(Duration::from_millis(40));
        let started = Instant::now();
        let report = pool.shutdown(Duration::from_millis(80));
        assert!(started.elapsed() < Duration::from_millis(500));
        assert_eq!(report.abandoned_running, 1);
        assert_eq!(pool.phase(), Phase::Closed);
    }

    #[test]
    fn a_panicking_task_does_not_kill_its_worker() {
        let pool = Pool::new(1);
        assert!(pool.submit(Box::new(Panics)).is_ok());
        let (tx, rx) = mpsc::channel();
        assert!(
            pool.submit(Box::new(Probe {
                done: tx,
                hold: Duration::ZERO
            }))
            .is_ok()
        );
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)), Ok("ran"));
    }
}
