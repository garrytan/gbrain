---
name: edge-to-edge
description: Use this skill to migrate your Jetpack Compose app to add adaptive edge-to-edge
  support and troubleshoot common issues. Use this skill to fix UI components (like
  buttons or lists) that are obscured by or overlapping with the navigation bar or
  status bar, fix IME insets, and fix system bar legibility.
license: Complete terms in LICENSE.txt
metadata:
  author: Google LLC
  last-updated: '2026-04-01'
  keywords:
  - android
  - compose
  - system bars
  - edge-to-edge
  - status bar
  - navigation bar
triggers:
  - android
  - jetpack
  - compose
---

## Prerequisites

- Project **MUST** use Android Jetpack Compose.
- Project **MUST** target SDK 35 or later. If the SDK is lower than 35, increase the SDK to 35.

## Step 1: plan

1. Locate and analyze all Activity classes to detect which have existing edge-to-edge support. For every Activity without edge-to-edge, plan to make each Activity edge-to-edge.
2. In each Activity, Locate and analyze all lists and FAB components to detect which have existing edge-to-edge support. For every component without edge-to-edge support, plan to make each of these components edge-to-edge.
3. In each Activity, scan for `TextField`, `OutlinedTextField`, or `BasicTextField`. If found, then you **MUST** verify the IME doesn't hide the input field by following the IME section of this skill.

## Step 2: add edge-to-edge support

1. Add `enableEdgeToEdge` before `setContent` in `onCreate` in each Activity that does not already call `enableEdgeToEdge`.
2. Add `android:windowSoftInputMode="adjustResize"` in the AndroidManifest.xml for all Activities that use a soft keyboard.

## Step 3: apply insets

- The app **MUST** apply system insets, or align content to rulers, so critical
  UI remains tappable. Choose only one method to avoid double padding:

  1. **PREFERRED:** When available, use `Scaffold`s and pass `PaddingValues` to the content lambda.


  ```kotlin
  Scaffold { innerPadding ->
      // innerPadding accounts for system bars and any Scaffold components
      LazyColumn(
          modifier = Modifier
              .fillMaxSize()
              .consumeWindowInsets(innerPadding),
          contentPadding = innerPadding
      ) { /* Content */ }
  }
  ```

  <br />

  1. **PREFERRED:** When available, use the automatic inset handling or padding modifiers in material components.

     - Material 3 Components manages safe areas for its own components, including:
       - `TopAppBar`
       - `SmallTopAppBar`
       - `CenterAlignedTopAppBar`
       - `MediumTopAppBar`
       - `LargeTopAppBar`
       - `BottomAppBar`
       - `ModalDrawerSheet`
       - `DismissibleDrawerSheet`
       - `PermanentDrawerSheet`
       - `ModalBottomSheet`
       - `NavigationBar`
       - `NavigationRail`
     - For Material 2 Components, use the `windowInsets`parameter to apply insets manually for `BottomAppBar`, `TopAppBar` and `BottomNavigation`. **DO NOT** apply padding to the parent container; instead, pass insets directly to the App Bar component. Applying padding to the parent container prevents the App Bar background from drawing into the system bar area. For example, for `TopAppBar`, choose only one of the following options:
       1. **PREFERRED:** `TopAppBar(windowInsets = AppBarDefaults.topAppBarWindowInsets)`
       2. `TopAppBar(windowInsets = WindowInsets.systemBars.exclude(WindowInsets.navigationBars))`
       3. `TopAppBar(windowInsets = WindowInsets.systemBars.add(WindowInsets.captionBar))`
  2. For components outside a Scaffold, use padding modifiers, such as `Modifier.safeDrawingPadding()` or `Modifier.windowInsetsPadding(WindowInsets.safeDrawing)`.


     ```kotlin
     Box(
         modifier = Modifier
             .fillMaxSize()
             .safeDrawingPadding()
     ) {
         Button(
             onClick = {},
             modifier = Modifier.align(Alignment.BottomCenter)
         ) {
             Text("Login")
         }
     }
     ```

     <br />

  3. For deeply nested components with excessive padding, use `WindowInsetsRulers` (e.g. `Modifier.fitInside(WindowInsetsRulers.SafeDrawing.current)`). See the *IME* section for a code sample.

  4. When you need an element (e.g. a custom header or decorative scrim) to
     equal the dimensions of a system bar, use inset size modifiers (e.g.
     `Modifier.windowInsetsTopHeight(WindowInsets.systemBars)`).
     See the *Lists* section for a code sample.

## Adaptive Scaffolds

- `NavigationSuiteScaffold` manages safe areas for its own components, like the `NavigationRail` or `NavigationBar`. However, the adaptive scaffolds (e.g. `NavigationSuiteScaffold`, `ListDetailPaneScaffold`) don't propagate PaddingValues to their inner contents. You **MUST** apply insets to **individual** screens or components (e.g., list `contentPadding` or FAB padding) as described in *Step 3* . **DO NOT** apply `safeDrawingPadding` or similar modifiers to the `NavigationSuiteScaffold` parent. This clips and prevents an edge-to-edge screen.

