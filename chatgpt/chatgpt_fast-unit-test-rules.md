---
title: "Fast Unit Test Rules"
type: guide
created: 2026-03-06
updated: 2026-03-06
source: chatgpt-export
conversation_id: 69ab3cfc-31ac-8327-a23c-d1edf66a0155
message_count: 4
tags: [chatgpt, import, code, long-form]
---
# Fast Unit Test Rules

> Conversation ID: 69ab3cfc-31ac-8327-a23c-d1edf66a0155
> Created: 2026-03-06T20:46:38Z
> Updated: 2026-03-06T20:51:01Z
> Messages: 4

---

## User

Hey, homie, I'm trying to get, um, our, we generally keep our unit tests under 200 milliseconds and then refactor anything that's over that, um, or move it to an integration test or whatever, um, is, but there's like, oftentimes an AI writes the tests that they use weird timeouts and handlers and stuff. Um, is there like a deterministic rule set I can use that will prevent the excessive refactoring of tests and just get me fast tests from the beginning?

---

## Assistant

Yes. Use a fixed test-design policy and make the AI follow it before it writes a single assertion.

A good deterministic rule set is:

**Unit test contract**
1. **No real I/O**
   - No network
   - No filesystem
   - No database
   - No sleep/timers
   - No subprocesses
   - No waiting on retries/backoff/polling

2. **Single process, single responsibility**
   - Test one function/class/module behavior
   - Maximum one concrete subject under test
   - Everything else is fake, stubbed, or in-memory

3. **Deterministic inputs only**
   - Freeze time
   - Seed randomness
   - Stub UUIDs / IDs
   - Stub env vars / process state
   - No dependence on machine load, wall clock, timezone, or test order

4. **Bounded setup cost**
   - No shared global bootstrapping unless it is pure and cached
   - No app container startup
   - No framework boot unless the framework itself is what you are testing
   - Object graph depth should stay small

5. **Fast doubles only**
   - Prefer pure fakes over mocks
   - Prefer in-memory repositories over DB-backed fixtures
   - Prefer stubbed adapters over HTTP mocking layers when possible
   - Avoid spy-heavy tests that exercise incidental calls

6. **Zero timeout logic in unit tests**
   - Do not use arbitrary waits, polling loops, retry helpers, debounce windows, or eventual assertions
   - If production code depends on time, inject a clock/scheduler and advance it manually

7. **Minimal data**
   - Small fixtures
   - One record beats 100
   - Builder defaults should produce the cheapest valid object
   - No giant JSON payloads unless parsing is the actual unit under test

8. **No concurrency in unit tests unless concurrency is the subject**
   - No background workers
   - No real thread scheduling assumptions
   - Test async code by awaiting a single deterministic completion point

9. **Hard budget**
   - Per test target: under **50 ms**
   - Per test file target: under **200 ms**
   - Anything over budget must justify itself or be reclassified

10. **Promotion rule**
   - If a test requires real boundaries, multiple subsystems, real timing, or startup cost, it is **integration**, not unit

That gives you a clean classifier:

**Keep as unit test only if all are true**
- Pure computation or one component with injected doubles
- No real I/O
- No real clock/timer dependence
- No uncontrolled async/concurrency
- Setup is cheap
- Runtime is predictably small

**Move to integration test if any are true**
- Crosses process or storage boundary
- Requires framework/container boot
- Depends on real serialization, ORM, routing, middleware, auth stack
- Needs retry/eventual consistency behavior
- Verifies multiple components wired together

For AI-generated tests specifically, give it a **negative rule list**. This matters more than broad advice.

Use a prompt policy like this:

```text
Write a unit test under these rules:

- No sleeps, waits, polling, retries, timeouts, fake delays, or eventual assertions.
- No network, filesystem, database, subprocesses, or real framework boot.
- Freeze or inject time; never read the real clock.
- Seed or stub randomness and IDs.
- Use in-memory fakes or simple stubs for collaborators.
- Keep setup minimal and local to the test.
- Use the smallest valid fixture data.
- Test one behavior only.
- If the behavior requires real I/O, real timing, app startup, or multi-component wiring, stop and mark it as an integration test instead of forcing a unit test.
- Prefer dependency injection over patching globals.
- Avoid mocks unless verifying a single meaningful interaction.
- Target runtime under 50 ms.
```

Then add a **preflight checklist** the AI must satisfy before outputting code:

```text
Before writing the test, explicitly answer:
1. What is the unit under test?
2. Which collaborators will be replaced by fakes/stubs?
3. What sources of nondeterminism exist?
4. How will time/randomness/IDs be controlled?
5. Why does this qualify as a unit test rather than an integration test?
6. What part keeps runtime under 50 ms?
```

That usually cuts out the garbage timeouts and handlers.

A few engineering patterns make this much easier:

- **Inject Clock** instead of calling `Date.now()` / `time.time()` directly
- **Inject Scheduler** instead of using real timers
- **Inject Repository/Client interfaces** instead of constructing DB/HTTP clients internally
- **Use in-memory fakes** for repos and queues
- **Use object builders** with cheap defaults
- **Separate orchestration from side effects** so business logic stays pure

The core principle is simple:

**Pure logic gets unit tests. Boundary behavior gets integration tests. Time is always injected.**

If you want a sharper enforcement mechanism, add CI gates:
- fail any test using `sleep` or timeout helpers in the unit-test directory
- fail any unit test importing DB/network/framework boot modules
- report the slowest tests and auto-flag anything above your threshold

A practical threshold set is:
- ideal: **< 10 ms/test**
- acceptable: **10–50 ms/test**
- suspicious: **50–200 ms/test**
- reclassify or redesign: **> 200 ms/test**

The cleanest deterministic rule is:

**A unit test must execute entirely in memory with controlled time and controlled dependencies.**

That rule alone prevents most unnecessary refactoring later.

I can turn this into a copy-paste testing policy for your repo or a lint/CI ruleset prompt for AI-generated tests.

---

## User

That sounds good. Can you re-audit that answer based on 2026 best practices and then consolidate it into a single prompt that I can give to cloud code that instructs both agent MD and then any other guidelines or docs that need to be updated and then any test or CI stuff that needs to be updated. And then make sure that it specifies to use agent teams to run parallelization and use GitHub Worktrees isolation if there's anything that conflicts with each other.

---

## Assistant

Mr. White, I’m assuming you meant **Claude Code**.

Re-audit, 2026 version:

- For Claude Code, the primary persistent project instruction file is **`CLAUDE.md`**, with optional scoped rules in **`.claude/rules/`**. Anthropic recommends keeping each `CLAUDE.md` concise, specific, and ideally under 200 lines, and using scoped rules for larger projects. citeturn4view0turn4view2turn4view3
- **Hooks** are the deterministic enforcement layer. Anthropic’s docs explicitly frame hooks as the way to ensure actions always happen, instead of hoping the model chooses them. citeturn1view4
- For parallel work, **agent teams** are the right fit when workers need to communicate and coordinate; **subagents** are better for isolated tasks that only need to return a result. Agent teams are still marked **experimental** and must be enabled explicitly. citeturn3view0turn1view2
- For isolation, Claude Code supports **Git worktrees** directly, including `--worktree`, and Anthropic recommends isolated sessions/worktrees for parallel tasks to prevent interference. `/batch` also uses isolated worktrees per unit. citeturn1view3turn3view3turn1view5

Use this as the single prompt:

