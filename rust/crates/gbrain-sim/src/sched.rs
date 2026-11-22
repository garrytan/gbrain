//! A single-threaded, seeded scheduler. Simulated clients, readers and the commit pipeline are
//! tasks; each step the scheduler picks one ready task at random (from the seed), advances the
//! fake clock and records the choice in the trace. The interleaving is therefore a pure function
//! of the seed, which is what makes a failure reproducible.

use crate::clock::SimClock;
use crate::rng::SimRng;
use crate::trace::Trace;

/// What the scheduler gives a task for one step.
pub struct Cx<'a> {
    pub rng: &'a mut SimRng,
    pub clock: &'a SimClock,
    pub trace: &'a mut Trace,
}

pub enum Step {
    /// The task did something and wants to run again.
    Continue,
    /// The task has nothing left to do for good.
    Done,
    /// The task was picked but had nothing to do right now (another task must act first).
    Idle,
}

pub trait Task<W> {
    fn name(&self) -> &str;
    /// Whether the task could make progress now. Not-ready tasks are not picked.
    fn ready(&self, world: &W) -> bool;
    fn step(&mut self, world: &mut W, cx: &mut Cx<'_>) -> Step;
}

pub struct Scheduler<W> {
    tasks: Vec<Option<Box<dyn Task<W>>>>,
    pub rng: SimRng,
    pub clock: SimClock,
    pub trace: Trace,
    pub steps: u64,
}

impl<W> Scheduler<W> {
    pub fn new(seed: u64) -> Self {
        Scheduler {
            tasks: Vec::new(),
            rng: SimRng::new(seed),
            clock: SimClock::new(),
            trace: Trace::new(),
            steps: 0,
        }
    }

    pub fn spawn(&mut self, task: Box<dyn Task<W>>) {
        self.tasks.push(Some(task));
    }

    /// Run one step. Returns false when no task is left or none is ready.
    pub fn step(&mut self, world: &mut W) -> bool {
        let ready: Vec<usize> = self
            .tasks
            .iter()
            .enumerate()
            .filter(|(_, t)| t.as_ref().is_some_and(|t| t.ready(world)))
            .map(|(i, _)| i)
            .collect();
        if ready.is_empty() {
            return false;
        }
        let i = ready[self.rng.below(ready.len())];
        let mut task = self.tasks[i].take().expect("ready task exists");
        self.clock
            .advance_ns(1_000 * (1 + self.rng.below(50)) as u64);
        let mut cx = Cx {
            rng: &mut self.rng,
            clock: &self.clock,
            trace: &mut self.trace,
        };
        cx.trace
            .event(&format!("step {} task {}", self.steps, task.name()));
        let r = task.step(world, &mut cx);
        self.steps += 1;
        if !matches!(r, Step::Done) {
            self.tasks[i] = Some(task);
        }
        true
    }

    /// Run until nothing is ready or `max_steps` is reached or `stop(world)` is true.
    pub fn run(&mut self, world: &mut W, max_steps: u64, stop: impl Fn(&W) -> bool) {
        while self.steps < max_steps && !stop(world) && self.step(world) {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Counter(&'static str, u32);
    impl Task<Vec<String>> for Counter {
        fn name(&self) -> &str {
            self.0
        }
        fn ready(&self, _: &Vec<String>) -> bool {
            self.1 > 0
        }
        fn step(&mut self, w: &mut Vec<String>, cx: &mut Cx<'_>) -> Step {
            self.1 -= 1;
            w.push(format!("{}@{}", self.0, cx.clock.now_ns()));
            if self.1 == 0 {
                Step::Done
            } else {
                Step::Continue
            }
        }
    }

    fn run(seed: u64) -> (Vec<String>, u64) {
        let mut s = Scheduler::new(seed);
        s.spawn(Box::new(Counter("a", 5)));
        s.spawn(Box::new(Counter("b", 5)));
        s.spawn(Box::new(Counter("c", 5)));
        let mut world = Vec::new();
        s.run(&mut world, 1000, |_| false);
        (world, s.trace.hash())
    }

    #[test]
    fn the_same_seed_twice_gives_identical_trace_hashes() {
        let (h1, t1) = run(1234);
        let (h2, t2) = run(1234);
        assert_eq!(t1, t2, "trace hash differs between two runs of one seed");
        assert_eq!(h1, h2);
        assert_ne!(run(1235).1, t1);
    }

    #[test]
    fn the_interleaving_is_a_function_of_the_seed() {
        assert_eq!(run(5), run(5));
        assert_ne!(
            run(5).0,
            run(6).0,
            "different seeds should interleave differently"
        );
        assert_eq!(run(5).0.len(), 15);
    }
}
