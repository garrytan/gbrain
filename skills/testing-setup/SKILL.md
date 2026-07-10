---
name: testing-setup
description: Analyze and create a testing strategy for native Android apps - install
  testing libraries, set up test infrastructure, create harnesses for unit tests,
  UI tests, screenshot tests, and end-to-end tests.
license: Complete terms in LICENSE.txt
metadata:
  author: Google LLC
  last-updated: '2026-06-25'
  keywords:
  - android
  - testing
  - ui tests
  - screenshot tests
  - coverage
triggers:
  - android
  - jetpack
  - compose
---

## Step 1: analyze the current testing setup

To understand the testing setup of an existing project, look for these
dependencies in the libs.versions.toml file, or build files:

1. Dependency Injection framework used. Examples: Hilt, Koin, Anvil, vanilla Dagger...
2. Unit (local) testing framework this project uses, Example JUnit4, JUnit5...
3. Mocking framework (if any) used for unit tests, and for Instrumented and UI tests. Examples: Mockito, Mockk...
4. Robolectric. It can be used in 3 ways:
   1. Used in unit tests to have fakes for platform entities
   2. To run behavior UI tests without a device or emulator. For example, used to run Espresso or Compose tests.
   3. To do screenshot testing with Roborazzi
5. Is the app 100% Compose, Views or hybrid?
6. Behavior UI tests:
   1. Compose Tests (`androidx.compose.ui:ui-test-*`)
   2. Espresso Tests for Views. Might use wrappers like Kaspresso. Dependencies: `androidx.test.espresso:espresso-core`, `androidx.test:runner`, `androidx.test:rules`.
7. Screenshot tests can be:
   1. Instrumented (device-based). For example, using Dropshots.
   2. Based on Robolectric, so they run locally. For example, using Roborazzi.
   3. Based on LayoutLib, so they run locally. For example, Paparazzi, or the Compose Preview Screenshot Testing tool.
8. End to end tests (also known as Release Candidate tests) always run on device and use high-level frameworks such as UIAutomator, Appium, or Robotium.
9. Generate a Markdown report with the analysis

## Step 2: Set up Dependency Injection frameworks for testing

If there is no Dependency Injection framework, install one: if it's a
multiplatform application, ask the user whether they want to install Koin, or
kotlin-inject. If it's not multiplatform, install Hilt.

Install the testing dependencies (for example `com.google.dagger:hilt-compiler`
that should be applied with a `kspAndroidTest` configuration).

