---
name: wear-compose-m3
description: Expert guidance for working with Wear OS Compose Material3. Use this
  skill when creating, updating or migrating Wear OS projects. This includes the androidx.wear.compose.material3,
  androidx.wear.compose.foundation and androidx.wear.compose.navigation3 libraries.
  Also working with core components such as AppScaffold, ScreenScaffold and TransformingLazyColumn.
  Migration from earlier versions such as Material 2.5 and Horologist.
license: Complete terms in LICENSE.txt
metadata:
  author: Google LLC
  last-updated: '2026-07-02'
  keywords:
  - Wear OS
  - Compose
  - Material3
  - Horologist
  - TransformingLazyColumn
  - AppScaffold
  - ScreenScaffold
triggers:
  - android
  - jetpack
  - compose
---

## Prerequisites and compatibility

1. **Wear OS Compose Material3 version:** If an internal tool is available to establish the **latest stable version** `{VERSION}` of `androidx.wear.compose:compose-material3`, use that tool.
   - Otherwise, fetch the [official Maven metadata XML](https://dl.google.com/dl/android/maven2/androidx/wear/compose/compose-material3/maven-metadata.xml) to identify `{VERSION}` (highest number, ignoring `-alpha`, `-beta`, or `-rc`).
2. **Strict compliance:** If a version is listed as stable, you MUST use it, unless overridden by the user. Do not downgrade based on initial "Unresolved reference" errors in the editor or outdated web search results.
3. **Kotlin version:** For Wear Compose Material3, use Kotlin **2.0.0 or
   higher**.
4. **Compose compiler:**
   - If Kotlin version is **2.0.0+** , the project must use the `org.jetbrains.kotlin.plugin.compose` Gradle plugin.
   - If Kotlin version is **\< 2.0.0** , the project must use `kotlinCompilerExtensionVersion` in `composeOptions`, matching the [Compose to Kotlin Compatibility Map](https://developer.android.com/jetpack/androidx/releases/compose-kotlin).
5. **Min SDK:** Ensure `minSdk` is at least **25** (Wear OS 2.0).
6. **Sample extraction mandate**: Wear Compose libraries ship with an additional JAR file which contains individual samples for each and every component. You MUST NOT propose code changes until the samples in Capability 2 are extracted to the local cache. Library source files are incomplete and NOT a substitute for these samples; bypassing extraction is an environment setup failure.

## Gotchas

1. **Mandatory sync and validation:** After updating versions in `libs.versions.toml` or `build.gradle.kts`, you **must** perform a Gradle sync before refactoring any code. This ensures the environment has resolved the libraries correctly.
2. **Prohibition of guessing (error protocol):** If you encounter an 'Unresolved Reference' or API mismatch after a successful sync, do not attempt to 'fix' it by downgrading the library version.

## Capabilities and tools

### Capability 1: Migration

Use this guidance when migrating from an older version of Wear OS Compose or
Horologist.

1. Unless otherwise indicated by the developer, use the latest stable version of Wear Compose Material3 from `{VERSION}`.
2. Read the [migration guide](references/android/training/wearables/compose/migrate-to-material3.md).
3. Use the official component mappings from the migration guide.
4. Before refactoring any component (for example, `Chip` -\> `Button`), check the parameter names, slot types, and "Expressive" design tokens.
5. Do not use the Horologist Composables, Compose Layout, or Compose Material libraries.
6. **Always** check against the component guidance in Capability 3.
7. Expect screenshot tests to fail when a migration has been performed: Even when migrating to very similar components, expected defaults for padding and positioning will have changed. Do not seek to artificially match the pre-migration screenshot, but give preference to the Material3 defaults.

### Capability 2: Component samples

Wear Compose includes individual component samples for each and every component,
within the `<artifact>-<version>-samples-sources.jar` file. Gradle automatically
downloads these JAR files along with the main library JAR when using any of
`compose-material3`, `compose-foundation` or `compose-navigation3`.

Use the canonical component samples whenever adding or adjusting a Wear Compose
Material3 component.

STRICT COMPLIANCE: Extraction is NOT optional. You are FORBIDDEN from
implementing any code until samples are extracted and read. Bypassing this step
with alternative search tools or by assuming library documentation is sufficient
is a protocol breach. You MUST verify the local cache by reading a sample file
before proceeding.

#### Step 1: Prepare

1. Check the `build.gradle.kts` or `libs.versions.toml` to ensure the Wear Compose version matches `{VERSION}`.
2. Ensure that the necessary dependencies are downloaded by doing a Gradle sync.

#### Step 2: Check the local cache

1. Define the cache directory path: `/tmp/wear-compose-samples/{VERSION}/`. Do NOT choose your own different location.
2. Check if this directory exists and contains subdirectories with `.kt` files.
   - **IF YES (cache hit):** Proceed to **Step 4**.
   - **IF NO (cache miss):** Proceed to **Step 3**.

#### Step 3: Network-based sample retrieval

Google Maven publishes a `-samples-sources.jar` alongside every library release.
Download and extract it directly without needing a local Gradle sync or cache
lookup.

1. Determine the `{VERSION}` of `androidx.wear.compose:compose-material3` from `build.gradle.kts` or `libs.versions.toml`.
2. Define `{ARTIFACT}` as the items in the list `["material3", "foundation"]`. Also include `navigation3` if `androidx.wear.compose.navigation3` is used.
3. For each `{ARTIFACT}`, run the following commands to download and extract
   the samples:

       # Download the samples-sources JAR
       curl -sSL "https://dl.google.com/dl/android/maven2/androidx/wear/compose/compose-{ARTIFACT}/{VERSION}/compose-{ARTIFACT}-{VERSION}-samples-sources.jar" -o {ARTIFACT}-{VERSION}-samples.jar

       # Extract and flatten into the cache directory
       unzip -q -o {ARTIFACT}-{VERSION}-samples.jar -d /tmp/wear-compose-samples/{VERSION}/{ARTIFACT}/

       # Clean up
       rm {ARTIFACT}-{VERSION}-samples.jar

4. If this works, proceed directly to step 4.

#### Step 4: Read samples and implement

1. Read the relevant `.kt` sample files.
2. Use these official, version-matched samples as the source of truth for:
   - Required parameters and slot names.
   - Default styling and typography tokens.
   - Interactive behaviors (for example: `onClick`, `onLongClick`).
   - Component nesting (for example: `AppScaffold` -\> `ScreenScaffold`).

### Capability 3: Component guidance

**Mandatory**: Use this capability as a checklist against any component use. It
provides more holistic guidance on how to use each component in practice, beyond
the component syntax.

1. `AppScaffold` and `ScreenScaffold`
   - \[ \] Use `AppScaffold` as the outer container, with `ScreenScaffold` children.
   - \[ \] Use only **ONE** `AppScaffold` and any number of `ScreenScaffold`.
2. `ScalingLazyColumn` - Use `TransformingLazyColumn` instead.
3. `TransformingLazyColumn` - You will need the following imports:


   ```kotlin
   import androidx.wear.compose.foundation.lazy.TransformingLazyColumn
   import androidx.wear.compose.foundation.lazy.TransformingLazyColumnDefaults
   import androidx.wear.compose.foundation.lazy.rememberTransformingLazyColumnState
   // ...
   import androidx.wear.compose.material3.lazy.rememberTransformationSpec
   import androidx.wear.compose.material3.lazy.transformedHeight
   ```

   <br />

   **Canonical example**:


   ```kotlin
   val columnState = rememberTransformingLazyColumnState()
   val transformationSpec = rememberTransformationSpec()
   ScreenScaffold(
       scrollState = columnState
   ) { contentPadding ->
       TransformingLazyColumn(
           state = columnState,
           contentPadding = contentPadding
       ) {
           item {
               ListHeader(
                   modifier = Modifier
                       .fillMaxWidth()
                       .transformedHeight(this, transformationSpec)
                       .minimumVerticalContentPadding(ListHeaderDefaults.minimumTopListContentPadding),
                   transformation = SurfaceTransformation(transformationSpec)
               ) {
                   Text(text = "Header")
               }
           }
           // ... other items
           item {
               Button(
                   modifier = Modifier
                       .fillMaxWidth()
                       .transformedHeight(this, transformationSpec)
                       .minimumVerticalContentPadding(ButtonDefaults.minimumVerticalListContentPadding),
                   transformation = SurfaceTransformation(transformationSpec),
                   onClick = { /* ... */ },
                   icon = {
                       Icon(
                           imageVector = Icons.Default.Build,
                           contentDescription = "build",
                       )
                   },
               ) {
                   Text(
                       text = "Build",
                       maxLines = 1,
                       overflow = TextOverflow.Ellipsis,
                   )
               }
           }
       }
   }
   ```

   <br />

   - \[ \] Use `TransformingLazyColumn` instead of `ScalingLazyColumn`.
   - \[ \] You must pass the `contentPadding` parameter from `ScreenScaffold` to the `TransformingLazyColumn`.
   - \[ \] Use the `minimumVerticalContentPadding` modifier to achieve required padding top and bottom.
     - This expects a value from defaults, such as `ButtonDefaults`, `CardDefaults`, \`ListHeaderDefaults.
     - Note: This is a scoped modifier available within `TransformingLazyColumnItemScope`.
   - \[ \] Ensure the list morphs and scales.
   - \[ \] Use `transformedHeight` modifier.
   - \[ \] Use `transform = SurfaceTransform(...)`.
   - \[ \] If configuring a list for snapping, use `flingBehavior` and `rotaryScrollableBehavior` **together**:


   ```kotlin
   val columnState = rememberTransformingLazyColumnState()
   ScreenScaffold(scrollState = columnState) { contentPadding ->
       TransformingLazyColumn(
           state = columnState,
           flingBehavior = TransformingLazyColumnDefaults.snapFlingBehavior(columnState),
           rotaryScrollableBehavior = RotaryScrollableDefaults.snapBehavior(columnState)
       ) {
           // ...
           // ...
       }
   }
   ```

   <br />

4. `ScreenScaffold`

   - \[ \] Guard the `scrollIndicator` with `!LocalScrollCaptureInProgress.current`.
5. `EdgeButton`

   - \[ \] Do **NOT** use as the final item within a `TransformingLazyColumn`. Instead, use the slot in `ScreenScaffold`.
   - \[ \] When used in a `TransformingLazyColumn`, add the required overscroll behavior:


   ```kotlin
   val columnState = rememberTransformingLazyColumnState()
   ScreenScaffold(
       scrollState = columnState,
       edgeButton = {
           EdgeButton(
               onClick = { /* TODO */ },
               modifier = Modifier.scrollable(
                   columnState,
                   orientation = Orientation.Vertical,
                   reverseDirection = true,
                   // Apply overscroll to the EdgeButton for proper scrolling behavior.
                   overscrollEffect = rememberOverscrollEffect(),
               )
           ) {
               Text("More")
           }
       }
   ) { contentPadding ->
       TransformingLazyColumn(
           contentPadding = contentPadding,
           state = columnState,
       ) {
           // ...
           // ...
       }
   }
   ```

   <br />

6. `Column`

   - \[ \] USE as a direct child of `ScreenScaffold` *if* the screen is will **never** scroll, even with the largest system font.
   - \[ \] Use `TransformingLazyColumn` instead for all other cases.
7. Styles

   - \[ \] Do **NOT** hard-code text sizes, use `typography` from `MaterialTheme`.
   - \[ \] Do **NOT** hard-code colors, use `colorScheme` from `MaterialTheme`.
8. Use component defaults:

   - \[ \] Components such as `Button` have a corresponding `ButtonDefaults` object.
   - Check for and use the `*Defaults` object for any component when working with padding and styling values, in preference to hard-coded values.
9. Use Wear specific previews:

   - \[ \] `WearPreviewDevices`
   - \[ \] `WearPreviewFontScales`
10. Ambient mode

    - \[ \] Use `LocalAmbientModeManager` instead of `AmbientLifecycleObserver`.
11. Navigation

    - \[ \] When adding navigation fresh, use Navigation3.
    - \[ \] For Navigation3 in Wear OS, use `SwipeDismissableSceneStrategy()` from the Wear Compose `compose-navigation3` library.

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