## IME

- For each Activity with a soft keyboard, check that `android:windowSoftInputMode="adjustResize"` is set in the AndroidManifest.xml. DO NOT use `SOFT_INPUT_ADJUST_RESIZE` because it is deprecated. Then, maintain focus on the input field. Choose one:
  - 1. **PREFERRED:** Add `Modifier.fitInside(WindowInsetsRulers.Ime.current)` to the content container. This is preferred over `imePadding()` because it reduces jank and extra padding caused by forgetting to consume insets upstream in the hierarchy.
  - 2. Add `imePadding` to the content container. The padding modifier **MUST** be placed before `Modifier.verticalScroll()`. Do NOT use `Modifier.imePadding()` if the parent already accounts for the IME with `contentWindowInsets` (e.g. `contentWindowInsets =
    WindowInsets.safeDrawing`). Doing so will cause double padding.

### IMEs with Scaffolds code patterns

#### RIGHT

RIGHT because `contentWindowInsets` contains IME insets, which are passed to the
content lambda as `innerPadding`.


```kotlin
// RIGHT
Scaffold(contentWindowInsets = WindowInsets.safeDrawing) { innerPadding ->
    Column(
        modifier = Modifier
            .padding(innerPadding)
            .consumeWindowInsets(innerPadding)
            .verticalScroll(rememberScrollState())
    ) { /* Content */ }
}
```

<br />

*** ** * ** ***

RIGHT because `fitInside` fits the content to the IME insets regardless of
`contentWindowInsets`.


```kotlin
// RIGHT
Scaffold() { innerPadding ->
    Column(
        modifier = Modifier
            .padding(innerPadding)
            .consumeWindowInsets(innerPadding)
            .fitInside(WindowInsetsRulers.Ime.current)
            .verticalScroll(rememberScrollState())
    ) { /* Content */ }
}
```

<br />

*** ** * ** ***

RIGHT because the default `contentWindowInsets` does not contain IME insets, and
`imePadding()` applies IME insets:


```kotlin
// RIGHT
Scaffold() { innerPadding ->
    Column(
        modifier = Modifier
            .padding(innerPadding)
            .consumeWindowInsets(innerPadding)
            .imePadding()
            .verticalScroll(rememberScrollState())
    ) { /* Content */ }
}
```

<br />

#### WRONG

WRONG because there will be excess padding when the IME opens. IME insets are
applied twice, once with innerPadding, which contains IME insets from the passed
`contentWindowInsets` values, and once with `imePadding`:


```kotlin
// WRONG
Scaffold( contentWindowInsets = WindowInsets.safeDrawing ) { innerPadding ->
    Column(
        modifier = Modifier
            .padding(innerPadding)
            .imePadding()
            .verticalScroll(rememberScrollState())
    ) { /* Content */ }
}
```

<br />

*** ** * ** ***

WRONG because the IME will cover up the content. Scaffold's default
`contentWindowInsets` does NOT contain IME insets.


```kotlin
// WRONG
Scaffold() { innerPadding ->
    Column(
        modifier = Modifier
            .padding(innerPadding)
            .verticalScroll(rememberScrollState())
    ) { /* Content */ }
}
```

<br />

### IMEs without Scaffolds code patterns

#### RIGHT

The following code samples WILL NOT cause excessive padding.


```kotlin
// RIGHT
Box(
    // Insets consumed
    modifier = Modifier.safeDrawingPadding() // or imePadding(), safeContentPadding(), safeGesturesPadding()
) {
    Column(
        modifier = Modifier.imePadding()
    ) { /* Content */ }
}
```

<br />

*** ** * ** ***


```kotlin
// RIGHT
Box(
    // Insets consumed
    modifier = Modifier.windowInsetsPadding(WindowInsets.safeDrawing) // or WindowInsets.ime, WindowInsets.safeContent, WindowInsets.safeGestures
) {
    Column(
        modifier = Modifier.imePadding()
    ) { /* Content */ }
}
```

<br />

*** ** * ** ***


```kotlin
// RIGHT
Box(
    // Insets not consumed, but irrelevant due to fitInside
    modifier = Modifier.padding(WindowInsets.safeDrawing.asPaddingValues()) // or WindowInsets.ime.asPaddingValues(), WindowInsets.safeContent.asPaddingValues(), WindowInsets.safeGestures.asPaddingValues()
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .fitInside(WindowInsetsRulers.Ime.current)
    ) { /* Content */ }
}
```

<br />

#### WRONG

The following code sample WILL cause excessive padding because IME insets are
applied twice:


