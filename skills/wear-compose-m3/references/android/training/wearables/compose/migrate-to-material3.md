[Material 3 Expressive](https://developer.android.com/design/ui/wear/guides/get-started) is the next evolution of Material Design. It includes
updated theming, components, and personalization features like dynamic color.

This guide focuses on migrating from the [Wear Compose Material 2.5
(androidx.wear.compose)](https://developer.android.com/jetpack/androidx/releases/wear-compose#wear_compose_version_15_2) Jetpack library to the [Wear Compose Material 3
(androidx.wear.compose.material3)](https://developer.android.com/jetpack/androidx/releases/wear-compose-m3) Jetpack library for apps.

> [!NOTE]
> **Note:** This guide uses abbreviation "M3" to refer to the interchangeable terms of "Material 3 Expressive" and the equivalent Jetpack library for Compose on Wear OS (androidx.wear.compose.material3). The abbreviation "M2.5" is used to refer to the interchangeable terms of "Material 2.5" and the equivalent Jetpack library for Compose on Wear OS (androidx.wear.compose.material).

## Approaches

For migrating your app code from M2.5 to M3, follow the same approach described
in the [Compose Material migration phone guidance](https://developer.android.com/develop/ui/compose/designsystems/material2-material3), in particular:

- You shouldn't use both [M2.5 and M3 in a single app long-term](https://developer.android.com/develop/ui/compose/designsystems/material2-material3#approaches).
- You should no longer use the Horologist Composables, Compose Layout, or Compose Material libraries. Instead, use the components in M3.
- Adopt a [phased approach](https://developer.android.com/develop/ui/compose/designsystems/material2-material3#phased-approach).

## Dependencies

M3 has a separate package and version to M2.5:

### M2.5

    implementation("androidx.wear.compose:compose-material:1.4.0")

### M3

    implementation("androidx.wear.compose:compose-material3:1.7.0-alpha05")

See the latest M3 versions on the [Wear Compose Material 3 releases page](https://developer.android.com/jetpack/androidx/releases/wear-compose-m3).

Wear Compose Foundation library version 1.7.0-alpha05 introduced
some new components that are designed to work with Material 3 components.
Similarly, `SwipeDismissableNavHost` from Wear Compose Navigation library has an
updated animation when running on Wear OS 6 (API level 36) or higher. When
updating to Wear Compose Material 3 version, we suggest to also update the Wear
Compose Foundation and Navigation libraries:

    implementation("androidx.wear.compose:compose-foundation:1.7.0-alpha05")
    implementation("androidx.wear.compose:compose-navigation:1.7.0-alpha05")

## Theme

In both M2.5 and M3, the theme composable is named [`MaterialTheme`](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#MaterialTheme(androidx.wear.compose.material3.ColorScheme,androidx.wear.compose.material3.Typography,androidx.wear.compose.material3.Shapes,androidx.wear.compose.material3.MotionScheme,kotlin.Function0)), but the
import packages and parameters differ. In M3, the `Colors` parameter has been
renamed to `ColorScheme` and `MotionScheme` has been introduced for implementing
transitions.

### M2.5

    import androidx.wear.compose.material.MaterialTheme

    MaterialTheme(
        colors = AppColors,
        typography = AppTypography,
        shapes = AppShapes,
        content = content
    )

### M3


```kotlin
import androidx.wear.compose.material3.MaterialTheme
// ...
    MaterialTheme(
        colorScheme = ColorScheme(),
        typography = Typography(),
        shapes = Shapes(),
        motionScheme = MotionScheme.standard(),
        content = { /*content here*/ }
    )
```

<br />

### Color

The color system in M3 is significantly different from M2.5. The number of color
parameters has increased, they have different names, and they map differently to
M3 components. In Compose, this applies to the M2.5 [`Colors`](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/Colors) class, the M3
[`ColorScheme`](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/ColorScheme) class, and related functions:

### M2.5

    import androidx.wear.compose.material.Colors

    val appColorScheme: Colors = Colors(
       // M2.5 Color parameters
    )

### M3


```kotlin
import androidx.wear.compose.material3.ColorScheme
// ...
    val appColorScheme: ColorScheme = ColorScheme(
        // M3 ColorScheme parameters
    )
```

<br />

The following table describes the key differences between M2.5 and M3:

| M2.5 | M3 |
|---|---|
| `Color` | Has been renamed to `ColorScheme` |
| 13 colors | 28 colors |
| N/A | New dynamic color theming |
| N/A | New tertiary colors for more expression |

#### Dynamic color theming

A new feature in M3 is [dynamic color theming](https://m3.material.io/styles/color/dynamic-color/overview). If users change
the watch face colors, the colors in the UI change to match.

Use the [`dynamicColorScheme`](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#dynamicColorScheme(android.content.Context)) function to implement dynamic color scheme
and provide a `defaultColorScheme` as a fallback in case dynamic color scheme is
not available.


```kotlin
@Composable
fun myApp() {
    val dynamicColorScheme = dynamicColorScheme(LocalContext.current)
    MaterialTheme(colorScheme = dynamicColorScheme ?: myBrandColors) {}
}

internal val myBrandColors: ColorScheme = ColorScheme( /* Specify colors here */)
```

<br />

### Typography

The [typography system](https://m3.material.io/styles/typography/overview) in M3 is different from M2.5 and it includes
the following features:

- Nine new [text styles](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/Typography#public-properties_1)
- Flex fonts, which allow for customization of the type scales for different weights, widths, and roundness
- `AnimatedText`, which uses flex fonts

### M2.5

    import androidx.wear.compose.material.Typography

    val Typography = Typography(
       // M2.5 TextStyle parameters
    )

### M3


```kotlin
import androidx.wear.compose.material3.Typography

val Typography = Typography(
    // M3 TextStyle parameters
)
```

<br />

#### Flex fonts

Flex Fonts allow designers to specify the type width and weight for specific
sizes.

#### Text styles

The following [TextStyles](https://cs.android.com/androidx/platform/frameworks/support/+/androidx-main:wear/compose/compose-material3/src/main/java/androidx/wear/compose/material3/Typography.kt;l=115?q=displayLarge&ss=androidx/platform/frameworks/support) are available in M3. These are
employed by default by various M3 components.

| Typography | TextStyle |
|---|---|
| Display | displayLarge, displayMedium, displaySmall |
| Title | titleLarge, titleMedium, titleSmall |
| Label | labelLarge, labelMedium, labelSmall |
| Body | bodyLarge, bodyMedium, bodySmall, bodyExtraSmall |
| Numeral | numeralExtraLarge, numeralLarge, numeralMedium, numeralSmall, numeralExtraSmall |
| Arc | arcLarge, arcMedium, arcSmall |

### Shape

The [shape system](https://m3.material.io/styles/shape/overview) in M3 is different from M2.5. The number of shape
parameters has increased, they're named differently, and they map differently to
M3 components. The following shape sizes are available:

- Extra-small
- Small
- Medium
- Large
- Extra-large

In Compose, this applies to the M2 [`Shapes`](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/Shapes) class and the M3
[`Shapes`](https://developer.android.com/reference/kotlin/androidx/compose/material3/Shapes) class:

### M2.5

    import androidx.wear.compose.material.Shapes

    val Shapes = Shapes(
       // M2.5 Shapes parameters
    )

### M3


```kotlin
import androidx.wear.compose.material3.Shapes

val Shapes = Shapes(
    // M3 Shapes parameters
)
```

<br />

> [!NOTE]
> **Note:** For shapes, we generally recommend using the default Material 3 Wear shapes which are optimized for round devices.

Use the Shapes parameter mapping from [Migrate from Material 2 to Material 3 in
Compose](https://developer.android.com/training/wearables/compose/migrate-to-material3#shape) as a starting point.

### Shape morphing

M3 introduces Shape Morphing: shapes now morph in response to interactions.

Shape Morphing behavior is available as a variation on a number of round
buttons, see the following list of buttons that support Shape Morphing:

| Buttons | Shape morphing function |
|---|---|
| `IconButton` | [IconButtonDefaults.animatedShape](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/IconButtonDefaults#animatedShapes(androidx.compose.foundation.shape.CornerBasedShape,androidx.compose.foundation.shape.CornerBasedShape)) animates the icon button on press |
| `IconToggleButton` | [IconToggleButtonDefaults.animatedShape](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/IconToggleButtonDefaults#animatedShapes(androidx.compose.foundation.shape.CornerBasedShape,androidx.compose.foundation.shape.CornerBasedShape)) animates the icon toggle button on press and [IconToggleButtonDefaults.variantAnimatedShapes](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/IconToggleButtonDefaults#variantAnimatedShapes()) animates the icon toggle button on press and check/uncheck |
| `TextButton` | [TextButtonDefaults.animatedShape](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/TextButtonDefaults#animatedShapes(androidx.compose.foundation.shape.CornerBasedShape,androidx.compose.foundation.shape.CornerBasedShape)) animates the text button on press |
| `TextToggleButton` | [TextToggleButtonDefaults.animatedShapes](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/TextToggleButtonDefaults#animatedShapes(androidx.compose.foundation.shape.CornerBasedShape,androidx.compose.foundation.shape.CornerBasedShape)) animates the text toggle on press and [TextToggleButtonDefaults.variantAnimatedShapes](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/TextToggleButtonDefaults#variantAnimatedShapes()) animates the text toggle on press and check/uncheck |

## Components and Layout

Most components and layouts from M2.5 are available in M3. However, some M3
components and layouts didn't exist in M2.5. Furthermore, some M3 components
have more variations than their equivalents in M2.5.

While some components require special considerations, the following function
mappings are recommended as a starting point:

| Material 2.5 | Material 3 |
|---|---|
| [androidx.wear.compose.material.dialog.Alert](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/dialog/package-summary#Alert(kotlin.Function1,androidx.compose.ui.Modifier,kotlin.Function1,kotlin.Function1,androidx.wear.compose.foundation.lazy.ScalingLazyListState,androidx.compose.ui.graphics.Color,androidx.compose.ui.graphics.Color,androidx.compose.ui.graphics.Color,androidx.compose.ui.graphics.Color,androidx.compose.foundation.layout.Arrangement.Vertical,androidx.compose.foundation.layout.PaddingValues,kotlin.Function1)) | [androidx.wear.compose.material3.AlertDialog](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#AlertDialog(kotlin.Boolean,kotlin.Function0,kotlin.Function0,androidx.compose.ui.Modifier,kotlin.Function0,kotlin.Function0,androidx.compose.foundation.layout.Arrangement.Vertical,androidx.compose.foundation.layout.PaddingValues,androidx.compose.ui.window.DialogProperties,kotlin.Function1)) |
| [androidx.wear.compose.material.Button](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/package-summary#Button(kotlin.Function0,androidx.compose.ui.Modifier,kotlin.Boolean,androidx.wear.compose.material.ButtonColors,androidx.compose.foundation.interaction.MutableInteractionSource,androidx.compose.ui.graphics.Shape,androidx.wear.compose.material.ButtonBorder,kotlin.Function1)) | [androidx.wear.compose.material3.IconButton](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#IconButton(kotlin.Function0,androidx.compose.ui.Modifier,kotlin.Function0,kotlin.String,kotlin.Boolean,androidx.wear.compose.material3.IconButtonShapes,androidx.wear.compose.material3.IconButtonColors,androidx.compose.foundation.BorderStroke,androidx.compose.foundation.interaction.MutableInteractionSource,kotlin.Function1)) or [androidx.wear.compose.material3.TextButton](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#TextButton(kotlin.Function0,androidx.compose.ui.Modifier,kotlin.Function0,kotlin.String,kotlin.Boolean,androidx.wear.compose.material3.TextButtonShapes,androidx.wear.compose.material3.TextButtonColors,androidx.compose.foundation.BorderStroke,androidx.compose.foundation.interaction.MutableInteractionSource,kotlin.Function1)) |
| [androidx.wear.compose.material.Card](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/package-summary#Card(kotlin.Function0,androidx.compose.ui.Modifier,androidx.compose.ui.graphics.painter.Painter,androidx.compose.ui.graphics.Color,kotlin.Boolean,androidx.compose.foundation.layout.PaddingValues,androidx.compose.ui.graphics.Shape,androidx.compose.foundation.interaction.MutableInteractionSource,androidx.compose.ui.semantics.Role,kotlin.Function1)) | [androidx.wear.compose.material3.Card](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#Card(kotlin.Function0,androidx.compose.ui.Modifier,kotlin.Function0,kotlin.String,kotlin.Boolean,androidx.compose.ui.graphics.Shape,androidx.wear.compose.material3.CardColors,androidx.compose.foundation.BorderStroke,androidx.compose.foundation.layout.PaddingValues,androidx.compose.foundation.interaction.MutableInteractionSource,kotlin.Function1)) |
| [androidx.wear.compose.material.TitleCard](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/package-summary#TitleCard(kotlin.Function0,kotlin.Function1,androidx.compose.ui.Modifier,kotlin.Boolean,kotlin.Function1,androidx.compose.ui.graphics.painter.Painter,androidx.compose.ui.graphics.Color,androidx.compose.ui.graphics.Color,androidx.compose.ui.graphics.Color,kotlin.Function1)) | [androidx.wear.compose.material3.TitleCard](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#TitleCard(kotlin.Function0,kotlin.Function1,androidx.compose.ui.Modifier,kotlin.Function0,kotlin.String,kotlin.Function0,kotlin.Function1,kotlin.Boolean,androidx.compose.ui.graphics.Shape,androidx.wear.compose.material3.CardColors,androidx.compose.foundation.BorderStroke,androidx.compose.foundation.layout.PaddingValues,androidx.compose.foundation.interaction.MutableInteractionSource,kotlin.Function0)) |
| [androidx.wear.compose.material.AppCard](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/package-summary#AppCard(kotlin.Function0,kotlin.Function1,kotlin.Function1,kotlin.Function1,androidx.compose.ui.Modifier,kotlin.Boolean,kotlin.Function1,androidx.compose.ui.graphics.painter.Painter,androidx.compose.ui.graphics.Color,androidx.compose.ui.graphics.Color,androidx.compose.ui.graphics.Color,androidx.compose.ui.graphics.Color,kotlin.Function1)) | [androidx.wear.compose.material3.AppCard](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#AppCard(kotlin.Function0,kotlin.Function1,kotlin.Function1,androidx.compose.ui.Modifier,kotlin.Function0,kotlin.String,kotlin.Boolean,androidx.compose.ui.graphics.Shape,androidx.wear.compose.material3.CardColors,androidx.compose.foundation.BorderStroke,androidx.compose.foundation.layout.PaddingValues,androidx.compose.foundation.interaction.MutableInteractionSource,kotlin.Function1,kotlin.Function1,kotlin.Function1)) |
| [androidx.wear.compose.material.Checkbox](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/package-summary#Checkbox(kotlin.Boolean,androidx.compose.ui.Modifier,androidx.wear.compose.material.CheckboxColors,kotlin.Boolean,kotlin.Function1,androidx.compose.foundation.interaction.MutableInteractionSource)) | No M3 equivalent, migrate to [androidx.wear.compose.material3.CheckboxButton](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#CheckboxButton(kotlin.Boolean,kotlin.Function1,androidx.compose.ui.Modifier,kotlin.Boolean,androidx.compose.ui.graphics.Shape,androidx.wear.compose.material3.CheckboxButtonColors,androidx.compose.foundation.layout.PaddingValues,androidx.compose.foundation.interaction.MutableInteractionSource,androidx.wear.compose.material3.SurfaceTransformation,kotlin.Function1,kotlin.Function1,kotlin.Function1)) or [androidx.wear.compose.material3.SplitCheckboxButton](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#SplitCheckboxButton(kotlin.Boolean,kotlin.Function1,kotlin.String,kotlin.Function0,androidx.compose.ui.Modifier,kotlin.Boolean,androidx.compose.ui.graphics.Shape,androidx.wear.compose.material3.SplitCheckboxButtonColors,androidx.compose.foundation.interaction.MutableInteractionSource,androidx.compose.foundation.interaction.MutableInteractionSource,androidx.wear.compose.material3.SurfaceTransformation,kotlin.String,androidx.compose.foundation.layout.PaddingValues,kotlin.Function1,kotlin.Function1)) |
| [androidx.wear.compose.material.Chip](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/package-summary#Chip(kotlin.Function0,androidx.wear.compose.material.ChipColors,androidx.wear.compose.material.ChipBorder,androidx.compose.ui.Modifier,kotlin.Boolean,androidx.compose.foundation.layout.PaddingValues,androidx.compose.ui.graphics.Shape,androidx.compose.foundation.interaction.MutableInteractionSource,androidx.compose.ui.semantics.Role,kotlin.Function1)) | [androidx.wear.compose.material3.Button](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#Button(kotlin.Function0,androidx.compose.ui.Modifier,kotlin.Function0,kotlin.String,kotlin.Boolean,androidx.compose.ui.graphics.Shape,androidx.wear.compose.material3.ButtonColors,androidx.compose.foundation.BorderStroke,androidx.compose.foundation.layout.PaddingValues,androidx.compose.foundation.interaction.MutableInteractionSource,kotlin.Function1)) or [androidx.wear.compose.material3.OutlinedButton](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#OutlinedButton(kotlin.Function0,androidx.compose.ui.Modifier,kotlin.Function0,kotlin.String,kotlin.Boolean,androidx.compose.ui.graphics.Shape,androidx.wear.compose.material3.ButtonColors,androidx.compose.foundation.BorderStroke,androidx.compose.foundation.layout.PaddingValues,androidx.compose.foundation.interaction.MutableInteractionSource,kotlin.Function1)) or [androidx.wear.compose.material3.FilledTonalButton](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#FilledTonalButton(kotlin.Function0,androidx.compose.ui.Modifier,kotlin.Function0,kotlin.String,kotlin.Boolean,androidx.compose.ui.graphics.Shape,androidx.wear.compose.material3.ButtonColors,androidx.compose.foundation.BorderStroke,androidx.compose.foundation.layout.PaddingValues,androidx.compose.foundation.interaction.MutableInteractionSource,androidx.wear.compose.material3.SurfaceTransformation,kotlin.Function1)) or [androidx.wear.compose.material3.ChildButton](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#ChildButton(kotlin.Function0,androidx.compose.ui.Modifier,kotlin.Function0,kotlin.String,kotlin.Function1,kotlin.Function1,kotlin.Boolean,androidx.compose.ui.graphics.Shape,androidx.wear.compose.material3.ButtonColors,androidx.compose.foundation.BorderStroke,androidx.compose.foundation.layout.PaddingValues,androidx.compose.foundation.interaction.MutableInteractionSource,androidx.wear.compose.material3.SurfaceTransformation,kotlin.Function1)) |
| [androidx.wear.compose.material.CompactChip](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/package-summary#CompactChip(kotlin.Function0,androidx.compose.ui.Modifier,kotlin.Function1,kotlin.Function1,androidx.wear.compose.material.ChipColors,kotlin.Boolean,androidx.compose.foundation.interaction.MutableInteractionSource,androidx.compose.foundation.layout.PaddingValues,androidx.compose.ui.graphics.Shape,androidx.wear.compose.material.ChipBorder)) | [androidx.wear.compose.material3.CompactButton](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#CompactButton(kotlin.Function0,androidx.compose.ui.Modifier,kotlin.Function0,kotlin.String,kotlin.Function1,kotlin.Boolean,androidx.compose.ui.graphics.Shape,androidx.wear.compose.material3.ButtonColors,androidx.compose.foundation.BorderStroke,androidx.compose.foundation.layout.PaddingValues,androidx.compose.foundation.interaction.MutableInteractionSource,kotlin.Function1)) |
| [androidx.wear.compose.material.InlineSlider](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/package-summary#InlineSlider(kotlin.Int,kotlin.Function1,kotlin.ranges.IntProgression,kotlin.Function0,kotlin.Function0,androidx.compose.ui.Modifier,kotlin.Boolean,kotlin.Boolean,androidx.wear.compose.material.InlineSliderColors)) | [androidx.wear.compose.material3.Slider](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#Slider(kotlin.Int,kotlin.Function1,kotlin.ranges.IntProgression,androidx.compose.ui.Modifier,kotlin.Function0,kotlin.Function0,kotlin.Boolean,kotlin.Boolean,androidx.compose.ui.graphics.Shape,androidx.wear.compose.material3.SliderColors)) |
| [androidx.wear.compose.material.LocalContentAlpha()](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/package-summary#LocalContentAlpha()) | Has been removed as not used by `Text` or `Icon` in Material 3 |
| [androidx.wear.compose.material.PositionIndicator](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/package-summary#PositionIndicator(androidx.compose.foundation.lazy.LazyListState,androidx.compose.ui.Modifier,kotlin.Boolean,androidx.compose.animation.core.AnimationSpec,androidx.compose.animation.core.AnimationSpec,androidx.compose.animation.core.AnimationSpec)) | [androidx.wear.compose.material3.ScrollIndicator](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#ScrollIndicator(androidx.compose.foundation.lazy.LazyListState,androidx.compose.ui.Modifier,kotlin.Boolean,androidx.compose.animation.core.AnimationSpec)) |
| [androidx.wear.compose.material.RadioButton](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/package-summary#RadioButton(kotlin.Boolean,androidx.compose.ui.Modifier,androidx.wear.compose.material.RadioButtonColors,kotlin.Boolean,kotlin.Function0,androidx.compose.foundation.interaction.MutableInteractionSource)) | No M3 equivalent, migrate to [androidx.wear.compose.material3.RadioButton](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#RadioButton(kotlin.Boolean,kotlin.Function0,androidx.compose.ui.Modifier,kotlin.Boolean,androidx.compose.ui.graphics.Shape,androidx.wear.compose.material3.RadioButtonColors,androidx.compose.foundation.layout.PaddingValues,androidx.compose.foundation.interaction.MutableInteractionSource,androidx.wear.compose.material3.SurfaceTransformation,kotlin.Function1,kotlin.Function1,kotlin.Function1)) or [androidx.wear.compose.material3.SplitRadioButton](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#SplitRadioButton(kotlin.Boolean,kotlin.Function0,kotlin.String,kotlin.Function0,androidx.compose.ui.Modifier,kotlin.Boolean,androidx.compose.ui.graphics.Shape,androidx.wear.compose.material3.SplitRadioButtonColors,androidx.compose.foundation.interaction.MutableInteractionSource,androidx.compose.foundation.interaction.MutableInteractionSource,androidx.wear.compose.material3.SurfaceTransformation,kotlin.String,androidx.compose.foundation.layout.PaddingValues,kotlin.Function1,kotlin.Function1)) |
| [androidx.wear.compose.material.SwipeToRevealCard](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#Stepper(kotlin.Int,kotlin.Function1,kotlin.ranges.IntProgression,kotlin.Function0,kotlin.Function0,androidx.compose.ui.Modifier,kotlin.Boolean,androidx.wear.compose.material3.StepperColors,kotlin.Function1)) | [androidx.wear.compose.material3.SwipeToReveal](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#SwipeToReveal(kotlin.Function1,androidx.compose.ui.Modifier,androidx.wear.compose.foundation.RevealState,androidx.compose.ui.unit.Dp,kotlin.Function0)) |
| [androidx.wear.compose.material.SwipeToRevealChip](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/package-summary#SwipeToRevealChip(kotlin.Function1,androidx.wear.compose.foundation.RevealState,kotlin.Function0,androidx.compose.ui.Modifier,kotlin.Function1,kotlin.Function1,kotlin.Function1,androidx.wear.compose.material.SwipeToRevealActionColors,androidx.compose.ui.graphics.Shape,kotlin.Function0)) | [androidx.wear.compose.material3.SwipeToReveal](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#SwipeToReveal(kotlin.Function1,androidx.compose.ui.Modifier,androidx.wear.compose.foundation.RevealState,androidx.compose.ui.unit.Dp,kotlin.Function0)) |
| [android.wear.compose.material.Scaffold](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/package-summary#Scaffold(androidx.compose.ui.Modifier,kotlin.Function0,kotlin.Function0,kotlin.Function0,kotlin.Function0,kotlin.Function0)) | [androidx.wear.compose.material3.AppScaffold](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#AppScaffold(androidx.compose.ui.Modifier,kotlin.Function0,kotlin.Function1)) and [androidx.wear.compose.material3.ScreenScaffold](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#ScreenScaffold(androidx.compose.ui.Modifier,kotlin.Function0,androidx.wear.compose.foundation.ScrollInfoProvider,kotlin.Function1,kotlin.Function1)) |
| [androidx.wear.compose.material.SplitToggleChip](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/package-summary#SplitToggleChip(kotlin.Boolean,kotlin.Function1,kotlin.Function1,kotlin.Function0,kotlin.Function1,androidx.compose.ui.Modifier,kotlin.Function1,androidx.wear.compose.material.SplitToggleChipColors,kotlin.Boolean,androidx.compose.foundation.interaction.MutableInteractionSource,androidx.compose.foundation.interaction.MutableInteractionSource,androidx.compose.foundation.layout.PaddingValues,androidx.compose.ui.graphics.Shape)) | No M3 equivalent, migrate to [androidx.wear.compose.material3.SplitCheckboxButton](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#SplitCheckboxButton(kotlin.Boolean,kotlin.Function1,kotlin.String,kotlin.Function0,androidx.compose.ui.Modifier,kotlin.Boolean,androidx.compose.ui.graphics.Shape,androidx.wear.compose.material3.SplitCheckboxButtonColors,androidx.compose.foundation.interaction.MutableInteractionSource,androidx.compose.foundation.interaction.MutableInteractionSource,kotlin.String,androidx.compose.foundation.layout.PaddingValues,kotlin.Function1,kotlin.Function1)), [androidx.wear.compose.material3.SplitSwitchButton](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#SplitSwitchButton(kotlin.Boolean,kotlin.Function1,kotlin.String,kotlin.Function0,androidx.compose.ui.Modifier,kotlin.Boolean,androidx.compose.ui.graphics.Shape,androidx.wear.compose.material3.SplitSwitchButtonColors,androidx.compose.foundation.interaction.MutableInteractionSource,androidx.compose.foundation.interaction.MutableInteractionSource,androidx.wear.compose.material3.SurfaceTransformation,kotlin.String,androidx.compose.foundation.layout.PaddingValues,kotlin.Function1,kotlin.Function1)), or [androidx.wear.compose.material3.SplitRadioButton](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#SplitRadioButton(kotlin.Boolean,kotlin.Function0,kotlin.String,kotlin.Function0,androidx.compose.ui.Modifier,kotlin.Boolean,androidx.compose.ui.graphics.Shape,androidx.wear.compose.material3.SplitRadioButtonColors,androidx.compose.foundation.interaction.MutableInteractionSource,androidx.compose.foundation.interaction.MutableInteractionSource,androidx.wear.compose.material3.SurfaceTransformation,kotlin.String,androidx.compose.foundation.layout.PaddingValues,kotlin.Function1,kotlin.Function1)) |
| [androidx.wear.compose.material.Switch](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/package-summary#Switch(kotlin.Boolean,androidx.compose.ui.Modifier,androidx.wear.compose.material.SwitchColors,kotlin.Boolean,kotlin.Function1,androidx.compose.foundation.interaction.MutableInteractionSource)) | No M3 equivalent, migrate to [androidx.wear.compose.material3.SwitchButton](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#SwitchButton(kotlin.Boolean,kotlin.Function1,androidx.compose.ui.Modifier,kotlin.Boolean,androidx.compose.ui.graphics.Shape,androidx.wear.compose.material3.SwitchButtonColors,androidx.compose.foundation.layout.PaddingValues,androidx.compose.foundation.interaction.MutableInteractionSource,kotlin.Function1,kotlin.Function1,kotlin.Function1)) or [androidx.wear.compose.material3.SplitSwitchButton](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#SplitSwitchButton(kotlin.Boolean,kotlin.Function1,kotlin.String,kotlin.Function0,androidx.compose.ui.Modifier,kotlin.Boolean,androidx.compose.ui.graphics.Shape,androidx.wear.compose.material3.SplitSwitchButtonColors,androidx.compose.foundation.interaction.MutableInteractionSource,androidx.compose.foundation.interaction.MutableInteractionSource,kotlin.String,androidx.compose.foundation.layout.PaddingValues,kotlin.Function1,kotlin.Function1)) |
| [androidx.wear.compose.material.ToggleButton](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/package-summary#ToggleButton(kotlin.Boolean,kotlin.Function1,androidx.compose.ui.Modifier,kotlin.Boolean,androidx.wear.compose.material.ToggleButtonColors,androidx.compose.foundation.interaction.MutableInteractionSource,androidx.compose.ui.graphics.Shape,androidx.compose.ui.semantics.Role,kotlin.Function1)) | [androidx.wear.compose.material3.IconToggleButton](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#IconToggleButton(kotlin.Boolean,kotlin.Function1,androidx.compose.ui.Modifier,kotlin.Boolean,androidx.wear.compose.material3.IconToggleButtonColors,androidx.compose.foundation.interaction.MutableInteractionSource,androidx.wear.compose.material3.IconToggleButtonShapes,androidx.compose.foundation.BorderStroke,kotlin.Function1)) or [androidx.wear.compose.material3.TextToggleButton](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#TextToggleButton(kotlin.Boolean,kotlin.Function1,androidx.compose.ui.Modifier,kotlin.Boolean,androidx.wear.compose.material3.TextToggleButtonColors,androidx.compose.foundation.interaction.MutableInteractionSource,androidx.wear.compose.material3.TextToggleButtonShapes,androidx.compose.foundation.BorderStroke,kotlin.Function1)) |
| [androidx.wear.compose.material.ToggleChip](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/package-summary#ToggleChip(kotlin.Boolean,kotlin.Function1,kotlin.Function1,kotlin.Function0,androidx.compose.ui.Modifier,kotlin.Function1,kotlin.Function1,androidx.wear.compose.material.ToggleChipColors,kotlin.Boolean,androidx.compose.foundation.interaction.MutableInteractionSource,androidx.compose.foundation.layout.PaddingValues,androidx.compose.ui.graphics.Shape)) | [androidx.wear.compose.material3.CheckboxButton](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#CheckboxButton(kotlin.Boolean,kotlin.Function1,androidx.compose.ui.Modifier,kotlin.Boolean,androidx.compose.ui.graphics.Shape,androidx.wear.compose.material3.CheckboxButtonColors,androidx.compose.foundation.layout.PaddingValues,androidx.compose.foundation.interaction.MutableInteractionSource,kotlin.Function1,kotlin.Function1,kotlin.Function1)) or [androidx.wear.compose.material3.RadioButton](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#RadioButton(kotlin.Boolean,kotlin.Function0,androidx.compose.ui.Modifier,kotlin.Boolean,androidx.compose.ui.graphics.Shape,androidx.wear.compose.material3.RadioButtonColors,androidx.compose.foundation.layout.PaddingValues,androidx.compose.foundation.interaction.MutableInteractionSource,androidx.wear.compose.material3.SurfaceTransformation,kotlin.Function1,kotlin.Function1,kotlin.Function1)) or [androidx.wear.compose.material3.SwitchButton](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#SwitchButton(kotlin.Boolean,kotlin.Function1,androidx.compose.ui.Modifier,kotlin.Boolean,androidx.compose.ui.graphics.Shape,androidx.wear.compose.material3.SwitchButtonColors,androidx.compose.foundation.layout.PaddingValues,androidx.compose.foundation.interaction.MutableInteractionSource,kotlin.Function1,kotlin.Function1,kotlin.Function1)) |
| [androidx.wear.compose.material.Vignette](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/package-summary#Vignette(androidx.wear.compose.material.VignettePosition,androidx.compose.ui.Modifier)) | Removed as not included in Material 3 Expressive design for Wear OS |

Here is a full list of all the Material 3 components:

| Material 3 | Material 2.5 equivalent component (if not new in M3) |
|---|---|
| [androidx.wear.compose.material3.AlertDialog](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#AlertDialog(kotlin.Boolean,kotlin.Function0,kotlin.Function0,androidx.compose.ui.Modifier,kotlin.Function0,kotlin.Function0,androidx.compose.foundation.layout.Arrangement.Vertical,androidx.compose.foundation.layout.PaddingValues,androidx.compose.ui.window.DialogProperties,kotlin.Function1)) | [androidx.wear.compose.material.dialog.Alert](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/dialog/package-summary#Alert(kotlin.Function1,androidx.compose.ui.Modifier,kotlin.Function1,kotlin.Function1,androidx.wear.compose.foundation.lazy.ScalingLazyListState,androidx.compose.ui.graphics.Color,androidx.compose.ui.graphics.Color,androidx.compose.ui.graphics.Color,androidx.compose.ui.graphics.Color,androidx.compose.foundation.layout.Arrangement.Vertical,androidx.compose.foundation.layout.PaddingValues,kotlin.Function1)) |
| [androidx.wear.compose.material3.AnimatedPage](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#AnimatedPage(kotlin.Int,androidx.wear.compose.foundation.pager.PagerState,androidx.compose.ui.graphics.Color,kotlin.Function0)) | New |
| [androidx.wear.compose.material3.AnimatedText](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#AnimatedText(kotlin.String,androidx.wear.compose.material3.AnimatedTextFontRegistry,kotlin.Function0,androidx.compose.ui.Modifier,androidx.compose.ui.Alignment)) | New |
| [androidx.wear.compose.material3.AppScaffold](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#AppScaffold(androidx.compose.ui.Modifier,kotlin.Function0,kotlin.Function1)) | [android.wear.compose.material.Scaffold](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/package-summary#Scaffold(androidx.compose.ui.Modifier,kotlin.Function0,kotlin.Function0,kotlin.Function0,kotlin.Function0,kotlin.Function0)) (with [androidx.wear.compose.material3.ScreenScaffold](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#ScreenScaffold(androidx.compose.ui.Modifier,kotlin.Function0,androidx.wear.compose.foundation.ScrollInfoProvider,kotlin.Function1,kotlin.Function1)) ) |
| [androidx.wear.compose.material3.Button](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#Button(kotlin.Function0,androidx.compose.ui.Modifier,kotlin.Function0,kotlin.String,kotlin.Boolean,androidx.compose.ui.graphics.Shape,androidx.wear.compose.material3.ButtonColors,androidx.compose.foundation.BorderStroke,androidx.compose.foundation.layout.PaddingValues,androidx.compose.foundation.interaction.MutableInteractionSource,kotlin.Function1)) | [androidx.wear.compose.material.Chip](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/package-summary#Chip(kotlin.Function0,androidx.wear.compose.material.ChipColors,androidx.wear.compose.material.ChipBorder,androidx.compose.ui.Modifier,kotlin.Boolean,androidx.compose.foundation.layout.PaddingValues,androidx.compose.ui.graphics.Shape,androidx.compose.foundation.interaction.MutableInteractionSource,androidx.compose.ui.semantics.Role,kotlin.Function1)) |
| [androidx.wear.compose.material3.ButtonGroup](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#ButtonGroup(androidx.compose.ui.Modifier,androidx.compose.ui.unit.Dp,androidx.compose.ui.unit.Dp,androidx.compose.foundation.layout.PaddingValues,androidx.compose.ui.Alignment.Vertical,kotlin.Function1)) | New |
| [androidx.wear.compose.material3.Card](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#Card(kotlin.Function0,androidx.compose.ui.Modifier,kotlin.Function0,kotlin.String,kotlin.Boolean,androidx.compose.ui.graphics.Shape,androidx.wear.compose.material3.CardColors,androidx.compose.foundation.BorderStroke,androidx.compose.foundation.layout.PaddingValues,androidx.compose.foundation.interaction.MutableInteractionSource,kotlin.Function1)) | [androidx.wear.compose.material.Card](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/package-summary#Card(kotlin.Function0,androidx.compose.ui.Modifier,androidx.compose.ui.graphics.painter.Painter,androidx.compose.ui.graphics.Color,kotlin.Boolean,androidx.compose.foundation.layout.PaddingValues,androidx.compose.ui.graphics.Shape,androidx.compose.foundation.interaction.MutableInteractionSource,androidx.compose.ui.semantics.Role,kotlin.Function1)) |
| [androidx.wear.compose.material3.CheckboxButton](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#CheckboxButton(kotlin.Boolean,kotlin.Function1,androidx.compose.ui.Modifier,kotlin.Boolean,androidx.compose.ui.graphics.Shape,androidx.wear.compose.material3.CheckboxButtonColors,androidx.compose.foundation.layout.PaddingValues,androidx.compose.foundation.interaction.MutableInteractionSource,kotlin.Function1,kotlin.Function1,kotlin.Function1)) | [androidx.wear.compose.material.ToggleChip](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/package-summary#ToggleChip(kotlin.Boolean,kotlin.Function1,kotlin.Function1,kotlin.Function0,androidx.compose.ui.Modifier,kotlin.Function1,kotlin.Function1,androidx.wear.compose.material.ToggleChipColors,kotlin.Boolean,androidx.compose.foundation.interaction.MutableInteractionSource,androidx.compose.foundation.layout.PaddingValues,androidx.compose.ui.graphics.Shape)) with a checkbox toggle control |
| [androidx.wear.compose.material3.ChildButton](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#ChildButton(kotlin.Function0,androidx.compose.ui.Modifier,kotlin.Function0,kotlin.String,kotlin.Boolean,androidx.compose.ui.graphics.Shape,androidx.wear.compose.material3.ButtonColors,androidx.compose.foundation.BorderStroke,androidx.compose.foundation.layout.PaddingValues,androidx.compose.foundation.interaction.MutableInteractionSource,kotlin.Function1)) | [androidx.wear.compose.material.Chip](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/package-summary#Chip(kotlin.Function0,androidx.wear.compose.material.ChipColors,androidx.wear.compose.material.ChipBorder,androidx.compose.ui.Modifier,kotlin.Boolean,androidx.compose.foundation.layout.PaddingValues,androidx.compose.ui.graphics.Shape,androidx.compose.foundation.interaction.MutableInteractionSource,androidx.compose.ui.semantics.Role,kotlin.Function1)) (only when no background is required) |
| [androidx.wear.compose.material3.CircularProgressIndicator](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#CircularProgressIndicator(androidx.compose.ui.Modifier,androidx.wear.compose.material3.ProgressIndicatorColors,androidx.compose.ui.unit.Dp,androidx.compose.ui.unit.Dp)) | [androidx.wear.compose.material.CircularProgressIndicator](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/package-summary#CircularProgressIndicator(androidx.compose.ui.Modifier,kotlin.Float,androidx.compose.ui.graphics.Color,androidx.compose.ui.graphics.Color,androidx.compose.ui.unit.Dp)) |
| [androidx.wear.compose.material3.CompactButton](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#CompactButton(kotlin.Function0,androidx.compose.ui.Modifier,kotlin.Function0,kotlin.String,kotlin.Function1,kotlin.Boolean,androidx.compose.ui.graphics.Shape,androidx.wear.compose.material3.ButtonColors,androidx.compose.foundation.BorderStroke,androidx.compose.foundation.layout.PaddingValues,androidx.compose.foundation.interaction.MutableInteractionSource,kotlin.Function1)) | [androidx.wear.compose.material.CompactChip](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/package-summary#CompactChip(kotlin.Function0,androidx.compose.ui.Modifier,kotlin.Function1,kotlin.Function1,androidx.wear.compose.material.ChipColors,kotlin.Boolean,androidx.compose.foundation.interaction.MutableInteractionSource,androidx.compose.foundation.layout.PaddingValues,androidx.compose.ui.graphics.Shape,androidx.wear.compose.material.ChipBorder)) |
| [androidx.wear.compose.material3.ConfirmationDialog](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#ConfirmationDialog(kotlin.Boolean,kotlin.Function0,kotlin.Function1,androidx.compose.ui.Modifier,androidx.wear.compose.material3.ConfirmationDialogColors,androidx.compose.ui.window.DialogProperties,kotlin.Long,kotlin.Function0)) | [androidx.wear.compose.material.dialog.Confirmation](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/dialog/package-summary#Confirmation(kotlin.Function0,androidx.compose.ui.Modifier,kotlin.Function1,androidx.wear.compose.foundation.lazy.ScalingLazyListState,kotlin.Long,androidx.compose.ui.graphics.Color,androidx.compose.ui.graphics.Color,androidx.compose.ui.graphics.Color,androidx.compose.foundation.layout.Arrangement.Vertical,androidx.compose.foundation.layout.PaddingValues,kotlin.Function1)) |
| [androidx.wear.compose.material3.curvedText](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#(androidx.wear.compose.foundation.CurvedScope).curvedText(kotlin.String,androidx.wear.compose.foundation.CurvedModifier,kotlin.Float,androidx.compose.ui.graphics.Color,androidx.compose.ui.graphics.Color,androidx.compose.ui.unit.TextUnit,androidx.compose.ui.text.font.FontFamily,androidx.compose.ui.text.font.FontWeight,androidx.compose.ui.text.font.FontStyle,androidx.compose.ui.text.font.FontSynthesis,androidx.wear.compose.foundation.CurvedTextStyle,androidx.wear.compose.foundation.CurvedDirection.Angular,androidx.compose.ui.text.style.TextOverflow)) | [androidx.wear.compose.material.curvedText](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/package-summary#(androidx.wear.compose.foundation.CurvedScope).curvedText(kotlin.String,androidx.wear.compose.foundation.CurvedModifier,androidx.compose.ui.graphics.Color,androidx.compose.ui.graphics.Color,androidx.compose.ui.unit.TextUnit,androidx.compose.ui.text.font.FontFamily,androidx.compose.ui.text.font.FontWeight,androidx.compose.ui.text.font.FontStyle,androidx.compose.ui.text.font.FontSynthesis,androidx.wear.compose.foundation.CurvedTextStyle,androidx.wear.compose.foundation.CurvedDirection.Angular,androidx.compose.ui.text.style.TextOverflow)) |
| [androidx.wear.compose.material3.DatePicker](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#DatePicker(java.time.LocalDate,kotlin.Function1,androidx.compose.ui.Modifier,java.time.LocalDate,java.time.LocalDate,androidx.wear.compose.material3.DatePickerType,androidx.wear.compose.material3.DatePickerColors)) | New |
| [androidx.wear.compose.material3.Dialog](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#Dialog(kotlin.Boolean,kotlin.Function0,androidx.compose.ui.Modifier,androidx.compose.ui.window.DialogProperties,kotlin.Function0)) | [androidx.wear.compose.material.dialog.Dialog](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/dialog/package-summary#Dialog(kotlin.Boolean,kotlin.Function0,androidx.compose.ui.Modifier,androidx.wear.compose.foundation.lazy.ScalingLazyListState,androidx.compose.ui.window.DialogProperties,kotlin.Function0)) |
| [androidx.wear.compose.material3.EdgeButton](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#EdgeButton(kotlin.Function0,androidx.compose.ui.Modifier,androidx.wear.compose.material3.EdgeButtonSize,kotlin.Boolean,androidx.wear.compose.material3.ButtonColors,androidx.compose.foundation.BorderStroke,androidx.compose.foundation.interaction.MutableInteractionSource,kotlin.Function1)) | New |
| [androidx.wear.compose.material3.FadingExpandingLabel](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#FadingExpandingLabel(kotlin.String,androidx.compose.ui.Modifier,androidx.compose.ui.graphics.Color,androidx.compose.ui.unit.TextUnit,androidx.compose.ui.text.font.FontStyle,androidx.compose.ui.text.font.FontWeight,androidx.compose.ui.text.font.FontFamily,androidx.compose.ui.unit.TextUnit,androidx.compose.ui.text.style.TextDecoration,androidx.compose.ui.text.style.TextAlign,androidx.compose.ui.unit.TextUnit,kotlin.Boolean,kotlin.Int,kotlin.Int,androidx.compose.ui.text.TextStyle,androidx.compose.animation.core.FiniteAnimationSpec)) | New |
| [androidx.wear.compose.material3.FilledTonalButton](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#FilledTonalButton(kotlin.Function0,androidx.compose.ui.Modifier,kotlin.Function0,kotlin.String,kotlin.Boolean,androidx.compose.ui.graphics.Shape,androidx.wear.compose.material3.ButtonColors,androidx.compose.foundation.BorderStroke,androidx.compose.foundation.layout.PaddingValues,androidx.compose.foundation.interaction.MutableInteractionSource,kotlin.Function1)) | [androidx.wear.compose.material.Chip](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/package-summary#Chip(kotlin.Function0,androidx.wear.compose.material.ChipColors,androidx.wear.compose.material.ChipBorder,androidx.compose.ui.Modifier,kotlin.Boolean,androidx.compose.foundation.layout.PaddingValues,androidx.compose.ui.graphics.Shape,androidx.compose.foundation.interaction.MutableInteractionSource,androidx.compose.ui.semantics.Role,kotlin.Function1)) when a tonal button background is required |
| [androidx.wear.compose.material3.HorizontalPageIndicator](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#HorizontalPageIndicator(androidx.wear.compose.foundation.pager.PagerState,androidx.compose.ui.Modifier,androidx.compose.ui.graphics.Color,androidx.compose.ui.graphics.Color,androidx.compose.ui.graphics.Color)) | [androidx.wear.compose.material.HorizontalPageIndicator](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/package-summary#HorizontalPageIndicator(androidx.wear.compose.material.PageIndicatorState,androidx.compose.ui.Modifier,androidx.wear.compose.material.PageIndicatorStyle,androidx.compose.ui.graphics.Color,androidx.compose.ui.graphics.Color,androidx.compose.ui.unit.Dp,androidx.compose.ui.unit.Dp,androidx.compose.ui.graphics.Shape)) |
| [androidx.wear.compose.material3.HorizontalPagerScaffold](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#HorizontalPagerScaffold(androidx.wear.compose.foundation.pager.PagerState,androidx.compose.ui.Modifier,kotlin.Function1,androidx.compose.animation.core.AnimationSpec,androidx.wear.compose.foundation.rotary.RotaryScrollableBehavior,kotlin.Function2)) | New |
| [androidx.wear.compose.material3.Icon](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#Icon(androidx.compose.ui.graphics.ImageBitmap,kotlin.String,androidx.compose.ui.Modifier,androidx.compose.ui.graphics.Color)) | [androidx.wear.compose.material.Icon](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/package-summary#Icon(androidx.compose.ui.graphics.ImageBitmap,kotlin.String,androidx.compose.ui.Modifier,androidx.compose.ui.graphics.Color)) |
| [androidx.wear.compose.material3.IconButton](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#IconButton(kotlin.Function0,androidx.compose.ui.Modifier,kotlin.Function0,kotlin.String,kotlin.Boolean,androidx.wear.compose.material3.IconButtonShapes,androidx.wear.compose.material3.IconButtonColors,androidx.compose.foundation.BorderStroke,androidx.compose.foundation.interaction.MutableInteractionSource,kotlin.Function1)) | [androidx.wear.compose.material.Button](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/package-summary#Button(kotlin.Function0,androidx.compose.ui.Modifier,kotlin.Boolean,androidx.wear.compose.material.ButtonColors,androidx.compose.foundation.interaction.MutableInteractionSource,androidx.compose.ui.graphics.Shape,androidx.wear.compose.material.ButtonBorder,kotlin.Function1)) |
| [androidx.wear.compose.material3.IconToggleButton](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#IconToggleButton(kotlin.Boolean,kotlin.Function1,androidx.compose.ui.Modifier,kotlin.Boolean,androidx.wear.compose.material3.IconToggleButtonColors,androidx.compose.foundation.interaction.MutableInteractionSource,androidx.wear.compose.material3.IconToggleButtonShapes,androidx.compose.foundation.BorderStroke,kotlin.Function1)) | [androidx.wear.compose.material.ToggleButton](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/package-summary#ToggleButton(kotlin.Boolean,kotlin.Function1,androidx.compose.ui.Modifier,kotlin.Boolean,androidx.wear.compose.material.ToggleButtonColors,androidx.compose.foundation.interaction.MutableInteractionSource,androidx.compose.ui.graphics.Shape,androidx.compose.ui.semantics.Role,kotlin.Function1)) |
| [androidx.wear.compose.material3.LevelIndicator](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#LevelIndicator(kotlin.Function0,androidx.compose.ui.Modifier,kotlin.ranges.ClosedFloatingPointRange,kotlin.Boolean,androidx.wear.compose.material3.LevelIndicatorColors,androidx.compose.ui.unit.Dp,kotlin.Float,kotlin.Boolean)) | New |
| [androidx.wear.compose.material3.LinearProgressIndicator](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#LinearProgressIndicator(kotlin.Function0,androidx.compose.ui.Modifier,androidx.wear.compose.material3.ProgressIndicatorColors,androidx.compose.ui.unit.Dp,kotlin.Boolean)) | New |
| [androidx.wear.compose.material3.ListHeader](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#ListHeader(androidx.compose.ui.Modifier,androidx.compose.ui.graphics.Color,androidx.compose.ui.graphics.Color,androidx.compose.foundation.layout.PaddingValues,kotlin.Function1)) | [androidx.wear.compose.material.ListHeader](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/package-summary#ListHeader(androidx.compose.ui.Modifier,androidx.compose.ui.graphics.Color,androidx.compose.ui.graphics.Color,kotlin.Function1)) |
| [androidx.wear.compose.material3.ListSubHeader](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#ListSubHeader(androidx.compose.ui.Modifier,androidx.compose.ui.graphics.Color,androidx.compose.ui.graphics.Color,androidx.compose.foundation.layout.PaddingValues,kotlin.Function1,kotlin.Function1)) | New |
| [androidx.wear.compose.material3.MaterialTheme](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#MaterialTheme(androidx.wear.compose.material3.ColorScheme,androidx.wear.compose.material3.Typography,androidx.wear.compose.material3.Shapes,androidx.wear.compose.material3.MotionScheme,kotlin.Function0)) | [androidx.wear.compose.material.MaterialTheme](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/package-summary#MaterialTheme(androidx.wear.compose.material.Colors,androidx.wear.compose.material.Typography,androidx.wear.compose.material.Shapes,kotlin.Function0)) |
| [androidx.wear.compose.material3.OpenOnPhoneDialog](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#OpenOnPhoneDialog(kotlin.Boolean,kotlin.Function0,androidx.compose.ui.Modifier,kotlin.Function1,androidx.wear.compose.material3.OpenOnPhoneDialogColors,androidx.compose.ui.window.DialogProperties,kotlin.Long,kotlin.Function1)) | New |
| [androidx.wear.compose.material3.Picker](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#Picker(androidx.wear.compose.material3.PickerState,kotlin.String,androidx.compose.ui.Modifier,kotlin.Boolean,kotlin.Function1,kotlin.Function0,androidx.compose.ui.unit.Dp,kotlin.Float,androidx.compose.ui.graphics.Color,kotlin.Boolean,androidx.wear.compose.foundation.rotary.RotaryScrollableBehavior,kotlin.Function2)) | [androidx.wear.compose.material.Picker](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/package-summary#Picker(androidx.wear.compose.material.PickerState,kotlin.String,androidx.compose.ui.Modifier,kotlin.Boolean,kotlin.Function1,kotlin.Function0,androidx.wear.compose.foundation.lazy.ScalingParams,androidx.compose.ui.unit.Dp,kotlin.Float,androidx.compose.ui.graphics.Color,androidx.compose.foundation.gestures.FlingBehavior,kotlin.Boolean,androidx.wear.compose.foundation.rotary.RotaryScrollableBehavior,kotlin.Function2)) |
| [androidx.wear.compose.material3.PickerGroup](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#PickerGroup(kotlin.Int,kotlin.Function1,androidx.compose.ui.Modifier,kotlin.Boolean,kotlin.Function1,kotlin.Boolean,kotlin.Function1)) | [androidx.wear.compose.material.PickerGroup](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/package-summary#PickerGroup(kotlin.Array,androidx.compose.ui.Modifier,androidx.wear.compose.material.PickerGroupState,kotlin.Function1,kotlin.Boolean,kotlin.Boolean,androidx.wear.compose.material.TouchExplorationStateProvider,kotlin.Function1)) |
| [androidx.wear.compose.material3.RadioButton](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#RadioButton(kotlin.Boolean,kotlin.Function0,androidx.compose.ui.Modifier,kotlin.Boolean,androidx.compose.ui.graphics.Shape,androidx.wear.compose.material3.RadioButtonColors,androidx.compose.foundation.layout.PaddingValues,androidx.compose.foundation.interaction.MutableInteractionSource,androidx.wear.compose.material3.SurfaceTransformation,kotlin.Function1,kotlin.Function1,kotlin.Function1)) | [androidx.wear.compose.material.ToggleChip](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/package-summary#ToggleChip(kotlin.Boolean,kotlin.Function1,kotlin.Function1,kotlin.Function0,androidx.compose.ui.Modifier,kotlin.Function1,kotlin.Function1,androidx.wear.compose.material.ToggleChipColors,kotlin.Boolean,androidx.compose.foundation.interaction.MutableInteractionSource,androidx.compose.foundation.layout.PaddingValues,androidx.compose.ui.graphics.Shape)) with a radio button toggle control |
| [androidx.wear.compose.material3.ScreenScaffold](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#ScreenScaffold(androidx.compose.ui.Modifier,kotlin.Function0,androidx.wear.compose.foundation.ScrollInfoProvider,kotlin.Function1,kotlin.Function1)) | [android.wear.compose.material.Scaffold](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/package-summary#Scaffold(androidx.compose.ui.Modifier,kotlin.Function0,kotlin.Function0,kotlin.Function0,kotlin.Function0,kotlin.Function0)) (with [androidx.wear.compose.material3.AppScaffold](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#AppScaffold(androidx.compose.ui.Modifier,kotlin.Function0,kotlin.Function1))) |
| [androidx.wear.compose.material3.ScrollIndicator](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#ScrollIndicator(androidx.compose.foundation.lazy.LazyListState,androidx.compose.ui.Modifier,kotlin.Boolean,androidx.compose.animation.core.AnimationSpec)) | [androidx.wear.compose.material.PositionIndicator](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/package-summary#PositionIndicator(androidx.compose.foundation.lazy.LazyListState,androidx.compose.ui.Modifier,kotlin.Boolean,androidx.compose.animation.core.AnimationSpec,androidx.compose.animation.core.AnimationSpec,androidx.compose.animation.core.AnimationSpec)) |
| [androidx.wear.compose.material3.scrollAway](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#(androidx.compose.ui.Modifier).scrollAway(androidx.wear.compose.foundation.ScrollInfoProvider,kotlin.Function0)) | [androidx.wear.compose.material.scrollAway](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/package-summary#(androidx.compose.ui.Modifier).scrollAway(androidx.compose.foundation.lazy.LazyListState,kotlin.Int,androidx.compose.ui.unit.Dp)) |
| [androidx.wear.compose.material3.SegmentedCircularProgressIndicator](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#SegmentedCircularProgressIndicator(kotlin.Int,kotlin.Function1,androidx.compose.ui.Modifier,kotlin.Float,kotlin.Float,androidx.wear.compose.material3.ProgressIndicatorColors,androidx.compose.ui.unit.Dp,androidx.compose.ui.unit.Dp,kotlin.Boolean)) | New |
| [androidx.wear.compose.material3.Slider](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#Slider(kotlin.Int,kotlin.Function1,kotlin.ranges.IntProgression,androidx.compose.ui.Modifier,kotlin.Function0,kotlin.Function0,kotlin.Boolean,kotlin.Boolean,androidx.compose.ui.graphics.Shape,androidx.wear.compose.material3.SliderColors)) | [androidx.wear.compose.material.InlineSlider](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/package-summary#InlineSlider(kotlin.Int,kotlin.Function1,kotlin.ranges.IntProgression,kotlin.Function0,kotlin.Function0,androidx.compose.ui.Modifier,kotlin.Boolean,kotlin.Boolean,androidx.wear.compose.material.InlineSliderColors)) |
| [androidx.wear.compose.material3.SplitRadioButton](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#SplitRadioButton(kotlin.Boolean,kotlin.Function0,kotlin.String,kotlin.Function0,androidx.compose.ui.Modifier,kotlin.Boolean,androidx.compose.ui.graphics.Shape,androidx.wear.compose.material3.SplitRadioButtonColors,androidx.compose.foundation.interaction.MutableInteractionSource,androidx.compose.foundation.interaction.MutableInteractionSource,kotlin.String,androidx.compose.foundation.layout.PaddingValues,kotlin.Function1,kotlin.Function1)) | [androidx.wear.compose.material.SplitToggleChip](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/package-summary#SplitToggleChip(kotlin.Boolean,kotlin.Function1,kotlin.Function1,kotlin.Function0,kotlin.Function1,androidx.compose.ui.Modifier,kotlin.Function1,androidx.wear.compose.material.SplitToggleChipColors,kotlin.Boolean,androidx.compose.foundation.interaction.MutableInteractionSource,androidx.compose.foundation.interaction.MutableInteractionSource,androidx.compose.foundation.layout.PaddingValues,androidx.compose.ui.graphics.Shape)) |
| [androidx.wear.compose.material3.SplitCheckboxButton](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#SplitCheckboxButton(kotlin.Boolean,kotlin.Function1,kotlin.String,kotlin.Function0,androidx.compose.ui.Modifier,kotlin.Boolean,androidx.compose.ui.graphics.Shape,androidx.wear.compose.material3.SplitCheckboxButtonColors,androidx.compose.foundation.interaction.MutableInteractionSource,androidx.compose.foundation.interaction.MutableInteractionSource,kotlin.String,androidx.compose.foundation.layout.PaddingValues,kotlin.Function1,kotlin.Function1)) | [androidx.wear.compose.material.SplitToggleChip](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/package-summary#SplitToggleChip(kotlin.Boolean,kotlin.Function1,kotlin.Function1,kotlin.Function0,kotlin.Function1,androidx.compose.ui.Modifier,kotlin.Function1,androidx.wear.compose.material.SplitToggleChipColors,kotlin.Boolean,androidx.compose.foundation.interaction.MutableInteractionSource,androidx.compose.foundation.interaction.MutableInteractionSource,androidx.compose.foundation.layout.PaddingValues,androidx.compose.ui.graphics.Shape)) |
| [androidx.wear.compose.material3.SplitSwitchButton](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#SplitSwitchButton(kotlin.Boolean,kotlin.Function1,kotlin.String,kotlin.Function0,androidx.compose.ui.Modifier,kotlin.Boolean,androidx.compose.ui.graphics.Shape,androidx.wear.compose.material3.SplitSwitchButtonColors,androidx.compose.foundation.interaction.MutableInteractionSource,androidx.compose.foundation.interaction.MutableInteractionSource,androidx.wear.compose.material3.SurfaceTransformation,kotlin.String,androidx.compose.foundation.layout.PaddingValues,kotlin.Function1,kotlin.Function1)) | [androidx.wear.compose.material.SplitToggleChip](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/package-summary#SplitToggleChip(kotlin.Boolean,kotlin.Function1,kotlin.Function1,kotlin.Function0,kotlin.Function1,androidx.compose.ui.Modifier,kotlin.Function1,androidx.wear.compose.material.SplitToggleChipColors,kotlin.Boolean,androidx.compose.foundation.interaction.MutableInteractionSource,androidx.compose.foundation.interaction.MutableInteractionSource,androidx.compose.foundation.layout.PaddingValues,androidx.compose.ui.graphics.Shape)) |
| [androidx.wear.compose.material3.Stepper](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#Stepper(kotlin.Int,kotlin.Function1,kotlin.ranges.IntProgression,kotlin.Function0,kotlin.Function0,androidx.compose.ui.Modifier,kotlin.Boolean,androidx.wear.compose.material3.StepperColors,kotlin.Function1)) | [androidx.wear.compose.material.Stepper](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/package-summary#Stepper(kotlin.Int,kotlin.Function1,kotlin.ranges.IntProgression,kotlin.Function0,kotlin.Function0,androidx.compose.ui.Modifier,androidx.compose.ui.graphics.Color,androidx.compose.ui.graphics.Color,androidx.compose.ui.graphics.Color,kotlin.Boolean,kotlin.Function1)) |
| [androidx.wear.compose.material3.SwipeToDismissBox](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#SwipeToDismissBox(androidx.wear.compose.foundation.SwipeToDismissBoxState,androidx.compose.ui.Modifier,androidx.compose.ui.graphics.Color,androidx.compose.ui.graphics.Color,kotlin.Any,kotlin.Any,kotlin.Boolean,kotlin.Function2)) | [androidx.wear.compose.material.SwipeToDismissBox](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/package-summary#SwipeToDismissBox(androidx.wear.compose.foundation.SwipeToDismissBoxState,androidx.compose.ui.Modifier,androidx.compose.ui.graphics.Color,androidx.compose.ui.graphics.Color,kotlin.Any,kotlin.Any,kotlin.Boolean,kotlin.Function2)) |
| [androidx.wear.compose.material3.SwipeToReveal](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#SwipeToReveal(kotlin.Function1,androidx.compose.ui.Modifier,androidx.wear.compose.foundation.RevealState,androidx.compose.ui.unit.Dp,kotlin.Function0)) | [androidx.wear.compose.material.SwipeToRevealCard](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#Stepper(kotlin.Int,kotlin.Function1,kotlin.ranges.IntProgression,kotlin.Function0,kotlin.Function0,androidx.compose.ui.Modifier,kotlin.Boolean,androidx.wear.compose.material3.StepperColors,kotlin.Function1)) and [androidx.wear.compose.material.SwipeToRevealChip](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/package-summary#SwipeToRevealChip(kotlin.Function1,androidx.wear.compose.foundation.RevealState,kotlin.Function0,androidx.compose.ui.Modifier,kotlin.Function1,kotlin.Function1,kotlin.Function1,androidx.wear.compose.material.SwipeToRevealActionColors,androidx.compose.ui.graphics.Shape,kotlin.Function0)) |
| [androidx.wear.compose.material3.SwitchButton](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#SwitchButton(kotlin.Boolean,kotlin.Function1,androidx.compose.ui.Modifier,kotlin.Boolean,androidx.compose.ui.graphics.Shape,androidx.wear.compose.material3.SwitchButtonColors,androidx.compose.foundation.layout.PaddingValues,androidx.compose.foundation.interaction.MutableInteractionSource,kotlin.Function1,kotlin.Function1,kotlin.Function1)) | [androidx.wear.compose.material.ToggleChip](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/package-summary#ToggleChip(kotlin.Boolean,kotlin.Function1,kotlin.Function1,kotlin.Function0,androidx.compose.ui.Modifier,kotlin.Function1,kotlin.Function1,androidx.wear.compose.material.ToggleChipColors,kotlin.Boolean,androidx.compose.foundation.interaction.MutableInteractionSource,androidx.compose.foundation.layout.PaddingValues,androidx.compose.ui.graphics.Shape)) with a switch toggle control |
| [androidx.wear.compose.material3.Text](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#Text(kotlin.String,androidx.compose.ui.Modifier,androidx.compose.ui.graphics.Color,androidx.compose.ui.unit.TextUnit,androidx.compose.ui.text.font.FontStyle,androidx.compose.ui.text.font.FontWeight,androidx.compose.ui.text.font.FontFamily,androidx.compose.ui.unit.TextUnit,androidx.compose.ui.text.style.TextDecoration,androidx.compose.ui.text.style.TextAlign,androidx.compose.ui.unit.TextUnit,androidx.compose.ui.text.style.TextOverflow,kotlin.Boolean,kotlin.Int,kotlin.Int,kotlin.Function1,androidx.compose.ui.text.TextStyle)) | [androidx.wear.compose.material.Text](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/package-summary#Text(kotlin.String,androidx.compose.ui.Modifier,androidx.compose.ui.graphics.Color,androidx.compose.ui.unit.TextUnit,androidx.compose.ui.text.font.FontStyle,androidx.compose.ui.text.font.FontWeight,androidx.compose.ui.text.font.FontFamily,androidx.compose.ui.unit.TextUnit,androidx.compose.ui.text.style.TextDecoration,androidx.compose.ui.text.style.TextAlign,androidx.compose.ui.unit.TextUnit,androidx.compose.ui.text.style.TextOverflow,kotlin.Boolean,kotlin.Int,kotlin.Int,kotlin.Function1,androidx.compose.ui.text.TextStyle)) |
| [androidx.wear.compose.material3.TextButton](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#TextButton(kotlin.Function0,androidx.compose.ui.Modifier,kotlin.Function0,kotlin.String,kotlin.Boolean,androidx.wear.compose.material3.TextButtonShapes,androidx.wear.compose.material3.TextButtonColors,androidx.compose.foundation.BorderStroke,androidx.compose.foundation.interaction.MutableInteractionSource,kotlin.Function1)) | [androidx.wear.compose.material.Button](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/package-summary#Button(kotlin.Function0,androidx.compose.ui.Modifier,kotlin.Boolean,androidx.wear.compose.material.ButtonColors,androidx.compose.foundation.interaction.MutableInteractionSource,androidx.compose.ui.graphics.Shape,androidx.wear.compose.material.ButtonBorder,kotlin.Function1)) |
| [androidx.wear.compose.material3.TextToggleButton](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#TextToggleButton(kotlin.Boolean,kotlin.Function1,androidx.compose.ui.Modifier,kotlin.Boolean,androidx.wear.compose.material3.TextToggleButtonColors,androidx.compose.foundation.interaction.MutableInteractionSource,androidx.wear.compose.material3.TextToggleButtonShapes,androidx.compose.foundation.BorderStroke,kotlin.Function1)) | [androidx.wear.compose.material.ToggleButton](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/package-summary#ToggleButton(kotlin.Boolean,kotlin.Function1,androidx.compose.ui.Modifier,kotlin.Boolean,androidx.wear.compose.material.ToggleButtonColors,androidx.compose.foundation.interaction.MutableInteractionSource,androidx.compose.ui.graphics.Shape,androidx.compose.ui.semantics.Role,kotlin.Function1)) |
| [androidx.wear.compose.material3.TimeText](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#TimeText(androidx.compose.ui.Modifier,androidx.wear.compose.foundation.CurvedModifier,kotlin.Float,androidx.wear.compose.material3.TimeSource,androidx.compose.ui.text.TextStyle,androidx.compose.ui.graphics.Color,androidx.compose.foundation.layout.PaddingValues,kotlin.Function1)) | [androidx.wear.compose.material.TimeText](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/package-summary#TimeText(androidx.compose.ui.Modifier,androidx.wear.compose.material.TimeSource,androidx.compose.ui.text.TextStyle,androidx.compose.foundation.layout.PaddingValues,kotlin.Function0,kotlin.Function1,kotlin.Function0,kotlin.Function1,kotlin.Function0,kotlin.Function1)) |
| [androidx.wear.compose.material3.VerticalPagerScaffold](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#VerticalPagerScaffold(androidx.wear.compose.foundation.pager.PagerState,androidx.compose.ui.Modifier,kotlin.Function1,androidx.compose.animation.core.AnimationSpec,androidx.wear.compose.foundation.rotary.RotaryScrollableBehavior,kotlin.Function2)) | New |

And finally a list of some relevant components from Wear Compose Foundation
library:

| Wear Compose Foundation 1.7.0-alpha05 |   |
|---|---|
| [androidx.wear.compose.foundation.hierarchicalFocusGroup](https://developer.android.com/reference/kotlin/androidx/wear/compose/foundation/package-summary#(androidx.compose.ui.Modifier).hierarchicalFocusGroup(kotlin.Boolean)) | Used to annotate composables in an application, to keep track of the active part of the composition and coordinate focus. |
| [androidx.wear.compose.foundation.pager.HorizontalPager](https://developer.android.com/reference/kotlin/androidx/wear/compose/foundation/pager/package-summary#HorizontalPager(androidx.wear.compose.foundation.pager.PagerState,androidx.compose.ui.Modifier,androidx.compose.foundation.layout.PaddingValues,kotlin.Int,androidx.compose.foundation.gestures.TargetedFlingBehavior,kotlin.Boolean,androidx.wear.compose.foundation.GestureInclusion,kotlin.Boolean,kotlin.Function1,androidx.wear.compose.foundation.rotary.RotaryScrollableBehavior,kotlin.Function2)) | A horizontally scrolling pager, built on the Compose Foundation components with Wear-specific enhancements to improve performance and adherence to Wear OS guidelines. |
| [androidx.wear.compose.foundation.pager.VerticalPager](https://developer.android.com/reference/kotlin/androidx/wear/compose/foundation/pager/package-summary#VerticalPager(androidx.wear.compose.foundation.pager.PagerState,androidx.compose.ui.Modifier,androidx.compose.foundation.layout.PaddingValues,kotlin.Int,androidx.compose.foundation.gestures.TargetedFlingBehavior,kotlin.Boolean,kotlin.Boolean,kotlin.Function1,androidx.wear.compose.foundation.rotary.RotaryScrollableBehavior,kotlin.Function2)) | A vertically scrolling pager, built on the Compose Foundation components with Wear-specific enhancements to improve performance and adherence to Wear OS guidelines. |
| [androidx.wear.compose.foundation.lazy.TransformingLazyColumn](https://developer.android.com/reference/kotlin/androidx/wear/compose/foundation/lazy/package-summary#TransformingLazyColumn(androidx.compose.ui.Modifier,androidx.wear.compose.foundation.lazy.TransformingLazyColumnState,androidx.compose.foundation.layout.PaddingValues,androidx.compose.foundation.layout.Arrangement.Vertical,androidx.compose.ui.Alignment.Horizontal,androidx.compose.foundation.gestures.FlingBehavior,kotlin.Boolean,androidx.wear.compose.foundation.rotary.RotaryScrollableBehavior,androidx.compose.foundation.OverscrollEffect,kotlin.Function1)) | Can be used instead of [`ScalingLazyColumn`](https://developer.android.com/reference/kotlin/androidx/wear/compose/foundation/lazy/package-summary#ScalingLazyColumn(androidx.compose.ui.Modifier,androidx.wear.compose.foundation.lazy.ScalingLazyListState,androidx.compose.foundation.layout.PaddingValues,kotlin.Boolean,androidx.compose.foundation.layout.Arrangement.Vertical,androidx.compose.ui.Alignment.Horizontal,androidx.compose.foundation.gestures.FlingBehavior,kotlin.Boolean,androidx.wear.compose.foundation.lazy.ScalingParams,androidx.wear.compose.foundation.lazy.ScalingLazyListAnchorType,androidx.wear.compose.foundation.lazy.AutoCenteringParams,androidx.wear.compose.foundation.rotary.RotaryScrollableBehavior,androidx.compose.foundation.OverscrollEffect,kotlin.Function1)) to add scroll transform effects to each item. |
|   |   |

### Buttons

Buttons in M3 are different from M2.5. The M2.5 Chip has been replaced by
Button. [`Button`](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#Button(kotlin.Function0,androidx.compose.ui.Modifier,kotlin.Function0,kotlin.String,kotlin.Boolean,androidx.compose.ui.graphics.Shape,androidx.wear.compose.material3.ButtonColors,androidx.compose.foundation.BorderStroke,androidx.compose.foundation.layout.PaddingValues,androidx.compose.foundation.interaction.MutableInteractionSource,androidx.wear.compose.material3.SurfaceTransformation,kotlin.Function1)) implementation provides default values for `Text`
`maxLines` and `textAlign`. Those default values can be overridden in the `Text`
element.

### M2.5

    import androidx.wear.compose.material.Chip

    //M2.5 Buttons
    Chip(...)
    CompactChip(...)
    Button(...)

### M3


```kotlin
//M3 Buttons
Button(onClick = { }){}
CompactButton(onClick = { }){}
IconButton(onClick = { }){}
TextButton(onClick = { }){}
```

<br />

M3 also includes new button variations. Check them out on the [Compose Material
3 API reference overview](https://developer.android.com/jetpack/androidx/releases/wear-compose#wear_compose_version_15_2).

M3 introduces a new button: [`EdgeButton`](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#EdgeButton(kotlin.Function0,androidx.compose.ui.Modifier,androidx.wear.compose.material3.EdgeButtonSize,kotlin.Boolean,androidx.wear.compose.material3.ButtonColors,androidx.compose.foundation.BorderStroke,androidx.compose.foundation.interaction.MutableInteractionSource,kotlin.Function1)). `EdgeButton` is available in 4
different sizes: extra small, small, medium, and large. `EdgeButton`
implementation provide a default value for `maxLines` depending on the size
which can be customized.

If you are using `TransformingLazyColumn` or `ScalingLazyColumn`, pass the
`EdgeButton` into the `ScreenScaffold` so that it morphs, changing its shape
with scrolling, instead of adding an `EdgeButton` as the final list item. See
the following code to check how to use `EdgeButton` with `ScreenScaffold` and
`TransformingLazyColumn`.


```kotlin
val state = rememberTransformingLazyColumnState()
ScreenScaffold(
    scrollState = state,
    contentPadding =
        rememberResponsiveColumnPadding(
            first = ColumnItemType.ListHeader
        ),
    edgeButton = {
        EdgeButton(
            onClick = { }
        ) {
            Text(stringResource(R.string.show))
        }
    }
){ contentPadding ->
    TransformingLazyColumn(state = state, contentPadding = contentPadding,){
        // additional code here
    }
}
```

<br />

### Scaffold

Scaffold in M3 is different from M2.5. In M3, `AppScaffold` and the new
`ScreenScaffold` composable have replaced Scaffold. `AppScaffold` and
`ScreenScaffold` lay out the structure of a screen and coordinate transitions of
the `ScrollIndicator` and `TimeText` components.

`AppScaffold` allows static screen elements such as `TimeText` to remain visible
during in-app transitions such as swipe-to-dismiss. ​​It provides a slot for the
main application content, which will usually be supplied by a navigation
component such as `SwipeDismissableNavHost`

You declare one `AppScaffold` for Activity and use a `ScreenScaffold` for each
Screen.
`AppScaffold` adds a default `TimeText`component to the screens. You can
override it if you want to customize it by using the `timeText` parameter.

### M2.5

    import androidx.wear.compose.material.Scaffold

    Scaffold {...}

### M3


```kotlin
    AppScaffold {
        val navController = rememberSwipeDismissableNavController()
        SwipeDismissableNavHost(
            navController = navController,
            startDestination = "message_list"
        ) {
            composable("message_list") {
                MessageList(onMessageClick = { id ->
                    navController.navigate("message_detail/$id")
                })
            }
            composable("message_detail/{id}") {
                MessageDetail(id = it.arguments?.getString("id")!!)
            }
        }
    }
}

// Implementation of one of the screens in the navigation
@Composable
fun MessageDetail(id: String) {
    // .. Screen level content goes here
    val scrollState = rememberTransformingLazyColumnState()

    val padding = rememberResponsiveColumnPadding(
        first = ColumnItemType.BodyText
    )

    ScreenScaffold(
        scrollState = scrollState,
        contentPadding = padding
    ) { scaffoldPaddingValues ->
        // Screen content goes here
        // ...
```

<br />

> [!NOTE]
> **Note:** `AppScaffold` and `ScreenScaffold` from [Horologist](https://github.com/google/horologist) haven't been migrated to M3. To maintain correct scrolling behavior and `TimeText` elements, migrate to the `AppScaffold` and `ScreenScaffold` from M3.

If you are using a `HorizontalPager` with [HorizontalPagerIndicator](https://developer.android.com/reference/kotlin/androidx/wear/compose/material/package-summary#HorizontalPageIndicator(androidx.wear.compose.material.PageIndicatorState,androidx.compose.ui.Modifier,androidx.wear.compose.material.PageIndicatorStyle,androidx.compose.ui.graphics.Color,androidx.compose.ui.graphics.Color,androidx.compose.ui.unit.Dp,androidx.compose.ui.unit.Dp,androidx.compose.ui.graphics.Shape)), you
can migrate to `HorizontalPagerScaffold`. [`HorizontalPagerScaffold`](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#HorizontalPagerScaffold(androidx.wear.compose.foundation.pager.PagerState,androidx.compose.ui.Modifier,kotlin.Function1,androidx.compose.animation.core.AnimationSpec,androidx.wear.compose.foundation.rotary.RotaryScrollableBehavior,kotlin.Function2)) is
placed within an `AppScaffold`. `AppScaffold` and `HorizontalPagerScaffold` lay
out the structure of a Pager and coordinate transitions of the
`HorizontalPageIndicator` and `TimeText` components.

`HorizontalPagerScaffold` displays the `HorizontalPageIndicator` at the
center-end of the screen by default and coordinates showing and hiding
`TimeText` and `HorizontalPageIndicator` according to whether the `Pager` is
being paged, this is determined by the `PagerState`.

There's also a new `AnimatedPage` component, which animates a page within a
Pager with a scaling and scrim effect based on its position.


```kotlin
AppScaffold {
    val pagerState = rememberPagerState(pageCount = { 10 })
    val columnState = rememberTransformingLazyColumnState()
    val contentPadding = rememberResponsiveColumnPadding(
        first = ColumnItemType.ListHeader,
        last = ColumnItemType.BodyText,
    )
    HorizontalPagerScaffold(pagerState = pagerState) {
        HorizontalPager(
            state = pagerState,
        ) { page ->
            AnimatedPage(pageIndex = page, pagerState = pagerState) {
                ScreenScaffold(
                    scrollState = columnState,
                    contentPadding = contentPadding
                ) { contentPadding ->
                    TransformingLazyColumn(
                        state = columnState,
                        contentPadding = contentPadding
                    ) {
                        item {
                            ListHeader(
                                modifier = Modifier.fillMaxWidth()
                            ) {
                                Text(text = "Pager sample")
                            }
                        }
                        item {
                            if (page == 0) {
                                Text(text = "Page #$page. Swipe right")
                            }
                            else{
                                Text(text = "Page #$page. Swipe left and right")
                            }
                        }
                    }
                }

            }
        }
    }
}
```

<br />

Finally, M3 introduces a [`VerticalPagerScaffold`](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#VerticalPagerScaffold(androidx.wear.compose.foundation.pager.PagerState,androidx.compose.ui.Modifier,kotlin.Function1,androidx.compose.animation.core.AnimationSpec,androidx.wear.compose.foundation.rotary.RotaryScrollableBehavior,kotlin.Function2)) which follows the same
pattern as the `HorizontalPagerScaffold`:


```kotlin
AppScaffold {
    val pagerState = rememberPagerState(pageCount = { 10 })

    VerticalPagerScaffold(pagerState = pagerState) {
        VerticalPager(
            state = pagerState
        ) { page ->
            AnimatedPage(pageIndex = page, pagerState = pagerState) {
                ScreenScaffold {
                    ///...
                }
            }
        }
    }
}
```

<br />

### Placeholder

There are some API changes between M2.5 and M3.
`Placeholder.PlaceholderDefaults` now provides two modifiers:

- [`Modifier.placeholder`](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#(androidx.compose.ui.Modifier).placeholder(androidx.wear.compose.material3.PlaceholderState,androidx.compose.ui.graphics.Shape,androidx.compose.ui.graphics.Color)), which is drawn instead of content that is not yet loaded
- A placeholder shimmer effect [`Modifier.placeholderShimmer`](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary#(androidx.compose.ui.Modifier).placeholderShimmer(androidx.wear.compose.material3.PlaceholderState,androidx.compose.ui.graphics.Shape,androidx.compose.ui.graphics.Color)) which provides a placeholder shimmer effect which runs in an animation loop while waiting for the data to load.

See the following table for additional changes to the `Placeholder` component.

| M2.5 | M3 |
|---|---|
| `PlaceholderState.startPlaceholderAnimation` | Has been removed |
| `PlaceholderState.placeholderProgression` | Has been removed |
| `PlaceholderState.isShowContent` | Has been renamed to `!PlaceholderState.isVisible` |
| `PlaceholderState.isWipeOff` | Has been removed |
| `PlaceholderDefaults.painterWithPlaceholderOverlayBackgroundBrush` | Has been removed |
| `PlaceholderDefaults.placeholderBackgroundBrush` | Has been removed |
| `PlaceholderDefaults.placeholderChipColors` | Has been removed |

### SwipeDismissableNavHost

`SwipeDismissableNavHost` is part of `wear.compose.navigation`. When this
component is used with M3, the M3 MaterialTheme updates the
`LocalSwipeToDismissBackgroundScrimColor` and
`LocalSwipeToDismissContentScrimColor`.

### TransformingLazyColumn

`TransformingLazyColumn` is part of `wear.compose.lazy.foundation` and adds
support for scaling and morphing animations on list items during scrolling ,
enhancing the user experience. It is strongly recommended that apps migrate from
`ScalingLazyColumn` to `TransformingLazyColumn`

Similarly to `ScalingLazyColumn`, it provides
`rememberTransformingLazyColumnState()` to create a
`TransformingLazyColumnState` that is remembered across compositions.

For adding scaling and morphing animations, add the following to each list item:

- `Modifier.transformedHeight`, which lets you calculate transformed height of the items using a `TransformationSpec`, you can use `rememberTransformationSpec()` unless you need further customization.
- A `SurfaceTransformation`

To verify that the padding is correct at the top and bottom of the list, use the
`minimumVerticalContentPadding` modifier.


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

## Useful links

To learn more about migrating from M2.5 to M3 in Compose, consult the following
additional resources.

### Samples

- [Wear OS samples on GitHub](https://github.com/android/wear-os-samples/)
- [Compose for Wear OS codelab](https://developer.android.com/codelabs/compose-for-wear-os#0)
- [Jetcaster sample](https://github.com/android/compose-samples/tree/main/Jetcaster)

### API reference and source code

- [Compose Material 3 API reference](https://developer.android.com/reference/kotlin/androidx/wear/compose/material3/package-summary)
- [Compose Material 3 samples in source code](https://cs.android.com/androidx/platform/frameworks/support/+/androidx-main:wear/compose/compose-material3/samples/src/main/java/androidx/wear/compose/material3/samples/)

### Design

- [Design guidance](https://developer.android.com/design/ui/wear/guides/get-started)