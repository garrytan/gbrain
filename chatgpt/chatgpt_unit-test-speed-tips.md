---
title: "Unit test speed tips"
type: note
created: 2025-11-27
updated: 2025-11-27
source: chatgpt-export
conversation_id: 6928d156-d938-8325-87b9-2abfa57a86ca
message_count: 6
tags: [chatgpt, import, long-form]
---
# Unit test speed tips

> Conversation ID: 6928d156-d938-8325-87b9-2abfa57a86ca
> Created: 2025-11-27T22:31:55Z
> Updated: 2025-11-27T22:33:45Z
> Messages: 6

---

## User

Unit test speed?

---

## Assistant

For unit tests, “speed” usually means two things: how fast each test runs, and how fast the *whole suite* runs.

**Rules of thumb**

- **Individual test:**  
  - Aim: **\< 50–100 ms** each.  
  - Absolutely no test should be in **seconds** unless it’s really an integration test in disguise.

- **Full unit test suite:**  
  - Aim: **a few seconds** for a typical service/library.  
  - If your unit tests take **> 30–60 seconds**, they’re probably doing too much work (I/O, network, sleeps, big data, etc.).

**How to make them fast**

1. **No real I/O**
   - Avoid disk, DB, network, and external APIs in “unit” tests.  
   - Use in-memory substitutes or mocks/stubs.

2. **Small subject under test**
   - Test small, pure functions where possible.  
   - Push logic out of heavy classes (frameworks, ORMs, HTTP clients) into plain code that’s cheap to test.

3. **Kill `sleep` and time-based waits**
   - Replace with **fake clocks** or injected time providers.  
   - Use polling with very short intervals if you must.

4. **Use proper test pyramid**
   - **Lots of tiny unit tests** (fast)  
   - Fewer integration tests (slower)  
   - Very few end-to-end tests (slowest)

5. **Run tests in parallel**
   - Enable parallel test execution (JUnit 5, pytest `-n`, Jest `--runInBand` only when needed).  
   - Make tests **stateless** and avoid shared global state so parallelism is safe.

6. **Profile the suite**
   - Most test suites have a **small set of “bad citizens”** causing most of the time.  
   - Use your test runner’s timing report and fix the top 5–10 slowest tests first.

7. **Separate slow tests**
   - Tag or group slow tests (`@Slow`, markers, custom suites).  
   - Run unit tests on every change; run slow/integration suites on CI or less frequently.

If you tell me what language/test framework you’re using and roughly how long your suite takes now, I can give you concrete targets and steps for your setup.

---

## User

Give me a prompt to refactor all unit tests to be fast

---

## Assistant

Here you go, Mr. White — drop this into your AI/code assistant and adapt the placeholders:

---

**Prompt to refactor unit tests for speed**

You are an expert test engineer and software architect.

I will give you a codebase (or files) that contain unit tests.  
Your job is to **refactor all unit tests to be as fast as possible** while keeping the same behavior and coverage.

**Goals (in order of priority)**  
1. Preserve correctness and test intent.  
2. Make tests fast and deterministic.  
3. Make tests simple and readable.

**General rules**

- **No real I/O in unit tests**
  - Remove or replace any use of:
    - Real databases, files, network calls, message queues, HTTP clients, cloud services, etc.
  - Use mocks, stubs, in-memory fakes, or dependency injection instead.
  - If a test clearly depends on real infrastructure, mark it as **integration** and move it out of the unit test suite (e.g., different folder or marker/tag).

- **Eliminate `sleep` / time-based flakiness**
  - Remove `sleep`, `setTimeout`, `Thread.sleep`, `time.sleep`, and similar where possible.
  - Introduce a **fake clock** or injectable time provider; use that in tests.
  - If waiting for async behavior, use proper synchronization / await patterns instead of arbitrary waits.

- **Reduce setup cost**
  - Heavy fixtures or `beforeAll`/`setup` that spin up servers, containers, frameworks, or full application contexts should be:
    - Replaced with lighter, local objects, OR  
    - Moved to integration tests.
  - Prefer **plain objects** and **small test data** over huge fixtures.

- **Make tests pure where possible**
  - Prefer testing pure functions and small units over end-to-end flows.
  - If a test is effectively an integration test (multiple layers, real frameworks), classify and relocate it accordingly.

- **Parallel-friendly**
  - Remove global shared mutable state from tests.
  - Make tests independent so they can safely run in parallel.
  - Avoid relying on execution order.

- **Data size and loops**
  - Shrink large test datasets to the minimum that still validates behavior.
  - Remove unnecessary loops, random data, or fuzzing from normal unit tests; if needed, move fuzz-like tests to a separate, explicitly “slow” suite.

**Output format**

For each file you refactor:

1. Show the **original test code** (shortened if very large, but include all important parts you changed).  
2. Show the **refactored test code**.  
3. Briefly explain:
   - What made the tests slow.
   - What you changed to make them fast.
   - Whether any tests were reclassified as integration tests and why.

**Project details**

- Language: `<LANGUAGE>`  
- Test framework: `<TEST FRAMEWORK>`  
- Mocking tools / libs: `<MOCKING LIBS, IF ANY>`  
- Unit tests directory: `<PATH/TO/UNIT/TESTS>`  
- Integration tests directory (or where to move slow tests): `<PATH/TO/INTEGRATION/TESTS>`

