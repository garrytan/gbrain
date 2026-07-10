When creating a Glimmer Icon Sizes component, refer to the following source
code in `ListItem.kt` for list items:


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
import androidx.compose.foundation.focusable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Alignment.Companion.CenterVertically
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.unit.dp

/**
 * ListItem is a component used to represent a single item in a
 * [androidx.xr.glimmer.list.GlimmerLazyColumn]. A ListItem has a primary label [content], and may
 * also have any combination of [supportingLabel], [leadingIcon], and [trailingIcon]. The supporting
 * label is displayed below the primary label and can be used to provide additional information. A
 * ListItem fills the maximum width available by default.
 *
 * This ListItem is focusable - see the other [ListItem] overload for a clickable ListItem.
 *
 * A simple ListItem with just a primary label:
 *
 * @sample androidx.xr.glimmer.samples.ListItemSample
 *
 * A ListItem with a primary and supporting label:
 *
 * @sample androidx.xr.glimmer.samples.ListItemWithSupportingLabelSample
 *
 * A ListItem with a primary label, a supporting label, and a leading icon:
 *
 * @sample androidx.xr.glimmer.samples.ListItemWithSupportingLabelAndLeadingIconSample
 * @param modifier the [Modifier] to be applied to this list item
 * @param supportingLabel optional supporting label to be placed underneath the primary label
 *   [content]
 * @param leadingIcon optional leading icon to be placed before the primary label [content]. This is
 *   typically an [Icon] tinted with [contentColor] by default.
 * @param trailingIcon optional trailing icon to be placed after the primary label [content]. This
 *   is typically an [Icon] tinted with [contentColor] by default.
 * @param shape the [Shape] used to clip this list item, and also used to draw the background and
 *   border
 * @param color background color of this list item
 * @param contentColor content color used by components inside [content], [supportingLabel],
 *   [leadingIcon], and [trailingIcon].
 * @param border the border to draw around this list item
 * @param contentPadding the spacing values to apply internally between the container and the
 *   content
 * @param interactionSource an optional hoisted [MutableInteractionSource] for observing and
 *   emitting Interactions for this list item. You can use this to change the list item's appearance
 *   or preview the list item in different states. Note that if `null` is provided, interactions
 *   will still happen internally.
 * @param content the main content / primary label to display inside this list item
 */
@Composable
public fun ListItem(
    modifier: Modifier = Modifier,
    supportingLabel: @Composable (() -> Unit)? = null,
    leadingIcon: @Composable (() -> Unit)? = null,
    trailingIcon: @Composable (() -> Unit)? = null,
    shape: Shape = GlimmerTheme.shapes.medium,
    color: Color = GlimmerTheme.colors.surface,
    contentColor: Color = calculateContentColor(color),
    border: BorderStroke? = SurfaceDefaults.border(),
    contentPadding: PaddingValues = ListItemDefaults.contentPadding,
    interactionSource: MutableInteractionSource? = null,
    content: @Composable () -> Unit,
) {
    ListItemImpl(
        modifier = modifier,
        onClick = null,
        supportingLabel = supportingLabel,
        leadingIcon = leadingIcon,
        trailingIcon = trailingIcon,
        shape = shape,
        color = color,
        contentColor = contentColor,
        border = border,
        contentPadding = contentPadding,
        interactionSource = interactionSource,
        content = content,
    )
}

/**
 * ListItem is a component used to represent a single item in a
 * [androidx.xr.glimmer.list.GlimmerLazyColumn]. A ListItem has a primary label [content], and may
 * also have any combination of [supportingLabel], [leadingIcon], and [trailingIcon]. The supporting
 * label is displayed below the primary label and can be used to provide additional information. A
 * ListItem fills the maximum width available by default.
 *
 * This ListItem is focusable and clickable - see the other [ListItem] overload for a ListItem that
 * is only focusable.
 *
 * A simple clickable ListItem with just a primary label:
 *
 * @sample androidx.xr.glimmer.samples.ClickableListItemSample
 *
 * A clickable ListItem with a primary and supporting label:
 *
 * @sample androidx.xr.glimmer.samples.ClickableListItemWithSupportingLabelSample
 *
 * A clickable ListItem with a primary label, a supporting label, and a leading icon:
 *
 * @sample androidx.xr.glimmer.samples.ClickableListItemWithSupportingLabelAndLeadingIconSample
 * @param onClick called when this list item is clicked
 * @param modifier the [Modifier] to be applied to this list item
 * @param supportingLabel optional supporting label to be placed underneath the primary label
 *   [content]
 * @param leadingIcon optional leading icon to be placed before the primary label [content]. This is
 *   typically an [Icon] tinted with [contentColor] by default.
 * @param trailingIcon optional trailing icon to be placed after the primary label [content]. This
 *   is typically an [Icon] tinted with [contentColor] by default.
 * @param shape the [Shape] used to clip this list item, and also used to draw the background and
 *   border
 * @param color background color of this list item
 * @param contentColor content color used by components inside [content], [supportingLabel],
 *   [leadingIcon], and [trailingIcon].
 * @param border the border to draw around this list item
 * @param contentPadding the spacing values to apply internally between the container and the
 *   content
 * @param interactionSource an optional hoisted [MutableInteractionSource] for observing and
 *   emitting Interactions for this list item. You can use this to change the list item's appearance
 *   or preview the list item in different states. Note that if `null` is provided, interactions
 *   will still happen internally.
 * @param content the main content / primary label to display inside this list item
 */