> [!IMPORTANT]
> **Important:** Always consult the documentation of the applicable framework to learn about testing (for example: [Hilt testing guide](references/android/training/dependency-injection/hilt-testing.md), [Koin Instrumented tests](https://insert-koin.io/docs/reference/koin-android/instrumented-testing)).

For instrumented tests, create and configure (by adding
`testInstrumentationRunner` to the build gradle files) a new test runner and
apply the testing rules required by the framework (for example in Hilt, annotate
your test classes with `@HiltAndroidTest` and apply the `HiltAndroidRule`).
Other frameworks use other mechanisms, consult their documentation.

## Step 3: Install frameworks

Unless otherwise specified, respect the current stack of testing frameworks.

If there are no testing frameworks, and the user didn't specify any preference,
install the following:

- JUnit4 for local and instrumented tests
- Jacoco for test coverage
- For UI tests: if the project has views, Espresso. If it's fully Compose, use the Compose Testing APIs.
- Robolectric to run UI Tests
- Compose Preview Screenshot Testing tool for screenshot tests - check [setup
  documentation](references/android/studio/preview/compose-screenshot-testing.md) and follow it strictly.
- Dropshots for device screenshot tests
- If a mocking framework is necessary, install Mockk (`io.mockk:mockk`). Do not install it unless it is clearly necessary.

If instrumented screenshot tests are requested, install Dropshots.

If end-to-end testing is requested, install UI Automator.

## Step 4: Refactor and create fakes for testing

### **Refactor for unit tests**

In the next sections you'll be asked to create tests. If you have dependencies
on Android framework classes, or entities that are not part of the codebase:

- First, use a fake. If it doesn't exist, create an interface for the class
  and a "Default" implementation with the existing code. Add the Fake version
  to the test sourceset (test or androidTest).

- If not possible to use a fake (example: no access to the class or
  interface), mock the dependencies.

### **Refactor for UI tests**

If you need to fake components to make testing easier and faster and more
reliable, replace slow and problematic dependencies with fakes. Use runtime
fakes using the Dependency Injection framework installed to:

- **Simulate** different scenarios with the user (wrong credentials, reset password flow...), with a server (no connection, server down, bad JSON from server...) or with a platform component (insufficient permissions, no disk space, no front camera available)
- **Improve** speed and reliability (replacing a database with an in-memory database, replacing a repository with an in-memory fake to avoid hitting the network)

## Step 5: Unit testing

Create a task to add or review unit tests in every file that contains business
logic (ViewModels, Repositories, database-related classes such as DAOs, etc.).
Don't create unit tests for Activities, Compose layouts, or dependency injection
configuration files.

## Step 6: UI testing

Espresso or Compose UI tests live in the `test` sourceset because they will be
run with Robolectric. If instrumented (emulator or device) tests are requested,
put them in the `androidTest` sourceset.

## Step 7: Test databases

If the database is using SQLite (using Room, SQLDelight, etc.), create
instrumented tests using an in-memory database to make sure that they work with
the SQLite engine on device.

## Step 8: Screenshot tests

Irrespective of the framework used, screenshot tests focus on 2 types of tests:

- Screen-level screenshot tests, where each screen is tested in 9 different sizes, combining compact, medium and expanded widths (400, 610, 900 dp) and heights (400, 500 and 1000 dp).
- Screen-level variations. Add a mobile (400x500) screenshot of:
  - All the alternative themes, if used.
  - Font scale set to 1.5.
- Component-level screenshot tests, where each component is tested in different themes and font scales.

Behavior isn't tested with screenshots, but do test different common scenarios
if their UIs change a lot depending on the state. For example, test loading
screens by injecting a loading state to the UI or simulating it with a fake.

## Step 9: UI Behavior tests

Test the UI logic using behavior tests, which ensures that the UIs react as
expected when different states are passed, and when user actions are performed.

### **Compose UI behavior tests**

- Use the ComposeTestRule with a `ComponentActivity` to access resources such as strings.
- Always try to match with semantic matchers first. If the matcher is too complicated to write (using more than 3 matchers to find a single element), use `testTag`.
- Always verify state restoration

### **Views (XML) UI behavior tests**

Use Espresso to match views and interact with them.

## Step 10: Navigation tests

Create a test suite to verify navigation logic. Include:

- Back handling
- Deeplinks
- Special patterns like "exit through home" with multiple backstacks.

## Step 11: Simulate different window sizes and settings

For Compose layouts, use `DeviceConfigurationOverride` described in "[UI testing
common patterns](references/android/develop/ui/compose/testing/common-patterns.md)" to simulate different window sizes, font scales

## Step 12: End-to-end tests

Create a low number (about 5% of all tests) of end-to-end tests that cover big
user journeys. Use Compose Test APIs or Espresso for that. If you have to access
platform features (notifications, system UI...), use UI Automator.

If you need to take screenshots of the app running in a device, use
[Dropshots](https://raw.githubusercontent.com/dropbox/dropshots/refs/heads/main/README.md). You need a device for screenshot tests when verifying
interaction with the system UI (examples: edge-to-edge rendering, notifications,
picture-in-picture)

### Step 13: Instrumented Screenshot tests

Install the `com.dropbox.dropshots` plugin in the module and a `Dropshots()`
JUnit Rule. Create a new instrumented screenshot test for one of the app's
features.

### Step 14: Install jacoco

Install jacoco for local testing code coverage.

- Add the `jacoco` plugin to each module that contains tests.

## Final touches

- Ask whether to document the findings of the analysis and the changes applied
  to the testing strategy. If the user agrees:

  - If there is an AGENTS.md file present in the project, update it with any
    changes you've made to the testing strategy.

  - If there is no AGENTS.md file, create a new file (docs/testing.md) with
    a description of the testing strategy, including the commands needed to
    run every type of test, where the screenshot reference files live, etc.
    Also create a new AGENTS.md file in the root and create a link to
    docs/testing.md.

## Contract
- Inputs: Android project context and the skill's target surface (Compose, Play, profiling, security, etc.).
- Outputs: concrete, API-accurate Android guidance and code that matches official Android docs for the skill topic.
- Failure modes: outdated AGP/API assumptions, inventing SDK APIs, or applying mobile guidance to non-Android targets.

## Output Format
1. State the target Android surface and constraints.
2. Provide the minimal correct implementation or migration steps.
3. Call out version requirements, common pitfalls, and verification.

## Anti-Patterns
- Do not invent Jetpack/Play/Compose APIs or dependency coordinates.
- Do not hardcode secrets, signing keys, or production package names from examples into real apps.
- Do not skip version/AGP compatibility checks.
- Do not treat sample emails or demo identities as real credentials.
