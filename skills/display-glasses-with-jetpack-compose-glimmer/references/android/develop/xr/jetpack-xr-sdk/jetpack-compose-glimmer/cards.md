<br />


Applicable XR devices This guidance helps you build experiences for these types of XR devices. [Learn about XR device types →](https://developer.android.com/develop/xr/devices) ![](https://developer.android.com/static/images/develop/xr/ai-glasses-icon.svg) Display Glasses [](https://developer.android.com/develop/xr/devices#audio-display) [Learn about XR device types →](https://developer.android.com/develop/xr/devices)

<br />

In Jetpack Compose Glimmer, the [`Card`](https://developer.android.com/reference/kotlin/androidx/xr/glimmer/Card.composable) component serves as the primary
container for related content, creating a clear visual boundary for digestible
units of information. Cards are highly adaptable, supporting combinations of
main content, optional titles, subtitles, and leading or trailing icons. Cards
fill the maximum available width by default, are focusable, and you can also
make them clickable. Cards support a vertical arrangement where the header image
is top-most, followed by the title, subtitle, and body content.

Cards are built on the Jetpack Compose Glimmer [surface system](https://developer.android.com/develop/xr/jetpack-xr-sdk/jetpack-compose-glimmer/surface), so they
inherit physical properties like depth effects, clipping, and consistent border
highlights.
![](https://developer.android.com/static/images/design/ui/glasses/guides/glasses_components_cards.png) **Figure 1.** An example of some different styles of cards in Jetpack Compose Glimmer.

## Anatomy and slots

A Jetpack Compose Glimmer Card is built from several specialized elements that
let you customize its content and layout.

| Slot | Description |
|---|---|
| Header | The top section of the card, designed to hold an image. |
| Title and subtitle | These text fields provide the main and secondary labels for the card. The title is placed above the subtitle. |
| Leading icon | An optional icon (typically an [`Icon`](https://developer.android.com/reference/kotlin/androidx/xr/glimmer/Icon.composable)) that appears at the beginning of the card's content area. |
| Trailing icon | An optional icon that appears at the end of the card's content area. |
| Action | A slot for a primary interactive element, such as a [`Button`](https://developer.android.com/reference/kotlin/androidx/xr/glimmer/Button.composable). |
| Main content | The core body of the card for primary [`Text`](https://developer.android.com/reference/kotlin/androidx/xr/glimmer/Text.composable) or content. |

## Card defaults

The following defaults apply to cards:

- **Width**: Cards fill the maximum available width of the display to optimize legibility on display glasses.
- **Minimum height** : `80.dp`
- **Text vertical spacing** : `3.dp`
- **Header shape** : Uses [`RoundedCornerShape`](https://developer.android.com/reference/kotlin/androidx/compose/foundation/shape/package-summary#RoundedCornerShape(androidx.compose.ui.unit.Dp)) with `24.dp` corners
- **Content padding** : Defaults to [`GlimmerTheme.componentSpacingValues.medium`](https://developer.android.com/reference/kotlin/androidx/xr/glimmer/ComponentSpacingValues#medium()). This affects the outermost padding around header images and the content container.
- **Shape** : Defaults to [`GlimmerTheme.shapes.medium`](https://developer.android.com/reference/kotlin/androidx/xr/glimmer/Shapes#medium()).
- **Text rendering** : Uses the default values from
  [`GlimmerTheme.typography`](https://developer.android.com/reference/kotlin/androidx/xr/glimmer/GlimmerTheme#typography()) for the following slots:

  - Title: [`bodyMedium`](https://developer.android.com/reference/kotlin/androidx/xr/glimmer/Typography#bodyMedium())
  - Subtitle: [`caption`](https://developer.android.com/reference/kotlin/androidx/xr/glimmer/Typography#caption())
  - Main content: [`bodySmall`](https://developer.android.com/reference/kotlin/androidx/xr/glimmer/Typography#bodySmall())

## Example: Basic card

The following code creates a basic card:


```kotlin
@Composable
fun CardSample() {
    Card { Text("This is a card") }
}
```

<br />

## Example: Complex card with multiple slots

The following code shows how to use multiple slots together to build a card.


```kotlin
@Composable
fun CardWithTitleAndLeadingIconAndHeaderAndAction() {
    Card(
        action = {
            Button(onClick = {}, trailingIcon = { Icon(FavoriteIcon, "Localized description") }) {
                Text("Send")
            }
        },
        title = { Text("Title") },
        leadingIcon = { Icon(FavoriteIcon, "Localized description") },
        header = {
            Image(MyHeaderImage, "Localized description", contentScale = ContentScale.FillWidth)
        },
    ) {
        Text("This is a card with a title, leading icon, header image, and action")
    }
}
```

<br />

### Key points about the code

- Shows how to utilize various card elements, such as [`header`](https://developer.android.com/reference/kotlin/androidx/xr/glimmer/Card.composable), [`title`](https://developer.android.com/reference/kotlin/androidx/xr/glimmer/Card.composable), [`leadingIcon`](https://developer.android.com/reference/kotlin/androidx/xr/glimmer/Card.composable), and [`action`](https://developer.android.com/reference/kotlin/androidx/xr/glimmer/Card.composable), to customize the card's content and structure.
- Uses the standard [`Card`](https://developer.android.com/reference/kotlin/androidx/xr/glimmer/Card.composable#Card(kotlin.Function0,androidx.compose.ui.Modifier,kotlin.Function0,kotlin.Function0,kotlin.Function0,kotlin.Function0,kotlin.Function0,androidx.compose.ui.graphics.Shape,androidx.compose.ui.graphics.Color,androidx.compose.ui.graphics.Color,androidx.compose.foundation.BorderStroke,androidx.compose.foundation.layout.PaddingValues,kotlin.Function0)) overload with an action because only the card (or its internal action) needs to be focusable. If you need to make the entire card surface interactive, use the [`Card`](https://developer.android.com/reference/kotlin/androidx/xr/glimmer/Card.composable#Card(kotlin.Function0,androidx.compose.ui.Modifier,kotlin.Function0,kotlin.Function0,kotlin.Function0,kotlin.Function0,kotlin.Function0,androidx.compose.ui.graphics.Shape,androidx.compose.ui.graphics.Color,androidx.compose.ui.graphics.Color,androidx.compose.foundation.BorderStroke,androidx.compose.foundation.layout.PaddingValues,androidx.compose.foundation.interaction.MutableInteractionSource,kotlin.Function0)) overload with `onClick` instead.
- This card uses an action slot, so the card surface isn't focusable, and focus is directed to the action button instead.