Refactor everything in the provided files according to these rules.

---

If you tell me your language and test framework, I can customize this prompt specifically for your stack (e.g., pytest, JUnit, Jest, etc.).

---

## User

Next.js webapp 

---

## Assistant

Here’s a Next.js-specific prompt you can use, Mr. White:

---

You are an expert **Next.js + React** test engineer.

I will give you a Next.js codebase (components, hooks, API routes, route handlers, server actions, etc.) with existing tests. Your job is to **refactor all unit tests to be as fast as possible** while keeping the same behavior and coverage.

### Stack

- Framework: **Next.js** (App Router and/or Pages Router)
- Language: **TypeScript / JavaScript**
- Test runner: `<JEST_OR_VITEST>`  
- React testing: `@testing-library/react` and `@testing-library/jest-dom` (or equivalent)
- Network mocking: `msw` or mocked `fetch` / HTTP client

---

### Goals (priority order)

1. Preserve correctness and test intent.
2. Make tests fast, deterministic, and parallel-friendly.
3. Keep tests simple and readable.
4. Clearly separate **unit**, **integration**, and **e2e** tests.

---

### General rules for FAST unit tests

#### 1. No real I/O or infrastructure

- **Never** hit:
  - Real HTTP endpoints
  - Real databases (e.g., Prisma, Mongo, Postgres)
  - Redis, queues, 3rd-party APIs (Stripe, SendGrid, etc.)
- Instead:
  - Mock `fetch`, Axios, or any HTTP client.
  - Mock Prisma / DB client modules.
  - Use simple in-memory fakes or jest.fn()/vi.fn().

If a test clearly exercises real infrastructure or many layers of the app, **reclassify it as integration/e2e** and move it to a slower test suite (e.g., `tests/integration` or `e2e`).

---

#### 2. Components and hooks

- Use **React Testing Library** for components.
- Render components with **minimal props and context** required.
- Avoid full app shells or layouts unless they are the unit under test.
- Do **not** spin up the Next.js dev server or test via a browser for unit tests.
- Avoid unnecessary re-renders, large fixtures, and deep trees; stub heavy child components if they’re not the focus.

For custom hooks:

- Test them via a simple hook test harness (e.g., RTL’s `renderHook`) instead of mounting full components unless necessary.

---

#### 3. Routing (App Router & Pages Router)

- **Never** rely on real routing behavior in unit tests.
- For the **Pages Router**, mock `next/router` or use `next-router-mock`.
- For the **App Router**, mock `next/navigation`:
  - `useRouter`, `useSearchParams`, `usePathname`, `redirect`, `notFound`, etc.
- Ensure routing mocks are **cheap and deterministic**:
  - No actual navigation
  - No timers
  - No global state coupling

---

#### 4. Data fetching & server logic

For:

- `getServerSideProps`
- `getStaticProps`
- API routes in `pages/api`
- Route handlers in `app/api`
- Server actions

Do **not** make real HTTP requests:

- Call these functions directly with **mocked context/request/params**.
- Mock out any DB clients, fetch calls, or external SDKs they use.
- Keep the input and output small and focused on the logic under test.

---

#### 5. Kill sleeps, timers, and flakiness

- Remove `setTimeout`, `setInterval`, `sleep`, and arbitrary delays from tests.
- Use:
  - Fake timers (e.g., `jest.useFakeTimers()` / `vi.useFakeTimers()`)
  - RTL async utilities (`findBy*`, `waitFor`) with minimal waits
- No polling on real time; use deterministic triggers (state changes, promises resolving, etc.).

---

#### 6. Parallel-friendly and isolated

- Ensure tests can run **in parallel**:
  - No shared mutable globals
  - No reliance on test order
  - No “singleton” state that leaks between tests
- If global config is needed (e.g., Next.js env, global mocks), put it in a **test setup file** that initializes once and is read-only at runtime.

---

#### 7. Data size and fixtures

- Shrink large JSON fixtures, lists, and payloads to **smallest possible** that still covers behavior.
- Remove fuzzing / randomization from normal unit tests. If needed, move fuzz tests to a separate, explicitly slow suite.

---

### Structure & classification

- **Unit tests:** pure logic, components, hooks, and server functions with everything external mocked. Target runtime: **\< 100 ms per test**, total unit suite in **seconds**.
- **Integration tests:** multiple layers together (component + real context/router + real data fetching), but still mocked external services; keep them in a separate folder/tag (e.g., `tests/integration`, `@integration`).
- **E2E tests:** real browser/server (Playwright/Cypress/etc.) go to `e2e/` or equivalent.

When you find tests that don’t meet unit-test criteria:

1. Either refactor them to be true unit tests (mock external dependencies), or  
2. Move them to integration/e2e folders and mark them as such.

---

### Output format

For each file you refactor:

1. **Before**: show the original test code (trimmed to relevant parts if huge).
2. **After**: show the refactored, fast unit test code.
3. **Notes** (short):
   - Why the original tests were slow or flaky.
   - What you changed to make them fast.
   - Whether any tests were moved to integration/e2e and why.

Apply these rules consistently to *all* provided Next.js test files.

---

Use this exactly as-is and splice in your real test runner and folder names where I left placeholders.


**Topic:** [[chatgpt-clusters/code_review]]
