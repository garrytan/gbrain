---
name: styles
description: Use this skill to integrate the Jetpack Compose Styles API into an Android
  project. This skill guides you through upgrading dependencies, setting up component
  themes, making custom components styleable, and migrating existing layout properties
  to use unified styles. Migrate custom design system components, replace hard coded
  parameters with Style attributes, and use Modifier.styleable for interaction states.
license: Complete terms in LICENSE.txt
metadata:
  author: Google LLC
  last-updated: '2026-07-02'
  keywords:
  - Jetpack Compose
  - Styles
  - Theming with Styles
  - Migrate to Styles
  - Modifier.styleable
triggers:
  - android
  - jetpack
  - compose
---

## Limitations

- Warn the user that this skill is EXPERIMENTAL and requires updating to alpha version of Compose and opting in to the Experimental APIs.
- This skill only supports custom UI components and custom themes.
- This skill does not support Material Design component Styles.

## Prerequisites

### 1. Upgrade dependencies

- The project must use `compileSdk` version 37 or higher.
- The project must use `androidx.compose.foundation:foundation` version `1.12.0-alpha01` or higher.
- Alternatively, the project must use Compose BOM version `2026.04.01` or higher.
- The API requires this exact package: `import
  androidx.compose.foundation.style.Style`

### 2. Configure compiler options to enable experimental API

You must opt-in to the experimental API at the project level. Add the following
block to your module's `build.gradle.kts`:

    kotlin {
        compilerOptions {
            jvmTarget = JvmTarget.fromTarget("17")
            freeCompilerArgs.add("-opt-in=androidx.compose.foundation.style.ExperimentalFoundationStyleApi")
        }
    }

## Core workflows and guides

Refer to the official documentation to complete specific development tasks:

- Basic Style Usage: To set backgrounds, sizes, and alignments on a component, follow the [Compose Styles Fundamentals
  Guide](references/android/develop/ui/compose/styles/fundamentals.md).
- State and Transitions: To configure property changes for state shifts (like pressed or hovered), follow the [Animations and State-Based Styling
  Guide](references/android/develop/ui/compose/styles/state-animations.md).
- Architecture Trade offs: To decide when to use a Style versus a standard Modifier, follow the [Styles versus Modifiers
  Comparison](references/android/develop/ui/compose/styles/styles-vs-modifiers.md).
- Theme Level Integration: To connect style definitions with custom themes, follow [Theming with Styles](references/android/develop/ui/compose/styles/theming.md) and [Custom Themes in Compose](references/android/develop/ui/compose/designsystems/custom.md).

## Step-by-Step Migration Workflow

### Step 1: Analyze theme structure

1. Locate your central theme file (such as `Theme.kt`).
2. Identify design tokens. Note references for colors, typography, and shapes (for example, `LocalColorScheme`, `LocalTypography`, or `LocalShapes`).
3. If the project lacks Jetpack Compose dependencies, stop. Instruct the user to migrate to Jetpack Compose first.
4. If the project imports `androidx.compose.material.MaterialTheme`, recommend migrating to Material 3 before proceeding.

### Step 2: Establish `ComponentStyles`

1. Create a new file named `ComponentStyles.kt` in your theme directory.
2. Define a top-level data class to hold your component styles, for example, the Jetsnack one is called `JetsnackStyles`:


   ```kotlin
   object ExampleComponentStyles {
       val customButtonStyle: Style = {

       }
       val customTextFieldStyle: Style = {

       }
   }
   ```

   <br />

3. Expose this class through your custom theme with a static reference, don't
   use `CompositionLocals` here as it's not required.


   ```kotlin
   @Immutable
   class JetsnackTheme(
       // other Design system properties
   ) {
       companion object {
           val colors: CustomThemingWithStyles.JetsnackColors
               @Composable @ReadOnlyComposable
               get() = LocalJetsnackTheme.current.colors
           // ...

           // add helper static reference
           val styles: ComponentStyles = ComponentStyles
       }
   }
   ```

   <br />

