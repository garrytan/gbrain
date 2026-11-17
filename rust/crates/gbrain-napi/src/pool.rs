//! A small worker pool with a clean shutdown, and a cancellable step runner.
//!
//! The pool is plain Rust: it knows nothing about JavaScript. The binding wraps each call in a
//! [`Task`] that settles a JavaScript promise when the work finishes or is cancelled.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
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
    /// Worker threads that are still in their loop.
    workers: u32,
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

/// Worker threads in their loop across every pool in the process.
static LIVE_WORKERS: AtomicU32 = AtomicU32::new(0);

/// Worker threads still in their loop across every pool in the process.
pub fn live_workers() -> u32 {
    LIVE_WORKERS.load(Ordering::SeqCst)
}

/// The most worker threads one pool starts. A larger request is cut to this.
pub const MAX_WORKERS: usize = 256;

/// Starts one worker thread. The default uses `std::thread`; tests pass one that can fail.
type Spawner<'a> = dyn FnMut(usize, Box<dyn FnOnce() + Send>) -> std::io::Result<()> + 'a;

impl Pool {
    /// Start `workers` threads (at least 1, at most [`MAX_WORKERS`]). If the operating system
    /// refuses a thread, the threads already started stop and the call returns
    /// `internal_error`; nothing panics.
    pub fn new(workers: usize) -> Result<Self, TaskError> {
        Self::start(workers, &mut |index, work| {
            // Detached on purpose: at process exit the operating system ends the workers.
            thread::Builder::new()
                .name(format!("gbrain-worker-{index}"))
                .spawn(work)
                .map(drop)
        })
    }

    fn start(workers: usize, spawn: &mut Spawner<'_>) -> Result<Self, TaskError> {
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                phase: Phase::Running,
                queue: VecDeque::new(),
                running: 0,
                workers: 0,
            }),
            changed: Condvar::new(),
        });
        for index in 0..workers.clamp(1, MAX_WORKERS) {
            let worker_shared = Arc::clone(&shared);
            // Counted before the thread starts, so a worker that exits at once never underflows.
            shared.lock().workers += 1;
            LIVE_WORKERS.fetch_add(1, Ordering::SeqCst);
            if spawn(index, Box::new(move || worker_loop(&worker_shared))).is_err() {
                shared.lock().workers -= 1;
                LIVE_WORKERS.fetch_sub(1, Ordering::SeqCst);
                // Close the pool so the workers already started leave their loop.
                shared.lock().phase = Phase::Closed;
                shared.changed.notify_all();
                return Err(TaskError::internal());
            }
        }
        Ok(Self { shared })
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

    /// Worker threads still in their loop. It falls to 0 after the pool closes and the last
    /// running task ends.
    pub fn workers(&self) -> u32 {
        self.shared.lock().workers
    }

    /// Close the pool without waiting: queued tasks are cancelled, idle workers exit now and
    /// busy ones exit when their task ends. For an owner that goes away without `shutdown`.
    pub fn close_now(&self) {
        self.begin_shutdown().finish(Duration::ZERO);
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
    /// Blocks the calling thread. Calling it again waits for whatever is still running and
    /// reports the later outcome.
    pub fn shutdown(&self, wait: Duration) -> ShutdownReport {
        self.begin_shutdown().finish(wait)
    }

    /// Stop admission now, without blocking: every `submit` after this returns refuses the
    /// task. Queued tasks are taken out of the queue but not yet cancelled; [`Draining::finish`]
    /// cancels them and does the bounded wait, so the binding can run that part off the
    /// JavaScript thread.
    pub fn begin_shutdown(&self) -> Draining {
        let (queued, running_at_start) = {
            let mut state = self.shared.lock();
            if state.phase == Phase::Running {
                state.phase = Phase::ShuttingDown;
            }
            (std::mem::take(&mut state.queue), state.running)
        };
        self.shared.changed.notify_all();
        Draining {
            shared: Arc::clone(&self.shared),
            queued,
            running_at_start,
        }
    }
}

/// A shutdown that has closed admission and still has to cancel and wait.
pub struct Draining {
    shared: Arc<Shared>,
    queued: VecDeque<Box<dyn Task>>,
    running_at_start: u32,
}

impl Draining {
    /// Cancel the queued tasks, wait up to `wait` for running ones, then close the pool.
    pub fn finish(self, wait: Duration) -> ShutdownReport {
        let cancelled_queued = self.queued.len() as u32;
        for task in self.queued {
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
            finished_running: self.running_at_start.saturating_sub(abandoned_running),
            abandoned_running,
        }
    }
}

