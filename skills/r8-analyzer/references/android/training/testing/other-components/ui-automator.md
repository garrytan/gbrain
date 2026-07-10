The UI Automator testing framework provides a set of APIs to build UI tests that
interact with user apps and system apps.

> [!NOTE]
> **Note:** This documentation covers the modern approach to writing UI Automator tests, introduced with [UI Automator 2.4](https://developer.android.com/jetpack/androidx/releases/test-uiautomator#2.4.0). This approach makes your tests more concise, readable, and robust. The API is under development, and we strongly recommend using it for any new development with UI Automator. The [legacy API guidance](https://developer.android.com/training/testing/other-components/ui-automator-legacy) is also available.

## Introduction to modern UI Automator testing

UI Automator 2.4 introduces a streamlined, Kotlin-friendly Domain Specific
Language (DSL) that simplifies writing UI tests for Android. This new API
surface focuses on predicate-based element finding and explicit control over app
states. Use it to create more maintainable and reliable automated tests.

UI Automator lets you test an app from outside of the app's process. This
lets you test release versions with minification applied. UI Automator also
helps when writing macrobenchmark tests.

Key features of the modern approach include:

- A dedicated `uiAutomator` test scope for cleaner and more expressive test code.
- Methods like `onElement`, `onElements`, and `onElementOrNull` for finding UI elements with clear predicates.
- Built-in waiting mechanism for conditional elements `onElement*(timeoutMs:
  Long = 10000)`
- Explicit app state management such as `waitForStable` and `waitForAppToBeVisible`.
- Direct interaction with accessibility window nodes for multi-window testing scenarios.
- Built-in screenshot capabilities and a `ResultsReporter` for visual testing and debugging.

## Set up your project

To begin using the modern UI Automator APIs, update your project's
`build.gradle.kts` file to include the [latest dependency](https://developer.android.com/jetpack/androidx/releases/test-uiautomator#2.4.0):

### Kotlin

    dependencies {
      ...
      androidTestImplementation("androidx.test.uiautomator:uiautomator:2.4.0-alpha05")
    }

### Groovy

    dependencies {
      ...
      androidTestImplementation "androidx.test.uiautomator:uiautomator:2.4.0-alpha05"
    }

## Core API concepts

The following sections describe core concepts of the modern UI Automator API.

### The uiAutomator test scope

Access all new UI Automator APIs within the **`uiAutomator { ... }`**
block. This function creates a `UiAutomatorTestScope` that provides a concise
and type-safe environment for your test operations.

    uiAutomator {
      // All your UI Automator actions go here
      startApp("com.example.targetapp")
      onElement { textAsString() == "Hello, World!" }.click()
    }

### Find UI elements

Use UI Automator APIs with predicates to locate UI elements. These predicates
let you define conditions for properties such as text, selected or focused
state, and content description.

- `onElement { predicate }`: Returns the first UI element that matches the
  predicate within a default timeout. The function throws an exception if it
  doesn't locate a matching element.

      // Find a button with the text "Submit" and click it
      onElement { textAsString() == "Submit" }.click()

      // Find a UI element by its resource ID
      onElement { viewIdResourceName == "my_button_id" }.click()

      // Allow a permission request
      watchFor(PermissionDialog) {
        clickAllow()
      }

- `onElementOrNull { predicate }`: Similar to `onElement`, but returns
  `null` if the function finds no matching element within the timeout. It
  doesn't throw an exception. Use this method for optional elements.

      val optionalButton = onElementOrNull { textAsString() == "Skip" }
      optionalButton?.click() // Click only if the button exists

- `onElements { predicate }`: Waits until at least one UI element matches
  the given predicate, then returns a list of all matching UI elements.

      // Get all items in a list Ui element
      val listItems = onElements { className == "android.widget.TextView" && isClickable }
      listItems.forEach { it.click() }

Here are some tips for using `onElement` calls:

- Chain `onElement` calls for nested elements: You can chain `onElement`
  calls to find elements within other elements, following a parent-child
  hierarchy.

      // Find a parent Ui element with ID "first", then its child with ID "second",
      // then its grandchild with ID "third", and click it.
      onElement { viewIdResourceName == "first" }
        .onElement { viewIdResourceName == "second" }
        .onElement { viewIdResourceName == "third" }
        .click()

- Specify a timeout for `onElement*` functions by passing a value representing
  milliseconds.

      // Find a Ui element with a zero timeout (instant check)
      onElement(0) { viewIdResourceName == "something" }.click()

      // Find a Ui element with a custom timeout of 10 seconds
      onElement(10_000) { textAsString() == "Long loading text" }.click()

### Interact with UI elements

Interact with UI elements by simulating clicks or setting text in editable
fields.

    // Click a Ui element
    onElement { textAsString() == "Tap Me" }.click()

    // Set text in an editable field
    onElement { className == "android.widget.EditText" }.setText("My input text")

    // Perform a long click
    onElement { contentDescription == "Context Menu" }.longClick()

## Handle app states and watchers

Manage the lifecycle of your app and handle unexpected UI elements that might
appear during your tests.

### App lifecycle management

The APIs provide ways to control the state of the app under test:

    // Start a specific app by package name. Used for benchmarking and other
    // self-instrumenting tests.
    startApp("com.example.targetapp")

    // Start a specific activity within the target app
    startActivity(SomeActivity::class.java)

    // Start an intent
    startIntent(myIntent)

    // Clear the app's data (resets it to a fresh state)
    clearAppData("com.example.targetapp")

### Handle unexpected UI

The `watchFor` API lets you define handlers for unexpected UI elements,
such as permission dialogs, that might appear during your test flow. This
uses the internal watcher mechanism but offers more flexibility.

    import androidx.test.uiautomator.PermissionDialog

    @Test
    fun myTestWithPermissionHandling() = uiAutomator {
      startActivity(MainActivity::class.java)

      // Register a watcher to click "Allow" if a permission dialog appears
      watchFor(PermissionDialog) { clickAllow() }

      // Your test steps that might trigger a permission dialog
      onElement { textAsString() == "Request Permissions" }.click()

      // Example: You can register a different watcher later if needed
      clearAppData("com.example.targetapp")

      // Now deny permissions
      startApp("com.example.targetapp")
      watchFor(PermissionDialog) { clickDeny() }
      onElement { textAsString() == "Request Permissions" }.click()
    }

`PermissionDialog` is an example of a `ScopedWatcher<T>`, where `T` is the
object passed as a scope to the block in `watchFor`. You can create custom
watchers based on this pattern.

### Wait for app visibility and stability

Sometimes tests need to wait for elements to become visible or stable.
UI Automator offers several APIs to help with this.

The `waitForAppToBeVisible("com.example.targetapp")` waits for a UI element with
the given package name to appear on the screen within a customizable timeout.

    // Wait for the app to be visible after launching it
    startApp("com.example.targetapp")
    waitForAppToBeVisible("com.example.targetapp")

Use the `waitForStable()` API to verify that the app's UI is considered stable
before interacting with it.

    // Wait for the entire active window to become stable
    activeWindow().waitForStable()

    // Wait for a specific Ui element to become stable (e.g., after a loading animation)
    onElement { viewIdResourceName == "my_loading_indicator" }.waitForStable()

> [!NOTE]
> **Note:** In most cases, `waitForStable()` isn't strictly necessary when using `onElement { ... }` because `onElement` already includes a timeout. Use `waitForStable()` primarily in combination with `onElements { ... }` to verify that all UI elements are visible, when you know that the UI is in an unstable state, or for specific screenshot testing scenarios where you need the UI to completely settle before capturing. `waitForStable()` works by waiting until no changes are detected in the accessibility tree for a set period. Note that this UI stability check doesn't guarantee that the app is fully idle, as background tasks might still be running.

## Use UI Automator for Macrobenchmarks and Baseline Profiles

Use UI Automator for performance testing with [Jetpack Macrobenchmark](https://developer.android.com/topic/performance/benchmarking/macrobenchmark-overview)
and for generating [Baseline Profiles](https://developer.android.com/topic/performance/baselineprofiles/overview), as it provides a reliable way to
interact with your app and measure performance from an end-user perspective.

Macrobenchmark uses UI Automator APIs to drive the UI and measure interactions.
For example, in startup benchmarks, you can use `onElement` to detect when UI
content is fully loaded, enabling you to measure [Time to Full Display
(TTFD)](https://developer.android.com/topic/performance/vitals/launch-time#time-full). In jank benchmarks, UI Automator APIs are used to scroll lists or
run animations to measure frame timings. Functions like `startActivity()` or
`startIntent()` are useful for getting the app into the correct state before
measurement begins.

When [generating Baseline Profiles](https://developer.android.com/topic/performance/baselineprofiles/create-baselineprofile), you automate your app's critical user
journeys (CUJs) to record which classes and methods require pre-compilation. UI
Automator is an ideal tool for writing these automation scripts. The modern
DSL's predicate-based element finding and built-in wait mechanisms (`onElement`)
lead to more robust and deterministic test execution compared to other methods.
This stability reduces flakiness and ensures that the generated Baseline Profile
accurately reflects the code paths executed during your most important user
flows.

## Advanced features

The following features are useful for more complex testing scenarios.

### Interact with multiple windows

The UI Automator APIs let you directly interact with and inspect UI
elements. This is particularly useful for scenarios involving multiple windows,
such as Picture-in-Picture (PiP) mode or split-screen layouts.

    // Find the first window that is in Picture-in-Picture mode
    val pipWindow = windows()
      .first { it.isInPictureInPictureMode == true }

    // Now you can interact with elements within that specific window
    pipWindow.onElement { textAsString() == "Play" }.click()

### Screenshots and visual assertions

Capture screenshots of the entire screen, specific windows, or
individual UI elements directly within your tests. This is helpful for visual
regression testing and debugging.

    uiautomator {
      // Take a screenshot of the entire active window
      val fullScreenBitmap: Bitmap = activeWindow().takeScreenshot()
      fullScreenBitmap.saveToFile(File("/sdcard/Download/full_screen.png"))

      // Take a screenshot of a specific UI element (e.g., a button)
      val buttonBitmap: Bitmap = onElement { viewIdResourceName == "my_button" }.takeScreenshot()
      buttonBitmap.saveToFile(File("/sdcard/Download/my_button_screenshot.png"))

      // Example: Take a screenshot of a PiP window
      val pipWindowScreenshot = windows()
        .first { it.isInPictureInPictureMode == true }
        .takeScreenshot()
      pipWindowScreenshot.saveToFile(File("/sdcard/Download/pip_screenshot.png"))
    }

The `saveToFile` extension function for Bitmap simplifies saving the captured
image to a specified path.

### Use ResultsReporter for debugging

The `ResultsReporter` helps you associate test artifacts, like screenshots,
directly with your test results in Android Studio for easier inspection and
debugging.

    uiAutomator {
      startApp("com.example.targetapp")

      val reporter = ResultsReporter("MyTestArtifacts") // Name for this set of results
      val file = reporter.addNewFile(
        filename = "my_screenshot",
        title = "Accessible button image" // Title that appears in Android Studio test results
      )

      // Take a screenshot of an element and save it using the reporter
      onElement { textAsString() == "Accessible button" }
        .takeScreenshot()
        .saveToFile(file)

      // Report the artifacts to instrumentation, making them visible in Android Studio
      reporter.reportToInstrumentation()
    }

## Migrate from older UI Automator versions

If you have existing UI Automator tests written with older API surfaces, use the
following table as a reference to migrate to the modern approach:

| Action type | Old UI Automator method | New UI Automator method |
|---|---|---|
| Entry point | `UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())` | Wrap test logic in the `uiAutomator { ... }` scope. |
| Find UI elements | `device.findObject(By.res("com.example.app:id/my_button"))` | `onElement { viewIdResourceName == "my\_button" }` |
| Find UI elements | `device.findObject(By.text("Click Me"))` | `onElement { textAsString() == "Click Me" }` |
| Wait for idle UI | `device.waitForIdle()` | Prefer `onElement`'s built-in timeout mechanism; otherwise, `activeWindow().waitForStable()` |
| Find child elements | Manually nested `findObject` calls | `onElement().onElement()` chaining |
| Handle permission dialogs | `UiAutomator.registerWatcher()` | `watchFor(PermissionDialog)` |