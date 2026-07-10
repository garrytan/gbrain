When creating a Glimmer Icon component, refer to the following source code in
`IconButton.kt` for icon buttons:


```kotlin
/*
 * Copyright 2026 The Android Open Source Project
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
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
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
 * IconButton is a component used for exposing supplementary actions with a single tap.
 *
 * Icon buttons are used when a compact button is required, such as in a toolbar or image list.
 *
 * [content] should typically be an [Icon]. If using a custom icon, note that the typical size for
 * the internal icon is 32 x 32 dp. Container has an overall minimum size of 48 x 48 dp.
 *
 * @param onClick called when this icon button is clicked
 * @param modifier the [Modifier] to be applied to this icon button
 * @param enabled controls the enabled state of this icon button. When `false`, this icon button
 *   will not respond to user input
 * @param shape the [Shape] used to clip this icon button
 * @param color background color of this icon button
 * @param contentColor content color used by components inside [content]
 * @param border the border to draw around this icon button
 * @param contentPadding the spacing values to apply internally between the container and the
 *   content
 * @param interactionSource an optional hoisted [MutableInteractionSource] for observing and
 *   emitting Interactions for this icon button. You can use this to change the icon button's
 *   appearance or preview the icon button in different states. Note that if `null` is provided,
 *   interactions will still happen internally.
 * @param content the content of this icon button, typically an [Icon]
 * @sample androidx.xr.glimmer.samples.IconButtonSample
 */
@Composable
public fun IconButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    shape: Shape = GlimmerTheme.shapes.large,
    color: Color = GlimmerTheme.colors.surface,
    contentColor: Color = calculateContentColor(color),
    border: BorderStroke? = SurfaceDefaults.border(),
    contentPadding: PaddingValues = IconButtonDefaults.contentPadding,
    interactionSource: MutableInteractionSource? = null,
    content: @Composable () -> Unit,
) {
    val depthEffect =
        SurfaceDepthEffect(
            depthEffect = null,
            focusedDepthEffect = GlimmerTheme.depthEffectLevels.level1,
        )

    val internalInteractionSource = interactionSource ?: remember { MutableInteractionSource() }

    Box(
        modifier
            .semantics { role = Role.Button }
            .surface(
                enabled = enabled,
                shape = shape,
                color = color,
                contentColor = contentColor,
                depthEffect = depthEffect,
                border = border,
                interactionSource = internalInteractionSource,
            )
            .clickable(
                enabled = enabled,
                interactionSource = internalInteractionSource,
                onClick = onClick,
            )
            .defaultMinSize(IconButtonDefaults.minimumSize)
            .padding(contentPadding),
        contentAlignment = Alignment.Center,
    ) {
        CompositionLocalProvider(
            LocalIconSize provides IconButtonDefaults.iconSize,
            content = content,
        )
    }
}

/** Default values used for [IconButton]. */
public object IconButtonDefaults {
    /** Default content padding for an [IconButton]. */
    @get:Composable
    public val contentPadding: PaddingValues
        get() = PaddingValues(GlimmerTheme.componentSpacingValues.small)

    /** Minimum size for icon-only buttons: [IconButton], [IconToggleButton]. */
    internal val minimumSize: Dp
        get() = 48.dp

    /** Default icon size for icon-only buttons: [IconButton], [IconToggleButton]. */
    @get:Composable
    internal val iconSize: Dp
        get() = GlimmerTheme.iconSizes.small
}
```

<br />