fn worker_loop(shared: &Shared) {
    run_worker(shared);
    shared.lock().workers -= 1;
    LIVE_WORKERS.fetch_sub(1, Ordering::SeqCst);
    shared.changed.notify_all();
}

fn run_worker(shared: &Shared) {
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
    cancel: Option<&CancelToken>,
) -> Result<u32, TaskError> {
    run_steps_observed(steps, step, cancel, |_| {})
}

/// [`run_steps`] that calls `after_step` with the count after each finished step.
fn run_steps_observed(
    steps: u32,
    step: Duration,
    cancel: Option<&CancelToken>,
    mut after_step: impl FnMut(u32),
) -> Result<u32, TaskError> {
    let mut completed = 0;
    while completed < steps {
        if cancel.is_some_and(CancelToken::is_cancelled) {
            return Err(TaskError::cancelled(completed, true));
        }
        thread::sleep(step);
        completed += 1;
        after_step(completed);
    }
    Ok(completed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::{CANCELLED, Detail, ENGINE_SHUTDOWN, INTERNAL_ERROR};
    use std::sync::mpsc;

    const LONG: Duration = Duration::from_secs(5);

    /// Says "started" when a worker picks it up, holds the worker until `release` is signalled
    /// (or dropped), then says "ran". Says "cancelled" if the pool cancels it instead.
    struct Probe {
        events: mpsc::Sender<&'static str>,
        release: Option<mpsc::Receiver<()>>,
    }

    impl Probe {
        fn quick(events: &mpsc::Sender<&'static str>) -> Box<Self> {
            Box::new(Self {
                events: events.clone(),
                release: None,
            })
        }

        fn held(events: &mpsc::Sender<&'static str>) -> (Box<Self>, mpsc::Sender<()>) {
            let (release_tx, release_rx) = mpsc::channel();
            let probe = Box::new(Self {
                events: events.clone(),
                release: Some(release_rx),
            });
            (probe, release_tx)
        }
    }

    impl Task for Probe {
        fn run(self: Box<Self>) {
            let _ = self.events.send("started");
            if let Some(release) = &self.release {
                // A closed channel also releases the task.
                let _ = release.recv();
            }
            let _ = self.events.send("ran");
        }
        fn cancel(self: Box<Self>, error: TaskError) {
            assert_eq!(error.code, CANCELLED);
            let _ = self.events.send("cancelled");
        }
    }

    struct Panics;
    impl Task for Panics {
        fn run(self: Box<Self>) {
            panic!("a task panicked on purpose");
        }
        fn cancel(self: Box<Self>, _: TaskError) {}
    }

    fn pool(workers: usize) -> Pool {
        Pool::new(workers).expect("start the pool")
    }

    /// Waits until `check` holds, for at most [`LONG`].
    fn eventually(what: &str, check: impl Fn() -> bool) {
        let deadline = Instant::now() + LONG;
        while !check() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            thread::yield_now();
        }
    }

    #[test]
    fn steps_report_how_many_finished_when_cancelled_after_the_start() {
        let token = CancelToken::new();
        let (step_tx, step_rx) = mpsc::channel();
        let worker = {
            let token = token.clone();
            thread::spawn(move || {
                run_steps_observed(1000, Duration::from_millis(1), Some(&token), |n| {
                    let _ = step_tx.send(n);
                })
            })
        };
        // Cancel only after the first step is known to be done.
        assert_eq!(step_rx.recv_timeout(LONG), Ok(1));
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
        let pool = pool(1);
        let (tx, rx) = mpsc::channel();
        let (first, release) = Probe::held(&tx);
        assert!(pool.submit(first).is_ok());
        assert_eq!(rx.recv_timeout(LONG), Ok("started"));
        assert!(pool.submit(Probe::quick(&tx)).is_ok());
        assert!(pool.submit(Probe::quick(&tx)).is_ok());
        let shutdown = {
            let pool = pool.clone();
            thread::spawn(move || pool.shutdown(LONG))
        };
        // Both queued tasks are cancelled before the running one is let go.
        assert_eq!(rx.recv_timeout(LONG), Ok("cancelled"));
        assert_eq!(rx.recv_timeout(LONG), Ok("cancelled"));
        drop(release);
        let report = shutdown.join().unwrap();
        assert_eq!(
            report,
            ShutdownReport {
                cancelled_queued: 2,
                finished_running: 1,
                abandoned_running: 0
            }
        );
        assert_eq!(rx.recv_timeout(LONG), Ok("ran"));
        assert_eq!(pool.phase(), Phase::Closed);
        let refused = pool.submit(Probe::quick(&tx));
        assert!(refused.is_err(), "a closed pool takes no work");
        assert_eq!(TaskError::shutdown().code, ENGINE_SHUTDOWN);
        eventually("the worker to exit", || pool.workers() == 0);
    }

    #[test]
    fn shutdown_gives_up_waiting_after_the_bound() {
        let pool = pool(1);
        let (tx, rx) = mpsc::channel();
        let (held, release) = Probe::held(&tx);
        assert!(pool.submit(held).is_ok());
        assert_eq!(rx.recv_timeout(LONG), Ok("started"));
        let report = pool.shutdown(Duration::from_millis(20));
        assert_eq!(report.abandoned_running, 1);
        assert_eq!(pool.phase(), Phase::Closed);
        // The abandoned task still ends on its own, and then its worker exits.
        drop(release);
        assert_eq!(rx.recv_timeout(LONG), Ok("ran"));
        eventually("the worker to exit", || pool.workers() == 0);
    }

    #[test]
    fn admission_closes_when_shutdown_begins_not_when_it_finishes() {
        let pool = pool(1);
        let (tx, rx) = mpsc::channel();
        let (held, release) = Probe::held(&tx);
        assert!(pool.submit(held).is_ok());
        assert_eq!(rx.recv_timeout(LONG), Ok("started"));
        assert!(pool.submit(Probe::quick(&tx)).is_ok());
        let draining = pool.begin_shutdown();
        assert_eq!(pool.phase(), Phase::ShuttingDown);
        assert!(
            pool.submit(Probe::quick(&tx)).is_err(),
            "no task is admitted once shutdown has begun"
        );
        assert_eq!(
            pool.queued(),
            0,
            "the queued task was taken out of the queue"
        );
        drop(release);
        let report = draining.finish(LONG);
        assert_eq!(report.cancelled_queued, 1);
        assert_eq!(report.finished_running, 1);
        let mut seen: Vec<_> = rx.try_iter().collect();
        seen.sort_unstable();
        assert_eq!(seen, ["cancelled", "ran"]);
    }

    #[test]
    fn close_now_stops_idle_workers_without_waiting() {
        let pool = pool(4);
        eventually("the workers to start", || pool.workers() == 4);
        let (tx, rx) = mpsc::channel();
        let (held, release) = Probe::held(&tx);
        assert!(pool.submit(held).is_ok());
        assert_eq!(rx.recv_timeout(LONG), Ok("started"));
        pool.close_now();
        assert_eq!(pool.phase(), Phase::Closed);
        assert!(pool.submit(Probe::quick(&tx)).is_err());
        eventually("the idle workers to exit", || pool.workers() == 1);
        drop(release);
        eventually("the busy worker to exit", || pool.workers() == 0);
    }

    #[test]
    fn a_worker_that_cannot_start_fails_the_pool_and_stops_the_others() {
        let mut started = Vec::new();
        let result = Pool::start(3, &mut |index, work| {
            if index == 2 {
                return Err(std::io::Error::other("no more threads"));
            }
            started.push(thread::spawn(work));
            Ok(())
        });
        let error = result.err().expect("the pool must not start");
        assert_eq!(error.code, INTERNAL_ERROR);
        let (done_tx, done_rx) = mpsc::channel();
        thread::spawn(move || {
            for worker in started {
                let _ = worker.join();
            }
            let _ = done_tx.send(());
        });
        assert_eq!(
            done_rx.recv_timeout(LONG),
            Ok(()),
            "the workers already started must leave their loop"
        );
    }

    #[test]
    fn the_worker_count_is_at_least_one_and_at_most_the_bound() {
        let mut asked = 0;
        let mut count = |workers| {
            asked = 0;
            let pool = Pool::start(workers, &mut |_, _| {
                asked += 1;
                Ok(())
            })
            .expect("start");
            pool.close_now();
            asked
        };
        assert_eq!(count(0), 1);
        assert_eq!(count(3), 3);
        assert_eq!(count(usize::MAX), MAX_WORKERS);
    }

    #[test]
    fn a_panicking_task_does_not_kill_its_worker() {
        let pool = pool(1);
        assert!(pool.submit(Box::new(Panics)).is_ok());
        let (tx, rx) = mpsc::channel();
        assert!(pool.submit(Probe::quick(&tx)).is_ok());
        assert_eq!(rx.recv_timeout(LONG), Ok("started"));
        assert_eq!(rx.recv_timeout(LONG), Ok("ran"));
    }
}