```text
You are working inside this repository in Claude Code.

Goal:
Establish a durable, deterministic testing policy that keeps unit tests fast from the beginning, minimizes future test refactors, and aligns all repo instructions, docs, and CI around that policy.

Execution requirements:
1. Use Claude Code best practices for persistent project guidance:
   - Treat CLAUDE.md as the primary Claude Code instruction file.
   - If CLAUDE.md does not exist, create it.
   - If AGENTS.md exists, update it too so it stays consistent with CLAUDE.md.
   - If both exist, keep them aligned but avoid duplicating long policy blocks unnecessarily. Put the canonical project policy in CLAUDE.md and keep AGENTS.md concise if appropriate.
   - If the repo is large or multi-language, split detailed policy into scoped files under .claude/rules/ and keep the root CLAUDE.md concise.

2. Use parallelization intelligently:
   - Use agent teams for independent parallel workstreams that benefit from coordination.
   - Use separate Git worktrees for any parallel tasks that may touch overlapping files, conflicting branches, or otherwise risk interference.
   - If two workstreams are likely to conflict, isolate them in separate worktrees and reconcile after review.
   - Prefer a lead-agent pattern: one lead coordinates, specialized teammates handle docs, test policy, CI, and implementation details.
   - Keep parallel tasks small, concrete, and independently verifiable.

3. First audit the repo before editing:
   - Find all current project-instruction files and agent guidance files, including CLAUDE.md, AGENTS.md, CONTRIBUTING.md, README sections, docs/, engineering standards, testing guides, lint configs, test configs, CI workflows, pre-commit hooks, and any custom scripts.
   - Identify contradictions, outdated guidance, duplicated rules, and missing enforcement.
   - Identify the test stack and runtime ecosystem actually used in this repo.
   - Identify where AI-generated tests are currently going wrong: sleeps, polling, retries, fake timeouts, handler-heavy tests, excessive framework boot, real I/O, giant fixtures, cross-layer unit tests, or slow global setup.

4. Then implement a deterministic fast-test policy across the repo.
   The policy must define unit tests as follows:
   - No real network, filesystem, database, subprocesses, or external services.
   - No arbitrary sleeps, waits, polling, retries, debounce windows, backoff loops, or eventual assertions.
   - No dependence on wall clock, timezone, randomness, UUID generation, machine load, test order, or shared mutable global state.
   - Time must be injected, frozen, or manually advanced through a fake clock or scheduler.
   - Randomness and generated IDs must be seeded or stubbed.
   - Collaborators must be replaced with in-memory fakes or simple stubs unless the collaboration itself is the subject under test.
   - Unit tests should exercise a single behavior with minimal fixture data and bounded setup.
   - Real boundary behavior belongs in integration tests.
   - Async unit tests must use deterministic completion points and must not rely on race timing.
   - Concurrency should only appear in unit tests when concurrency itself is the subject under test.

5. Add explicit reclassification rules:
   Mark tests as integration tests when they require any of the following:
   - framework or app boot
   - real DB, real filesystem, real HTTP, real queue, real cache, real containerized dependencies
   - multiple subsystems wired together
   - serialization, ORM, routing, middleware, auth stack, migrations, or bootstrapping that is essential to the assertion
   - eventual consistency, retries, background workers, or real timing behavior

6. Add concrete performance budgets:
   - default target: under 50 ms per unit test
   - preferred target: under 10 ms per unit test where feasible
   - suspicious band: 50–200 ms
   - over 200 ms requires redesign, reclassification, or explicit documented exception
   - keep test-file setup lean and remove expensive shared setup unless it materially improves total runtime

7. Update repo guidance so AI coding agents follow this by default.
   Update or create:
   - CLAUDE.md
   - AGENTS.md if present or clearly needed for non-Claude tooling
   - CONTRIBUTING.md
   - any testing guide, engineering standards doc, or architecture doc that should reference these rules
   - any templates, scaffolding docs, or prompt files used for test generation

8. In the guidance files, include a strict “AI-generated test rules” section that says:
   - never use sleeps or arbitrary timeouts in unit tests
   - never poll or retry in unit tests
   - never boot the full app for a unit test
   - never hit real I/O from a unit test
   - inject time and dependencies
   - prefer pure logic extraction over mocking-heavy tests
   - use integration tests for boundary verification
   - keep fixtures minimal
   - optimize for determinism first, speed second, completeness third
   - when uncertain whether something is a unit or integration test, classify conservatively and document why

9. Add deterministic enforcement in tooling.
   Implement repo-appropriate enforcement using the stack already present here. Examples:
   - lint rules or static checks that forbid sleep/time-wait helpers inside unit-test directories
   - checks that flag imports of DB/network/framework boot modules from unit tests
   - rules or scripts that detect focused tests, oversized fixtures, or disallowed helpers in unit-test paths
   - test naming or directory conventions that separate unit vs integration clearly
   - CI jobs that run unit tests and integration tests separately
   - reporting of slowest unit tests with failure thresholds or warning thresholds
   - optional pre-commit or pre-push checks where appropriate

10. Prefer deterministic enforcement over advisory text.
    Where Claude Code hooks, linting, scripts, or CI can make a rule enforceable, implement that rather than only documenting it.

11. Preserve developer ergonomics:
    - avoid adding heavy process overhead unless it materially improves correctness
    - keep commands simple
    - reuse existing toolchain conventions
    - avoid adding framework-specific complexity that this repo does not already use

12. Deliverables:
    - updated instruction files and docs
    - updated test and CI configuration
    - any helper scripts or lint rules needed for enforcement
    - a short migration note summarizing what changed and why
    - a concise list of tests or test patterns that were reclassified from unit to integration
    - a concise list of places where the repo had contradictory guidance and how you resolved it

Working method:
A. Start with a read-only audit and produce a compact plan.
B. Break the work into parallel tracks using agent teams where helpful:
   - repo-instruction track
   - test-policy track
   - CI/lint enforcement track
   - test-classification track
C. Put potentially conflicting edits in separate Git worktrees.
D. Reconcile changes, run validation, and ensure the final guidance is internally consistent.

Validation:
- Run the smallest relevant verification commands after each change set.
- Run the full relevant lint/test/CI-equivalent checks before finishing.
- Confirm that CLAUDE.md, AGENTS.md, CONTRIBUTING.md, and CI all express the same unit-vs-integration policy.
- Confirm there are no contradictory instructions across root docs and scoped rules.
- Confirm any new enforcement actually runs in this repo.

Output format:
1. Audit summary
2. Files changed
3. Policy decisions
4. Enforcement added
5. Reclassified tests or patterns
6. Remaining risks or follow-ups
7. Exact commands run
```

One important correction from your wording: for Claude Code, **`CLAUDE.md` is the native project memory mechanism**. `AGENTS.md` can still be maintained for cross-tool consistency, but `CLAUDE.md` should be the canonical source for Claude Code behavior. citeturn1view1turn4view0
