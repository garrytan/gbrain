<br />

The Styles API offers a declarative and streamlined approach to managing UI
changes during interaction states like `hovered`, `focused`, and `pressed`. With
this API, you can significantly decrease the boilerplate code typically required
when using modifiers.

To facilitate reactive styling, `StyleState` acts as a stable, read-only
interface that tracks the active state of an element (such as its enabled,
pressed, or focused status). Within a `StyleScope`, you can access this through
the `state` property to implement conditional logic directly in your Style
definitions.

## State-based interaction: Hovered, focused, pressed, selected, enabled, toggled

Styles come with built-in support for common interactions:

- Pressed
- Hovered
- Selected
- Enabled
- Toggled

It's also possible to support custom states. See the [Custom State Styling with
StyleState](https://developer.android.com/develop/ui/compose/styles/state-animations#custom-state) section for more information.

### Handle interaction states with Style parameters

The following example demonstrates modifying the `background` and `borderColor`
in response to interaction states, specifically switching to purple when hovered
and blue when focused:


```kotlin
@Preview
@Composable
private fun OpenButton() {
    BaseButton(
        style = outlinedButtonStyle then {
            background(Color.White)
            hovered {
                background(lightPurple)
                border(2.dp, lightPurple)
            }
            focused {
                background(lightBlue)
            }
        },
        onClick = {  },
        content = {
            BaseText("Open in Studio", style = {
                contentColor(Color.Black)
                fontSize(26.sp)
                textAlign(TextAlign.Center)
            })
        }
    )
}
```

<br />

**Figure 1.** Changing background color based on hovered and focused states.

You can also create nested state definitions. For example, you can define a
specific style for when a button is being both pressed and hovered
simultaneously:


```kotlin
@Composable
private fun OpenButton_CombinedStates() {
    BaseButton(
        style = outlinedButtonStyle then {
            background(Color.White)
            hovered {
                // light purple
                background(lightPurple)
                pressed {
                    // When running on a device that can hover, whilst hovering and then pressing the button this would be invoked
                    background(lightOrange)
                }
            }
            pressed {
                // when running on a device without a mouse attached, this would be invoked as you wouldn't be in a hovered state only
                background(lightRed)
            }
            focused {
                background(lightBlue)
            }
        },
        onClick = {  },
        content = {
            BaseText("Open in Studio", style = {
                contentColor(Color.Black)
                fontSize(26.sp)
                textAlign(TextAlign.Center)
            })
        }
    )
}
```

<br />

**Figure 2.** Hovered and pressed state together on a button.

### Custom composables with Modifier.styleable

When creating your own `styleable` components, you must connect an
`interactionSource` to a `styleState`. Then, pass this state into
`Modifier.styleable` to utilize it.

Consider a scenario where your design system includes a `GradientButton`. You
may want to create a `LoginButton` that inherits from `GradientButton`, but
alters its colors during interactions, like being pressed.

- To enable `interactionSource` style updates, include an `interactionSource` as a parameter within your composable. Use the provided parameter or, if one is not supplied, initialize a new `MutableInteractionSource`.
- Initialize the `styleState` by providing the `interactionSource`. Make sure the `styleState`'s enabled status reflects the value of the provided enabled parameter.
- Assign the `interactionSource` to the `focusable` and `clickable` modifiers. Finally, apply the `styleState` to the modifier's `styleable` parameter.


```kotlin
@Composable
private fun GradientButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    style: Style = Style,
    enabled: Boolean = true,
    interactionSource: MutableInteractionSource? = null,
    content: @Composable RowScope.() -> Unit,
) {
    val interactionSource = interactionSource ?: remember { MutableInteractionSource() }
    val styleState = rememberUpdatedStyleState(interactionSource) {
        it.isEnabled = enabled
    }
    Row(
        modifier =
            modifier
                .clickable(
                    onClick = onClick,
                    enabled = enabled,
                    interactionSource = interactionSource,
                    indication = null,
                )
                .styleable(styleState, baseGradientButtonStyle then style),
        content = content,
    )
}
```

<br />

You can now use the `interactionSource` state to drive style modifications with
the pressed, focused, and hovered options inside the style block:


```kotlin
@Preview
@Composable
fun LoginButton() {
    val loginButtonStyle = Style {
        pressed {
            background(
                Brush.linearGradient(
                    listOf(Color.Magenta, Color.Red)
                )
            )
        }
    }
    GradientButton(onClick = {
        // Login logic
    }, style = loginButtonStyle) {
        BaseText("Login")
    }
}
```

<br />

**Figure 3.** Changing a custom composable state based on `interactionSource`.

## Animate style changes

Styles state changes come with built-in animation support. You can wrap the new
property within any state change block with `animate` to automatically add
animations between different states. This is similar to the `animate*AsState`
APIs. The following example animates the `borderColor` from black to blue when
the state changes to focused:


```kotlin
val animatingStyle = Style {
    externalPadding(48.dp)
    border(3.dp, Color.Black)
    background(Color.White)
    size(100.dp)

    pressed {
        animate {
            borderColor(Color.Magenta)
            background(Color(0xFFB39DDB))
        }
    }
}

@Preview
@Composable
private fun AnimatingStyleChanges() {
    val interactionSource = remember { MutableInteractionSource() }
    val styleState = remember(interactionSource) { MutableStyleState(interactionSource) }
    Box(modifier = Modifier
        .clickable(
            interactionSource,
            enabled = true,
            indication = null,
            onClick = {

            }
        )
        .styleable(styleState, animatingStyle)) {

    }
}
```

<br />

**Figure 4.** Animating color changes on press.

The `animate` API accepts an `animationSpec` to change the duration or shape of
the animation curve. The following example animates the size of the box with a
`spring` spec:


```kotlin
val animatingStyleSpec = Style {
    externalPadding(48.dp)
    border(3.dp, Color.Black)
    background(Color.White)
    size(100.dp)
    transformOrigin(TransformOrigin.Center)
    pressed {
        animate {
            borderColor(Color.Magenta)
            background(Color(0xFFB39DDB))
        }
        animate(spring(dampingRatio = Spring.DampingRatioMediumBouncy)) {
            scale(1.2f)
        }
    }
}

@Preview(showBackground = true)
@Composable
fun AnimatingStyleChangesSpec() {
    val interactionSource = remember { MutableInteractionSource() }
    val styleState = remember(interactionSource) { MutableStyleState(interactionSource) }
    Box(modifier = Modifier
        .clickable(
            interactionSource,
            enabled = true,
            indication = null,
            onClick = {

            }
        )
        .styleable(styleState, animatingStyleSpec))
}
```

<br />

**Figure 5.** Animating size and color changes on press.

## Custom state styling with StyleState

Depending on your composable use case, you may have different styles that are
backed by custom states. For example, if you have a media app, you may want to
have different styling for the buttons in your `MediaPlayer` composable
depending on the playback state of the player. Follow these steps to create and
use your own custom state:

1. Define custom key
2. Create `StyleState` extension
3. Link to custom state

### Define custom key

To create a custom state-based style, first create a
[`StyleStateKey`](https://developer.android.com/reference/kotlin/androidx/compose/foundation/style/StyleStateKey) and pass in the default state value. When the
app launches, the media player is in the `Stopped` state, so it's initialized in
this way:


```kotlin
enum class PlayerState {
    Stopped,
    Playing,
    Paused
}

val playerStateKey = StyleStateKey(PlayerState.Stopped)
```

<br />

### Create StyleState extension functions

Define an extension function on `StyleState` to query the current `playState`.
Then, create extension functions on `StyleScope` with your custom states passing
in the `playStateKey`, a lambda with the specific state, and the style.


```kotlin
// Extension Function on MutableStyleState to query and set the current playState
var MutableStyleState.playerState
    get() = this[playerStateKey]
    set(value) { this[playerStateKey] = value }

fun StyleScope.playerPlaying(block: () -> Unit) {
    state(playerStateKey, block, { key, state -> state[key] == PlayerState.Playing })
}
fun StyleScope.playerPaused(block: () -> Unit) {
    state(playerStateKey, block, { key, state -> state[key] == PlayerState.Paused })
}
```

<br />

### Link to custom state

Define the `styleState` in your composable and set the `styleState.playState`
equal to incoming state. Pass `styleState` into the `styleable` function on the
modifier.


```kotlin
@Composable
fun MediaPlayer(
    url: String,
    modifier: Modifier = Modifier,
    style: Style = Style,
    state: PlayerState = remember { PlayerState.Paused }
) {
    // Hoist style state, set playstate as a parameter,
    val styleState = remember { MutableStyleState(null) }
    // Set equal to incoming state to link the two together
    styleState.playerState = state
    Box(
        modifier = modifier.styleable(styleState, style)) {
        ///..
    }
}
```

<br />

Within the `style` lambda, you can apply state-based styling for custom states,
using the previously defined extension functions.


```kotlin
@Composable
fun StyleStateKeySample() {
    // Using the extension function to change the border color to green while playing
    val style = Style {
        borderColor(Color.Gray)
        playerPlaying {
            animate {
                borderColor(Color.Green)
            }
        }
        playerPaused {
            animate {
                borderColor(Color.Blue)
            }
        }
    }
    val styleState = remember { MutableStyleState(null) }
    styleState[playerStateKey] = PlayerState.Playing

    // Using the style in a composable that sets the state -> notice if you change the state parameter, the style changes. You can link this up to an ViewModel and change the state from there too.
    MediaPlayer(url = "https://example.com/media/video",
        style = style,
        state = PlayerState.Stopped)
}
```

<br />

The following code is the full snippet for this example:


```kotlin
enum class PlayerState {
    Stopped,
    Playing,
    Paused
}
val playerStateKey = StyleStateKey<PlayerState>(PlayerState.Stopped)
var MutableStyleState.playerState
    get() = this[playerStateKey]
    set(value) { this[playerStateKey] = value }

fun StyleScope.playerPlaying(block: () -> Unit) {
    state(playerStateKey, block, { key, state -> state[key] == PlayerState.Playing })
}
fun StyleScope.playerPaused(block: () -> Unit) {
    state(playerStateKey, block, { key, state -> state[key] == PlayerState.Paused })

}

@Composable
fun MediaPlayer(
    url: String,
    modifier: Modifier = Modifier,
    style: Style = Style,
    state: PlayerState = remember { PlayerState.Paused }
) {
    // Hoist style state, set playstate as a parameter,
    val styleState = remember { MutableStyleState(null) }
    // Set equal to incoming state to link the two together
    styleState.playerState = state
    Box(
        modifier = modifier.styleable(styleState, Style {
            size(100.dp)
            border(2.dp, Color.Red)

        }, style, )) {

        ///..
    }
}
@Composable
fun StyleStateKeySample() {
    // Using the extension function to change the border color to green while playing
    val style = Style {
        borderColor(Color.Gray)
        playerPlaying {
            animate {
                borderColor(Color.Green)
            }
        }
        playerPaused {
            animate {
                borderColor(Color.Blue)
            }
        }
    }
    val styleState = remember { MutableStyleState(null) }
    styleState[playerStateKey] = PlayerState.Playing

    // Using the style in a composable that sets the state -> notice if you change the state parameter, the style changes. You can link this up to an ViewModel and change the state from there too.
    MediaPlayer(url = "https://example.com/media/video",
        style = style,
        state = PlayerState.Stopped)
}
```

<br />