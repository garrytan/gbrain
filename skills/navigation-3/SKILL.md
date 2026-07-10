---
name: navigation-3
description: Learn how to install and migrate to Jetpack Navigation 3, and how to
  implement features and patterns such as deep links, multiple backstacks, scenes
  (dialogs, bottom sheets, list-detail, two-pane, supporting pane), conditional navigation
  (such as logged-in navigation versus anonymous), returning results from flows, integration
  with Hilt, ViewModel, Kotlin, and view interoperability.
license: Complete terms in LICENSE.txt
metadata:
  author: Google LLC
  last-updated: '2026-07-02'
  keywords:
  - recipe
  - Android
  - Navigation 2
  - Navigation 3
  - migration
  - Compose
  - guide
  - dependencies
  - NavKey
  - NavHost
  - NavDisplay
  - BottomSheet
  - list-detail
  - scenes
  - two-pane
  - supporting pane
  - multiple backstacks
  - dialog
  - Hilt
  - ViewModel
  - View interop.
triggers:
  - android
  - jetpack
  - compose
---

*** ** * ** ***

## Migration guide

- *[Navigation 2 to Navigation 3 migration guide](references/android/guide/navigation/navigation-3/migration-guide.md)*: Step-by-step guide to migrate an Android application from Navigation 2 to Navigation 3, covering dependency updates, route changes, state management, and UI component replacements.

### Requirements

- *[Guide: Migrate to type-safe navigation in Compose](references/android/guide/navigation/type-safe-destinations.md)* : Step-by-step guide to migrating an Android application from string-based navigation to **Type-Safe Navigation** in Jetpack Compose using Jetpack Navigation 2.

## Developer documentation

- *[Navigation 3](references/android/guide/navigation/navigation-3/index.md)*. Search documentation for more information on basics, saving and managing navigation state, modularizing navigation code, creating custom layouts using Scenes, animating between destinations, or applying logic or wrappers to destinations.

## Recipes

Code examples showcasing common patterns.

### Basic API usage

- *[Basic](references/android/guide/navigation/navigation-3/recipes/basic.md)*: Shows most basic API usage.
- *[Saveable back stack](references/android/guide/navigation/navigation-3/recipes/basicsaveable.md)*: Shows basic API usage with a persistent back stack.
- *[Entry provider DSL](references/android/guide/navigation/navigation-3/recipes/basicdsl.md)*: Shows basic API usage using the entryProvider DSL.

### Common UI

- *[Common UI](references/android/guide/navigation/navigation-3/recipes/common-ui.md)*: Demonstrates how to implement a common navigation UI pattern with a bottom navigation bar and multiple back stacks, where each tab in the navigation bar has its own navigation history.

### Deep links

- *[Basic](references/android/guide/navigation/navigation-3/recipes/deeplinks-basic.md)*: Shows how to parse a deep link URL from an Android Intent into a navigation key.
- *[Advanced](references/android/guide/navigation/navigation-3/recipes/deeplinks-advanced.md)*: Shows how to handle deep links with a synthetic back stack and correct "Up" navigation behavior.

### Scenes

#### Use built-in Scenes

- *[Dialog](references/android/guide/navigation/navigation-3/recipes/dialog.md)*: Shows how to create a Dialog.

#### Create custom Scenes

- *[BottomSheet](references/android/guide/navigation/navigation-3/recipes/bottomsheet.md)*: Shows how to create a BottomSheet destination.
- *[List-Detail Scene](references/android/guide/navigation/navigation-3/recipes/scenes-listdetail.md)*: Demonstrates how to implement adaptive list-detail layouts using the Navigation 3 Scenes API.
- *[Two pane Scene](references/android/guide/navigation/navigation-3/recipes/scenes-twopane.md)*: Demonstrates how to implement adaptive two-pane layouts using the Navigation 3 Scenes API.

### Material Adaptive

- *[Material List-Detail](references/android/guide/navigation/navigation-3/recipes/material-listdetail.md)*: Demonstrates how to implement an adaptive list-detail layout using Material 3 Adaptive.
- *[Material Supporting Pane](references/android/guide/navigation/navigation-3/recipes/material-supportingpane.md)*: Demonstrates how to implement an adaptive supporting pane layout using Material 3 Adaptive.

### Animations

- *[Animations](references/android/guide/navigation/navigation-3/recipes/animations.md)*: Shows how to override the default animations for all destinations and a single destination.

### Common back stack behavior

- *[Multiple back stacks](references/android/guide/navigation/navigation-3/recipes/multiple-backstacks.md)*: Shows how to create multiple top level routes, each with its own back stack. Top level routes are displayed in a navigation bar allowing users to switch between them. State is retained for each top level route, and the navigation state persists config changes and process death.

### Conditional navigation

- *[Conditional navigation](references/android/guide/navigation/navigation-3/recipes/conditional.md)*: Switch to a different navigation flow when a condition is met. For example, for authentication or first-time user onboarding.

### Architecture

- *[Modularized navigation code (Hilt)](references/android/guide/navigation/navigation-3/recipes/modular-hilt.md)*: Demonstrates how to decouple navigation code into separate modules using Hilt or Dagger for DI.
- *[Modularized navigation code (Koin)](references/android/guide/navigation/navigation-3/recipes/modular-koin.md)*: Demonstrates how to decouple navigation code into separate modules using Koin for DI.

### Working with ViewModel

#### Passing navigation arguments

- *[Basic ViewModel](references/android/guide/navigation/navigation-3/recipes/passingarguments.md)* : Navigation arguments are passed to a `ViewModel` constructed using `viewModel()`

### Returning results

- *[Returning Results as Events](references/android/guide/navigation/navigation-3/recipes/results-event.md)* : Returning results as events to content in another `NavEntry`
- *[Returning Results as State](references/android/guide/navigation/navigation-3/recipes/results-state.md)* : Returning results as state stored in a `CompositionLocal`

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