4. Provide extensions on `StyleScope` to reference theme tokens directly if
   they are exposed using `CompositionLocals`. For example:


   ```kotlin
   val StyleScope.colors: JetsnackColors
       get() = LocalJetsnackTheme.currentValue.colors

   val StyleScope.typography: androidx.compose.material3.Typography
       get() = LocalJetsnackTheme.currentValue.typography

   val StyleScope.shapes: Shapes
       get() = LocalJetsnackTheme.currentValue.shapes
   ```

   <br />

### Step 3: Migrate a component to Styles API

For each custom component (for example, `CustomButton`), complete the following
sequence:

1. **Establish a visual baseline (If an emulator is available):**
   - **If you CANNOT run an Android emulator:** Skip this step entirely and proceed to Step 2.
   - **If you CAN run an Android emulator:** Perform the following to capture a baseline screenshot:
     - **Option A:** Locate and run an existing screenshot test for the component.
     - **Option B (If no test exists):** Create a test using the project's existing testing framework, then run it.
     - **Option C (If no framework exists):** Create a minimal screenshot test using UI Automator or Espresso, then run it.
2. **Remove individual styling parameters** : Remove styling parameters such as `backgroundColor`, `shape`, `textStyle`, and `contentPadding` from the signature - anything that `StyleScope` supports.
3. **Add the style parameter** : Add `style: Style = Style` to the function signature. Always ensure the default value is exactly `Style` (e.g., `style:
   Style = Style`) and not a specific style default like `ChipStyleDefault` or any other value.
4. **Declare state tracking** : If the component is interactable, create a `MutableStyleState` using the interaction source. Update state fields (such as `isEnabled`) inside the Composable to track the state correctly.
5. **Apply styleable modifier** : Replace specific layout modifiers on the root element with `Modifier.styleable()`.
6. **Move defaults to ComponentStyles** : Move hardcoded values from the component definition to a dedicated `Style` instance in `ComponentStyles.kt`.
7. **Validate component:** Compare the baseline screenshot image taken at the start with the rendered Compose Preview of the new composable. Ignore string content; focus on layout and styling. Iterate on the Compose code until visual parity is achieved. Once verified, write a Compose UI test for the new composable.

#### Migration example

Before Migration:


```kotlin
@Composable
fun CustomButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    backgroundColor: Color = JetsnackTheme.colors.brandLight,
    disabledBackgroundColor: Color = JetsnackTheme.colors.brandSecondary,
    shape: Shape = JetsnackTheme.shapes.extraLarge,
    textStyle: TextStyle = JetsnackTheme.typography.labelLarge,
    enabled: Boolean = true,
    content: @Composable RowScope.() -> Unit,
) {
    val interactionSource = remember { MutableInteractionSource() }
    Row(
        modifier
            .clickable(onClick = onClick, indication = null, interactionSource = interactionSource)
            .background(if (enabled) backgroundColor else disabledBackgroundColor, shape)
            .defaultMinSize(58.dp, 40.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
        content = content,
    )
}
```

<br />

After Migration:


```kotlin
// Exposed via ComponentStyles.kt
object ComponentStyles {
    val buttonStyle = Style {
        background(colors.brandLight)
        shape(shapes.extraLarge)
        minWidth(58.dp)
        minHeight(40.dp)
        textStyle(typography.labelLarge)
        disabled {
            background(colors.brandSecondary)
        }
    }
}

@Composable
fun CustomButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    style: Style = Style,
    enabled: Boolean = true,
    content: @Composable RowScope.() -> Unit,
) {
    val interactionSource = remember { MutableInteractionSource() }
    val styleState = rememberUpdatedStyleState(interactionSource) {
        it.isEnabled = enabled
    }
    Row(
        modifier
            .clickable(onClick = onClick, indication = null, interactionSource = interactionSource)
            .styleable(styleState, JetsnackTheme.styles.buttonStyle, style),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
        content = content,
    )
}
```

<br />

### Step 4: Validate Changes

1. Build the project. Verify that there are no compilation errors.
2. Run your module's screenshot tests.
3. Compare visual outputs of the whole app between the previous and updated components. Verify that no visual layout regressions occur.

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
