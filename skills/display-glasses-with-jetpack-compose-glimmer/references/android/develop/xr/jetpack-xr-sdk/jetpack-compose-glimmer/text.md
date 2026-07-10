<br />


Applicable XR devices This guidance helps you build experiences for these types of XR devices. [Learn about XR device types →](https://developer.android.com/develop/xr/devices) ![](https://developer.android.com/static/images/develop/xr/ai-glasses-icon.svg) Display Glasses [](https://developer.android.com/develop/xr/devices#audio-display) [Learn about XR device types →](https://developer.android.com/develop/xr/devices)

<br />

In Jetpack Compose Glimmer, the [`Text`](https://developer.android.com/reference/kotlin/androidx/xr/glimmer/Text.composable) component lets you set various text
properties like color, font size, font style, font weight, font family, letter
spacing, and text alignment.

Jetpack Compose Glimmer Text is unique because it intelligently manages color
matching. For example, if no color override is specified, the text defaults to
the content color provided by the nearest surface that it's sitting on.

## Example: Create a text heading in a box

    @Composable
    fun TextSample() {
          Text(
          text = "This is a sample heading",
          style = GlimmerTheme.typography.titleLarge )
    }

### Key points about the code

- Because no color is specified, this text looks at the nearest surface to pick the best readable color (usually white).

## Sizing

Typography scale in Jetpack Compose Glimmer is significantly larger than
standard mobile Material Design. Styles like `TitleLarge` and `BodyLarge` are
both `30.sp`, and the Caption is `18.sp`:

| Style | Size (sp) | Weight | Line Height |
|---|---|---|---|
| titleLarge | 30 | 750 | 36.sp |
| titleMedium | 24 | 750 | 28.sp |
| titleSmall | 20 | 750 | 28.sp |
| bodyLarge | 30 | 520 | 36.sp |
| bodyMedium | 24 | 520 | 36.sp |
| bodySmall | 20 | 520 | 28.sp |
| caption | 18 | 650 | 24.sp |

## Use Google Sans Flex

[Google Sans Flex](https://fonts.google.com/specimen/Google+Sans+Flex?query=google+sans&preview.script=Latn) is a variable font specifically chosen for AI
glasses that is provided as part of the Jetpack Compose Glimmer. The font's
rounded corners and adjustable axes allow for ideal optical sizing, ensuring
that text remains glanceable and legible. If possible, to improve consistency
for users between your app and the system, use Google Sans Flex for all text
displayed on display glasses.

To use Google Sans Flex, [add the `glimmer-google-fonts` library to your app's
dependencies](https://developer.android.com/develop/xr/jetpack-xr-sdk/set-up-sdk#augmented), then apply the font globally to the `GlimmerTheme`:


```kotlin
@Composable
fun GoogleSansFlexTypographySample() {
    val typography = createGoogleSansFlexTypography()
    GlimmerTheme(typography = typography) {
        Text("Hello World", style = GlimmerTheme.typography.titleLarge)
    }
}
```

<br />