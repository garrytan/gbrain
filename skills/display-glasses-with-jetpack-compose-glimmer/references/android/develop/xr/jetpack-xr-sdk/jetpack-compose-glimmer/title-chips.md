<br />


Applicable XR devices This guidance helps you build experiences for these types of XR devices. [Learn about XR device types →](https://developer.android.com/develop/xr/devices) ![](https://developer.android.com/static/images/develop/xr/ai-glasses-icon.svg) Display Glasses [](https://developer.android.com/develop/xr/devices#audio-display) [Learn about XR device types →](https://developer.android.com/develop/xr/devices)

<br />

In Jetpack Compose Glimmer, the [`TitleChip`](https://developer.android.com/reference/kotlin/androidx/xr/glimmer/TitleChip.composable) component is a non-interactive
component that provides brief context or labeling for associated content, such
as a [`Card`](https://developer.android.com/reference/kotlin/androidx/xr/glimmer/Card.composable) or a [`VerticalList`](https://developer.android.com/reference/kotlin/androidx/xr/glimmer/list/VerticalList.composable).

Use title chips for concise information like a short title, a category name, or
a status indicator. Normally, you should place title chips above the content
they describe to establish a clear structural relationship.
![](https://developer.android.com/static/images/design/ui/glasses/guides/glasses_components_titlechip_anatomy.png) **Figure 1.** An example of a default style title chip and sticky title chip in Jetpack Compose Glimmer. Each title chip has a label (1) and an optional leading icon or entity (2).

## Basic example: Create a short title chip

The following code creates a basic title chip:


```kotlin
@Composable
fun TitleChipSample() {
    TitleChip { Text("Messages") }
}
```

<br />

## Example: Create a title chip with a card

To use a title chip with another component, place the title chip
[`TitleChipDefaults.associatedContentSpacing`](https://developer.android.com/reference/kotlin/androidx/xr/glimmer/TitleChipDefaults#associatedContentSpacing()) above the other component in
the composable. The following code creates a title chip with a card:


```kotlin
@Composable
fun TitleChipWithCardSample() {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        TitleChip { Text("Title Chip") }
        Spacer(Modifier.height(TitleChipDefaults.associatedContentSpacing))
        Card(
            title = { Text("Title") },
            subtitle = { Text("Subtitle") },
            leadingIcon = { Icon(FavoriteIcon, "Localized description") },
        ) {
            Text("Card Content")
        }
    }
}
```

<br />

### Key points about the code

- The title chip is centered horizontally, which is the usual alignment for a title chip placed above a card.
- The [`Spacer`](https://developer.android.com/reference/kotlin/androidx/compose/foundation/layout/Spacer.composable#Spacer(androidx.compose.ui.Modifier)) has a fixed height to provide the right amount of vertical spacing between the two components. This is defined using [`TitleChipDefaults.associatedContentSpacing`](https://developer.android.com/reference/kotlin/androidx/xr/glimmer/TitleChipDefaults#associatedContentSpacing()).
- Uses an optional `leadingIcon` to add additional visual context before the text content.
- The title chip automatically uses the [`caption`](https://developer.android.com/reference/kotlin/androidx/xr/glimmer/Typography#caption()) style for its text.
- The title chip isn't interactive. If you need a clickable label, use a [`Button`](https://developer.android.com/reference/kotlin/androidx/xr/glimmer/Button.composable) or another interactive component.