@Composable
public fun ListItem(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    supportingLabel: @Composable (() -> Unit)? = null,
    leadingIcon: @Composable (() -> Unit)? = null,
    trailingIcon: @Composable (() -> Unit)? = null,
    shape: Shape = GlimmerTheme.shapes.medium,
    color: Color = GlimmerTheme.colors.surface,
    contentColor: Color = calculateContentColor(color),
    border: BorderStroke? = SurfaceDefaults.border(),
    contentPadding: PaddingValues = ListItemDefaults.contentPadding,
    interactionSource: MutableInteractionSource? = null,
    content: @Composable () -> Unit,
) {
    ListItemImpl(
        modifier = modifier,
        onClick = onClick,
        supportingLabel = supportingLabel,
        leadingIcon = leadingIcon,
        trailingIcon = trailingIcon,
        shape = shape,
        color = color,
        contentColor = contentColor,
        border = border,
        contentPadding = contentPadding,
        interactionSource = interactionSource,
        content = content,
    )
}

@Composable
private fun ListItemImpl(
    modifier: Modifier,
    onClick: (() -> Unit)?,
    supportingLabel: @Composable (() -> Unit)?,
    leadingIcon: @Composable (() -> Unit)?,
    trailingIcon: @Composable (() -> Unit)?,
    shape: Shape,
    color: Color,
    contentColor: Color,
    border: BorderStroke?,
    contentPadding: PaddingValues,
    interactionSource: MutableInteractionSource?,
    content: @Composable () -> Unit,
) {
    val iconSize = GlimmerTheme.iconSizes.large
    val typography = GlimmerTheme.typography
    val innerPadding = GlimmerTheme.componentSpacingValues.small
    val depthEffect =
        SurfaceDepthEffect(
            depthEffect = null,
            focusedDepthEffect = GlimmerTheme.depthEffectLevels.level4,
        )

    val internalInteractionSource = interactionSource ?: remember { MutableInteractionSource() }

    val surfaceModifier =
        Modifier.surface(
                shape = shape,
                color = color,
                contentColor = contentColor,
                depthEffect = depthEffect,
                border = border,
                interactionSource = internalInteractionSource,
            )
            .then(
                if (onClick != null) {
                    Modifier.clickable(
                        interactionSource = internalInteractionSource,
                        onClick = onClick,
                    )
                } else {
                    Modifier.focusable(interactionSource = internalInteractionSource)
                }
            )

    Row(
        modifier =
            modifier
                .then(surfaceModifier)
                .fillMaxWidth()
                .defaultMinSize(minHeight = MinimumHeight)
                .padding(contentPadding),
        verticalAlignment = CenterVertically,
    ) {
        if (leadingIcon != null) {
            Box(modifier = Modifier.align(Alignment.Top), contentAlignment = Alignment.TopStart) {
                CompositionLocalProvider(LocalIconSize provides iconSize, content = leadingIcon)
            }
        }
        Column(Modifier.weight(1f).padding(horizontal = innerPadding)) {
            if (supportingLabel == null) {
                CompositionLocalProvider(
                    LocalTextStyle provides typography.bodySmall,
                    content = content,
                )
            } else {
                CompositionLocalProvider(
                    LocalTextStyle provides typography.titleSmall,
                    content = content,
                )
                CompositionLocalProvider(
                    LocalTextStyle provides typography.bodySmall,
                    content = supportingLabel,
                )
            }
        }
        if (trailingIcon != null) {
            Box(modifier = Modifier.align(Alignment.Top), contentAlignment = Alignment.TopEnd) {
                CompositionLocalProvider(LocalIconSize provides iconSize, content = trailingIcon)
            }
        }
    }
}

/** Default values used for [ListItem] */
public object ListItemDefaults {
    /** Default content padding used for a [ListItem] */
    public val contentPadding: PaddingValues
        @Composable get() = PaddingValues(GlimmerTheme.componentSpacingValues.large)
}

/** Default minimum height for a [ListItem] */
private val MinimumHeight = 80.dp
```

<br />