```kotlin
// WRONG
Box(
    // Insets not consumed
    modifier = Modifier.padding(WindowInsets.safeDrawing.asPaddingValues()) // or WindowInsets.ime.asPaddingValues(), WindowInsets.safeContent.asPaddingValues(), WindowInsets.safeGestures.asPaddingValues()
) {
    Column(
        modifier = Modifier.imePadding()
    ) { /* Content */ }
}
```

<br />

## Navigation Bar Contrast \& System Bar Icons

- If the Activity uses `enableEdgeToEdge` from `WindowCompat`, you **MUST** set
  `isAppearanceLightNavigationBars` and `isAppearanceLightStatusBars` to the
  inverse of the device theme for apps that support light and dark theme so the
  system bar icons are legible. It's recommended to do this in your theme file.
  DO NOT do this if the Activities use `enableEdgeToEdge` from `ComponentActivity`
  because it handles the icon colors automatically.


  ```kotlin
  // Only use if calling `enableEdgeToEdge` from `WindowCompat`.
  // Apply to your theme file.
  @Composable
  fun MyTheme(
      darkTheme: Boolean = isSystemInDarkTheme(),
      content: @Composable () -> Unit
  ) {
      val view = LocalView.current
      if (!view.isInEditMode) {
          SideEffect {
              val window = (view.context as? Activity)?.window ?: return@SideEffect
              val controller = WindowCompat.getInsetsController(window, view)

              // Dark icons for Light Mode (!darkTheme), Light icons for Dark Mode
              controller.isAppearanceLightStatusBars = !darkTheme
              controller.isAppearanceLightNavigationBars = !darkTheme
          }
      }

      MaterialTheme(content = content)
  }
  ```

  <br />

- If any screen uses a `Scaffold` or a `NavigationSuiteScaffold` with a bottom
  bar (e.g., `BottomAppBar`, `NavigationBar`), set
  `window.isNavigationBarContrastEnforced = false` in the corresponding Activity
  for SDK 29+. This prevents the system from adding a translucent background to
  the navigation bar, verifying your bottom bar colors extend to the bottom of the
  screen.

## Lists

- Apply inset padding (like `Scaffold`'s `innerPadding`) to the `contentPadding` parameter of scrollable components (e.g. `LazyColumn`, `LazyRow`). DO NOT apply it as a `Modifier.padding()` to the list's parent container, as this clips the content and prevents it from scrolling behind the system bars.
- Create a translucent composable covering the system bar so that the icons are still legible.


```kotlin
class SystemBarProtectionSnippets : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // enableEdgeToEdge sets window.isNavigationBarContrastEnforced = true
        // which is used to add a translucent scrim to three-button navigation
        enableEdgeToEdge()

        setContent {
            MyTheme {
                // Main content
                MyContent()

                // After drawing main content, draw status bar protection
                StatusBarProtection()
            }
        }
    }
}

@Composable
private fun StatusBarProtection(
    color: Color = MaterialTheme.colorScheme.surfaceContainer,
) {
    Spacer(
        modifier = Modifier
            .fillMaxWidth()
            .height(
                with(LocalDensity.current) {
                    (WindowInsets.statusBars.getTop(this) * 1.2f).toDp()
                }
            )
            .background(
                brush = Brush.verticalGradient(
                    colors = listOf(
                        color.copy(alpha = 1f),
                        color.copy(alpha = 0.8f),
                        Color.Transparent
                    )
                )
            )
    )
}
```

<br />

## Dialogs

If both the following conditions are true, then the Dialog is full screen and
must be made edge-to-edge:
1. The `DialogProperties` contains `usePlatformDefaultWidth = false`.
2. The Dialog calls `Modifier.fillMaxSize()`.

To make a full screen Dialog edge-to-edge, set `decorFitsSystemWindows = false`
in the `DialogProperties`.


```kotlin
Dialog(
    onDismissRequest = { /* Handle dismiss */ },
    properties = DialogProperties(
        // 1. Allows the dialog to span the full width of the screen
        usePlatformDefaultWidth = false,
        // 2. Allows the dialog to draw behind status and navigation bars
        decorFitsSystemWindows = false
    )
) { /* Content */ }
```

<br />

## Checklist

- \[ \] Does every `Activity` call `enableEdgeToEdge()`?
- \[ \] Is `adjustResize` set in the `AndroidManifest.xml`?
- \[ \] Does every `TextField`, `OutlinedTextField`, or `BasicTextField` have a parent with `imePadding()`, `fitInside`, `Modifier.safeDrawingPadding()`, `Modifier.safeContentPadding()`, `Modifier.safeGesturesPadding()`, or `contentWindowInsets` set to `WindowInsets.safeDrawing` or `WindowInsets.ime`?
- \[\] Does the first and last list item draw away from the system bars by passing insets to `contentPadding`?
- \[\] Do FABs draw above the navigation bars by either being inside a Scaffold or by applying `Modifier.safeDrawingPadding()`?
- \[\] Does the project build? Run `./gradlew build` to be sure.

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
