<br />


Applicable XR devices This guidance helps you build experiences for these types of XR devices. [Learn about XR device types →](https://developer.android.com/develop/xr/devices) ![](https://developer.android.com/static/images/develop/xr/ai-glasses-icon.svg) Display Glasses [](https://developer.android.com/develop/xr/devices#audio-display) [Learn about XR device types →](https://developer.android.com/develop/xr/devices)

<br />

In Jetpack Compose Glimmer, the [`Icon`](https://developer.android.com/reference/kotlin/androidx/xr/glimmer/Icon.composable) component is a UI element for
rendering single-color icons. Icons intelligently handle tinting and scaling so
that they remain legible and visually consistent with the [`GlimmerTheme`](https://developer.android.com/reference/kotlin/androidx/xr/glimmer/GlimmerTheme.composable).

## Sizes

While icons default to the size provided by [`LocalIconSize`](https://developer.android.com/reference/kotlin/androidx/xr/glimmer/package-summary#LocalIconSize()), you can also
use the three icon sizes provided to set an specific size. These sizes are also
used by default for the following contexts:

| Size token | Default usage |
|---|---|
| `small` | For standard list items or small chips. |
| `medium` | For standalone icons and title chips. |
| `large` | For high-emphasis components like cards. |

## Icon sources

Icons can accept [`ImageVector`](https://developer.android.com/reference/kotlin/androidx/compose/ui/graphics/vector/ImageVector), [`ImageBitmap`](https://developer.android.com/reference/kotlin/androidx/compose/ui/graphics/ImageBitmap), or [`Painter`](https://developer.android.com/reference/kotlin/androidx/compose/ui/graphics/painter/Painter) as
their source. When defining your own icons, use `ImageVector` where possible to
promote sharp rendering at any scale on display glasses.

## Color and Tinting

- **Automatic tint** : The icon resolves its color based on the `LocalContentColor` provided by the parent surface `LocalContentColor` provided by the parent surface, such as a [`surface`](https://developer.android.com/reference/kotlin/androidx/xr/glimmer/surface.composable) or [`Button`](https://developer.android.com/reference/kotlin/androidx/xr/glimmer/Button.composable).
- **Manual Tinting** : Use the `tint` parameter to apply a specific color.
- **Multicolored Assets** : For icons that should not be tinted (like multicolored brand logos), set `tint = Color.Unspecified`.
- **Generic Images** : For photographs or generic images that don't follow icon sizing and tinting rules, use the standard [`androidx.compose.foundation.Image`](https://developer.android.com/reference/kotlin/androidx/compose/foundation/Image.composable) instead.

## Example: Basic icon within a surface

The following code creates an icon placed inside a circular surface, utilizing
the theme's primary color:


```kotlin
@Composable
fun IconSampleUsage() {
    GlimmerLazyColumn(
        modifier = Modifier.fillMaxSize(),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        item { IconSizesSample() }
        item {
            Icon(
                FavoriteIcon,
                "Localized description",
                Modifier.surface(
                        shape = CircleShape,
                        color = GlimmerTheme.colors.primary,
                        border = null,
                    )
                    .padding(12.dp),
            )
        }
    }
}
```

<br />

## Example: Icons with different sizes

The following code demonstrates the different icon sizes:


```kotlin
@Composable
fun IconSizesSample() {
    val iconSizes = GlimmerTheme.iconSizes
    Column(
        verticalArrangement = Arrangement.spacedBy(20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(FavoriteIcon, "Localized description", Modifier.size(iconSizes.small))
        // medium is also the default size, defining explicitly for clarity
        Icon(FavoriteIcon, "Localized description", Modifier.size(iconSizes.medium))
        Icon(FavoriteIcon, "Localized description", Modifier.size(iconSizes.large))
    }
}
```

<br />

### Key points about the code

- Each icon's size is customized using [`GlimmerTheme.iconSizes`](https://developer.android.com/reference/kotlin/androidx/xr/glimmer/IconSizes) with a modifier. For icons, the default value is [`GlimmerTheme.iconSizes.medium`](https://developer.android.com/reference/kotlin/androidx/xr/glimmer/IconSizes#medium()). Use these sizes instead of hard-coding values to maintain consistency across your UI.
- Provides a localized `contentDescription` for each icon. Always provide these descriptions unless the icon is purely decorative.