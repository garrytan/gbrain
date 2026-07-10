When creating a Glimmer Button component, refer to the following source code in
`Button.kt`:


```kotlin
/*
 * Copyright 2025 The Android Open Source Project
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

package androidx.xr.glimmer

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * Button is a component used for exposing actions to a user.
 *
 * @sample androidx.xr.glimmer.samples.ButtonSample
 *
 * Buttons can use icons to provide more context about the action:
 *
 * @sample androidx.xr.glimmer.samples.ButtonWithLeadingIconSample
 *
 * There are multiple button size variants - providing a different [ButtonSize] will affect default
 * values used inside this button, such as the minimum height. Note that you can still provide a
 * size modifier such as [androidx.compose.foundation.layout.size] to change the layout size of this
 * button, [buttonSize] affects default values and values internal to the button.
 *
 * @sample androidx.xr.glimmer.samples.LargeButtonSample
 * @param onClick called when this button is clicked
 * @param modifier the [Modifier] to be applied to this button
 * @param enabled controls the enabled state of this button. When `false`, this button will not
 *   respond to user input
 * @param buttonSize the size variant of this button, represented as a [ButtonSize]. Changing
 *   [buttonSize] will affect some default values used by this button - but the final resulting size
 *   of the button will still be calculated based on the content of the button, and any provided
 *   size modifiers such as [androidx.compose.foundation.layout.size]. For example, setting a 100.dp
 *   size using a size modifier will result in the same layout size regardless of [buttonSize], but
 *   the provided [buttonSize] will affect other properties such as padding values and the size of
 *   icons.
 * @param leadingIcon optional leading icon to be placed before the [content]. This is typically an
 *   [Icon] tinted with [contentColor] by default.
 * @param trailingIcon optional trailing icon to be placed after the [content]. This is typically an
 *   [Icon] tinted with [contentColor] by default.
 * @param shape the [Shape] used to clip this button, and also used to draw the background and
 *   border
 * @param color background color of this button
 * @param contentColor content color used by components inside [content], [leadingIcon], and
 *   [trailingIcon].
 * @param border the border to draw around this button
 * @param contentPadding the spacing values to apply internally between the container and the
 *   content
 * @param interactionSource an optional hoisted [MutableInteractionSource] for observing and
 *   emitting Interactions for this button. You can use this to change the button's appearance or
 *   preview the button in different states. Note that if `null` is provided, interactions will
 *   still happen internally.
 * @param content the main content, typically [Text], to display inside this button
 */
@Composable
public fun Button(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    buttonSize: ButtonSize = ButtonSize.Medium,
    leadingIcon: @Composable (() -> Unit)? = null,
    trailingIcon: @Composable (() -> Unit)? = null,
    shape: Shape = GlimmerTheme.shapes.large,
    color: Color = GlimmerTheme.colors.surface,
    contentColor: Color = calculateContentColor(color),
    border: BorderStroke? = SurfaceDefaults.border(),
    contentPadding: PaddingValues = ButtonDefaults.contentPadding(buttonSize),
    interactionSource: MutableInteractionSource? = null,
    content: @Composable RowScope.() -> Unit,
) {
    val iconSize = ButtonDefaults.iconSize
    val iconSpacing = ButtonDefaults.iconSpacing
    val minHeight = ButtonDefaults.minimumHeight(buttonSize)

    val depth =
        SurfaceDepthEffect(
            depthEffect = null,
            focusedDepthEffect = GlimmerTheme.depthEffectLevels.level1,
        )

    val internalInteractionSource = interactionSource ?: remember { MutableInteractionSource() }

    CompositionLocalProvider(LocalTextStyle provides GlimmerTheme.typography.bodySmall) {
        Row(
            modifier
                .semantics { role = Role.Button }
                .surface(
                    enabled = enabled,
                    shape = shape,
                    color = color,
                    contentColor = contentColor,
                    depthEffect = depth,
                    border = border,
                    interactionSource = internalInteractionSource,
                )
                .clickable(
                    enabled = enabled,
                    interactionSource = internalInteractionSource,
                    onClick = onClick,
                )
                .defaultMinSize(minHeight = minHeight)
                .padding(contentPadding),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (leadingIcon != null) {
                Box(Modifier.padding(end = iconSpacing)) {
                    CompositionLocalProvider(LocalIconSize provides iconSize, content = leadingIcon)
                }
            }
            content()
            if (trailingIcon != null) {
                Box(Modifier.padding(start = iconSpacing)) {
                    CompositionLocalProvider(
                        LocalIconSize provides iconSize,
                        content = trailingIcon,
                    )
                }
            }
        }
    }
}

/**
 * ButtonSize represents the different size variants of a [Button]. ButtonSize will affect default
 * values used inside a [Button], such as the minimum height and the size of icons.
 */
@Immutable
@JvmInline
public value class ButtonSize internal constructor(private val value: Int) {
    public companion object {
        /** ButtonSize representing a medium [Button]. This is the default size. */
        public val Medium: ButtonSize = ButtonSize(1)
        /** ButtonSize representing a large [Button]. */
        public val Large: ButtonSize = ButtonSize(2)
    }
}

/** Default values used for [Button]. */
public object ButtonDefaults {
    /** Default content padding used for a [Button] with the specified [buttonSize]. */
    @Composable
    public fun contentPadding(buttonSize: ButtonSize): PaddingValues {
        val componentSpacingValues = GlimmerTheme.componentSpacingValues
        return if (buttonSize == ButtonSize.Medium) {
            PaddingValues(
                horizontal = componentSpacingValues.large,
                vertical = componentSpacingValues.small,
            )
        } else {
            PaddingValues(componentSpacingValues.large)
        }
    }

    /** Default minimum height for [Button] and [ToggleButton] with the specified [buttonSize]. */
    internal fun minimumHeight(buttonSize: ButtonSize): Dp {
        return when (buttonSize) {
            ButtonSize.Medium -> 48.dp
            ButtonSize.Large -> 72.dp
            else -> throw IllegalArgumentException("Unknown size $buttonSize.")
        }
    }

    /** Default icon size for buttons with non-icon content: [Button], [ToggleButton]. */
    @get:Composable
    internal val iconSize: Dp
        get() = GlimmerTheme.iconSizes.small

    /** Default spacing between icon and content for [Button] and [ToggleButton]. */
    @get:Composable
    internal val iconSpacing: Dp
        get() = GlimmerTheme.componentSpacingValues.extraSmall
}
```

<br />