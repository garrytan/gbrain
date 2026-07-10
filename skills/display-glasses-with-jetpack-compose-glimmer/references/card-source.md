When creating a Glimmer Card component, refer to the following source code in
`Card.kt`:


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
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Alignment.Companion.CenterVertically
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.layout
import androidx.compose.ui.unit.dp
import androidx.compose.ui.util.fastForEach
import androidx.compose.ui.util.fastMap
import kotlin.math.max

/**
 * Card is a component used to group related information into a single digestible unit. A card can
 * adapt to display a wide range of content, from simple text blurbs to more complex summaries with
 * multiple elements. A card contains text [content], and may also have any combination of [title],
 * [subtitle], [leadingIcon], and [trailingIcon]. If specified, [title] is placed on top of the
 * [subtitle], which is placed on top of the [content]. A card fills the maximum width available by
 * default.
 *
 * This Card is focusable - see the other [Card] overload for a clickable Card.
 *
 * Cards can also be combined with a [TitleChip]. See the documentation for [TitleChip] for more
 * information / sample code.
 *
 * A simple Card with just text:
 *
 * @sample androidx.xr.glimmer.samples.CardSample
 *
 * A Card with a trailing icon:
 *
 * @sample androidx.xr.glimmer.samples.CardWithTrailingIconSample
 *
 * A Card with a title, subtitle, and a leading icon:
 *
 * @sample androidx.xr.glimmer.samples.CardWithTitleAndSubtitleAndLeadingIconSample
 *
 * A card with a title and a header image:
 *
 * @sample androidx.xr.glimmer.samples.CardWithTitleAndHeaderSample
 * @param modifier the [Modifier] to be applied to this card
 * @param title optional title to be placed above [subtitle] and [content], below [header]
 * @param subtitle optional subtitle to be placed above [content], below [title]
 * @param header optional header image to be placed at the top of the card. This image should
 *   typically fill the max width available, for example using
 *   [androidx.compose.ui.layout.ContentScale.FillWidth]. Headers are constrained to a maximum
 *   aspect ratio (1.6) to avoid taking up too much vertical space, so using a modifier such as
 *   [androidx.compose.foundation.layout.fillMaxSize] will result in an image that fills the maximum
 *   aspect ratio.
 * @param leadingIcon optional leading icon to be placed before [content]. This is typically an
 *   [Icon] tinted with [contentColor] by default.
 * @param trailingIcon optional trailing icon to be placed after [content]. This is typically an
 *   [Icon] tinted with [contentColor] by default.
 * @param shape the [Shape] used to clip this card, and also used to draw the background and border
 * @param color background color of this card
 * @param contentColor content color used by components inside [content], [title], [subtitle],
 *   [leadingIcon], and [trailingIcon].
 * @param border the border to draw around this card
 * @param contentPadding the spacing values to apply internally between the container and the
 *   content. Note that there is additional padding applied around the content / text / icons inside
 *   a card, this only affects the outermost content padding.
 * @param interactionSource an optional hoisted [MutableInteractionSource] for observing and
 *   emitting Interactions for this card. You can use this to change the card's appearance or
 *   preview the card in different states. Note that if `null` is provided, interactions will still
 *   happen internally.
 * @param content the main content / body text to display inside this card. This is recommended to
 *   be limited to 10 lines of text.
 */
@Composable
public fun Card(
    modifier: Modifier = Modifier,
    title: @Composable (() -> Unit)? = null,
    subtitle: @Composable (() -> Unit)? = null,
    header: @Composable (() -> Unit)? = null,
    leadingIcon: @Composable (() -> Unit)? = null,
    trailingIcon: @Composable (() -> Unit)? = null,
    shape: Shape = CardDefaults.shape,
    color: Color = GlimmerTheme.colors.surface,
    contentColor: Color = calculateContentColor(color),
    border: BorderStroke? = SurfaceDefaults.border(),
    contentPadding: PaddingValues = CardDefaults.contentPadding,
    interactionSource: MutableInteractionSource? = null,
    content: @Composable () -> Unit,
) {
    val internalInteractionSource = interactionSource ?: remember { MutableInteractionSource() }
    CardImpl(
        modifier =
            modifier
                .surface(
                    shape = shape,
                    color = color,
                    contentColor = contentColor,
                    border = border,
                    interactionSource = internalInteractionSource,
                )
                .focusable(interactionSource = internalInteractionSource),
        title = title,
        subtitle = subtitle,
        header = header,
        leadingIcon = leadingIcon,
        trailingIcon = trailingIcon,
        contentPadding = contentPadding,
        content = content,
    )
}

/**
 * Card is a component used to group related information into a single digestible unit. A card can
 * adapt to display a wide range of content, from simple text blurbs to more complex summaries with
 * multiple elements. A card contains text [content], and may also have any combination of [title],
 * [subtitle], [leadingIcon], and [trailingIcon]. If specified, [title] is placed on top of the
 * [subtitle], which is placed on top of the [content]. A card fills the maximum width available by
 * default.
 *
 * This Card is focusable and clickable - see the other [Card] overload for a Card that is only
 * focusable.
 *
 * Cards can also be combined with a [TitleChip]. See the documentation for [TitleChip] for more
 * information / sample code.
 *
 * A simple clickable Card with just text:
 *
 * @sample androidx.xr.glimmer.samples.ClickableCardSample
 *
 * A clickable Card with a trailing icon:
 *
 * @sample androidx.xr.glimmer.samples.ClickableCardWithTrailingIconSample
 *
 * A clickable Card with a title, subtitle, and a leading icon:
 *
 * @sample androidx.xr.glimmer.samples.ClickableCardWithTitleAndSubtitleAndLeadingIconSample
 *
 * A clickable Card with a title and a header image:
 *
 * @sample androidx.xr.glimmer.samples.ClickableCardWithTitleAndHeaderSample
 * @param onClick called when this card item is clicked
 * @param modifier the [Modifier] to be applied to this card
 * @param title optional title to be placed above [subtitle] and [content], below [header]
 * @param subtitle optional subtitle to be placed above [content], below [title]
 * @param header optional header image to be placed at the top of the card. This image should
 *   typically fill the max width available, for example using
 *   [androidx.compose.ui.layout.ContentScale.FillWidth]. Headers are constrained to a maximum
 *   aspect ratio (1.6) to avoid taking up too much vertical space, so using a modifier such as
 *   [androidx.compose.foundation.layout.fillMaxSize] will result in an image that fills the maximum
 *   aspect ratio.
 * @param leadingIcon optional leading icon to be placed before [content]. This is typically an
 *   [Icon] tinted with [contentColor] by default.
 * @param trailingIcon optional trailing icon to be placed after [content]. This is typically an
 *   [Icon] tinted with [contentColor] by default.
 * @param shape the [Shape] used to clip this card, and also used to draw the background and border
 * @param color background color of this card
 * @param contentColor content color used by components inside [content], [title], [subtitle],
 *   [leadingIcon], and [trailingIcon].
 * @param border the border to draw around this card
 * @param contentPadding the spacing values to apply internally between the container and the
 *   content. Note that there is additional padding applied around the content / text / icons inside
 *   a card, this only affects the outermost content padding.
 * @param interactionSource an optional hoisted [MutableInteractionSource] for observing and
 *   emitting Interactions for this card. You can use this to change the card's appearance or
 *   preview the card in different states. Note that if `null` is provided, interactions will still
 *   happen internally.
 * @param content the main content / body text to display inside this card. This is recommended to
 *   be limited to 10 lines of text.
 */
@Composable
public fun Card(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    title: @Composable (() -> Unit)? = null,
    subtitle: @Composable (() -> Unit)? = null,
    header: @Composable (() -> Unit)? = null,
    leadingIcon: @Composable (() -> Unit)? = null,
    trailingIcon: @Composable (() -> Unit)? = null,
    shape: Shape = CardDefaults.shape,
    color: Color = GlimmerTheme.colors.surface,
    contentColor: Color = calculateContentColor(color),
    border: BorderStroke? = SurfaceDefaults.border(),
    contentPadding: PaddingValues = CardDefaults.contentPadding,
    interactionSource: MutableInteractionSource? = null,
    content: @Composable () -> Unit,
) {
    val internalInteractionSource = interactionSource ?: remember { MutableInteractionSource() }
    CardImpl(
        modifier =
            modifier
                .surface(
                    shape = shape,
                    color = color,
                    contentColor = contentColor,
                    border = border,
                    interactionSource = internalInteractionSource,
                )
                .clickable(interactionSource = internalInteractionSource, onClick = onClick),
        title = title,
        subtitle = subtitle,
        header = header,
        leadingIcon = leadingIcon,
        trailingIcon = trailingIcon,
        contentPadding = contentPadding,
        content = content,
    )
}

/**
 * ActionCard is a version of a card that contains a primary [action] that is placed in the center
 * of the bottom edge of the card. The action should be a [Button], and represents the action that
 * will be performed when this card is interacted with. The main card itself is not focusable - the
 * [action] takes the focus instead.
 *
 * ActionCard is a component used to group related information into a single digestible unit. An
 * action card can adapt to display a wide range of content, from simple text blurbs to more complex
 * summaries with multiple elements. An action card contains text [content], and may also have any
 * combination of [title], [subtitle], [leadingIcon], and [trailingIcon]. If specified, [title] is
 * placed on top of the [subtitle], which is placed on top of the [content]. An action card fills
 * the maximum width available by default.
 *
 * For more documentation and samples of the other cards, see [Card].
 *
 * @sample androidx.xr.glimmer.samples.ActionCardWithTitleSample
 * @param action the action for this card. This should be a [Button], and represents the action
 *   performed when a user interacts with this card. The action is placed overlapping the bottom
 *   edge of the card.
 * @param modifier the [Modifier] to be applied to the outer layout containing the card and action
 * @param title optional title to be placed above [subtitle] and [content], below [header]
 * @param subtitle optional subtitle to be placed above [content], below [title]
 * @param header optional header image to be placed at the top of the card. This image should
 *   typically fill the max width available, for example using
 *   [androidx.compose.ui.layout.ContentScale.FillWidth]. Headers are constrained to a maximum
 *   aspect ratio (1.6) to avoid taking up too much vertical space, so using a modifier such as
 *   [androidx.compose.foundation.layout.fillMaxSize] will result in an image that fills the maximum
 *   aspect ratio.
 * @param leadingIcon optional leading icon to be placed before [content]. This is typically an
 *   [Icon] tinted with [contentColor] by default.
 * @param trailingIcon optional trailing icon to be placed after [content]. This is typically an
 *   [Icon] tinted with [contentColor] by default.
 * @param shape the [Shape] used to clip this card, and also used to draw the background and border
 * @param color background color of this card
 * @param contentColor content color used by components inside [content], [title], [subtitle],
 *   [leadingIcon], and [trailingIcon].
 * @param border the border to draw around this card
 * @param contentPadding the spacing values to apply internally between the container and the
 *   content. Note that there is additional padding applied around the content / text / icons inside
 *   a card, this only affects the outermost content padding.
 * @param content the main content / body text to display inside this card. This is recommended to
 *   be limited to 10 lines of text.
 */
@Composable
public fun ActionCard(
    action: @Composable () -> Unit,
    modifier: Modifier = Modifier,
    title: @Composable (() -> Unit)? = null,
    subtitle: @Composable (() -> Unit)? = null,
    header: @Composable (() -> Unit)? = null,
    leadingIcon: @Composable (() -> Unit)? = null,
    trailingIcon: @Composable (() -> Unit)? = null,
    shape: Shape = CardDefaults.shape,
    color: Color = GlimmerTheme.colors.surface,
    contentColor: Color = calculateContentColor(color),
    border: BorderStroke? = SurfaceDefaults.border(),
    contentPadding: PaddingValues = CardDefaults.contentPadding,
    content: @Composable () -> Unit,
) {
    // b/436852852 - in a list the button won't be focused until it crosses the focus line.
    ActionCardLayout(modifier, action) {
        CardImpl(
            modifier =
                Modifier.surface(
                    shape = shape,
                    color = color,
                    contentColor = contentColor,
                    border = border,
                ),
            title = title,
            subtitle = subtitle,
            header = header,
            leadingIcon = leadingIcon,
            trailingIcon = trailingIcon,
            contentPadding = contentPadding,
            content = content,
        )
    }
}

@Composable
private fun CardImpl(
    modifier: Modifier,
    title: @Composable (() -> Unit)?,
    subtitle: @Composable (() -> Unit)?,
    header: @Composable (() -> Unit)?,
    leadingIcon: @Composable (() -> Unit)?,
    trailingIcon: @Composable (() -> Unit)?,
    contentPadding: PaddingValues,
    content: @Composable () -> Unit,
) {
    val iconSize = GlimmerTheme.iconSizes.large
    val typography = GlimmerTheme.typography
    val componentSpacingValues = GlimmerTheme.componentSpacingValues
    val innerPadding = componentSpacingValues.small
    val iconSpacing = componentSpacingValues.medium

    Column(
        modifier = modifier.defaultMinSize(minHeight = MinimumHeight).padding(contentPadding),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        header?.let {
            Box(
                Modifier.constrainHeightToAspectRatio(HeaderMaximumAspectRatio).clip(HeaderShape),
                contentAlignment = Alignment.Center,
            ) {
                it()
            }
        }
        Row(
            modifier = Modifier.fillMaxWidth().padding(innerPadding),
            verticalAlignment = CenterVertically,
        ) {
            if (leadingIcon != null) {
                Box(
                    modifier = Modifier.align(Alignment.Top).padding(end = iconSpacing),
                    contentAlignment = Alignment.TopStart,
                ) {
                    CompositionLocalProvider(LocalIconSize provides iconSize, content = leadingIcon)
                }
            }
            Column(
                Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(TextVerticalSpacing),
            ) {
                if (title != null) {
                    CompositionLocalProvider(
                        LocalTextStyle provides typography.bodyMedium,
                        content = title,
                    )
                }

                if (subtitle != null) {
                    CompositionLocalProvider(
                        LocalTextStyle provides typography.caption,
                        content = subtitle,
                    )
                }

                CompositionLocalProvider(
                    LocalTextStyle provides typography.bodySmall,
                    content = content,
                )
            }
            if (trailingIcon != null) {
                Box(
                    modifier = Modifier.align(Alignment.Top).padding(start = iconSpacing),
                    contentAlignment = Alignment.TopEnd,
                ) {
                    CompositionLocalProvider(
                        LocalIconSize provides iconSize,
                        content = trailingIcon,
                    )
                }
            }
        }
    }
}

@Composable
private fun ActionCardLayout(
    modifier: Modifier,
    action: @Composable () -> Unit,
    card: @Composable () -> Unit,
) {
    Layout(contents = listOf(action, card), modifier = modifier) { measurables, constraints ->
        val actionMeasurables = measurables[0]
        val cardMeasurables = measurables[1]

        var actionMaxWidth = 0
        var actionMaxHeight = 0
        var cardMaxWidth = 0
        var cardMaxHeight = 0

        val actionPlaceables =
            actionMeasurables.fastMap {
                // Measure the action with relaxed constraints
                val placeable = it.measure(constraints.copyMaxDimensions())
                actionMaxWidth = max(actionMaxWidth, placeable.width)
                actionMaxHeight = max(actionMaxHeight, placeable.height)
                placeable
            }

        val actionInset = ActionInset.roundToPx()

        // The card is allowed to take up the total height - the height of the overall layout taken
        // up by the action
        val heightTakenUpByAction = (actionMaxHeight - actionInset).coerceAtLeast(0)

        // Shrink the height constraints, to account for the action button
        val cardMinHeightConstraints =
            (constraints.minHeight - heightTakenUpByAction).coerceAtLeast(0)
        val cardMaxHeightConstraints =
            if (constraints.hasBoundedHeight) {
                (constraints.maxHeight - heightTakenUpByAction).coerceAtLeast(0)
            } else {
                constraints.maxHeight
            }
        val cardConstraints =
            constraints.copy(
                minHeight = cardMinHeightConstraints,
                maxHeight = cardMaxHeightConstraints,
            )

        val cardPlaceables =
            cardMeasurables.fastMap {
                val placeable = it.measure(cardConstraints)
                cardMaxWidth = max(cardMaxWidth, placeable.width)
                cardMaxHeight = max(cardMaxHeight, placeable.height)
                placeable
            }

        val layoutWidth = maxOf(actionMaxWidth, cardMaxWidth)
        val layoutHeight = heightTakenUpByAction + cardMaxHeight

        layout(layoutWidth, layoutHeight) {
            cardPlaceables.fastForEach {
                // Horizontally center in the overall space
                val x = (layoutWidth - it.width) / 2
                it.placeRelative(x, 0)
            }

            actionPlaceables.fastForEach {
                // Horizontally center in the overall space
                val x = (layoutWidth - it.width) / 2
                val y = cardMaxHeight - actionInset
                it.placeRelative(x, y)
            }
        }
    }
}

/**
 * Constrains the content's height to a maximum aspect ratio, based on the maximum width.
 *
 * This modifier is similar to [androidx.compose.foundation.layout.aspectRatio], but it only
 * enforces a maximum size, allowing the content to be smaller than the bounds defined by the aspect
 * ratio. It also only constrains the height based on the width, it does not constrain the width
 * based on the height.
 *
 * @param widthToHeightRatio the maximum aspect ratio allowed for the height. This is defined as the
 *   ratio of width / height
 */
private fun Modifier.constrainHeightToAspectRatio(widthToHeightRatio: Float): Modifier {
    require(widthToHeightRatio > 0) { "Ratio must be positive" }
    return this.layout { measurable, constraints ->
        // We only want to constrain height, based on width. If width is unbounded and there is a
        // bounded height, we don't want to constrain the width based on height. So do nothing if
        // we don't have a constrained width
        if (!constraints.hasBoundedWidth) {
            val placeable = measurable.measure(constraints)
            return@layout layout(placeable.width, placeable.height) {
                placeable.placeRelative(0, 0)
            }
        }

        val height =
            (constraints.maxWidth / widthToHeightRatio)
                .toInt()
                // Handle the case where the width is more than ratio times larger than available
                // height
                .coerceAtMost(constraints.maxHeight)

        val newConstraints =
            constraints.copy(
                // Relax minimum height to let the content be smaller than constraints.minHeight if
                // the aspect ratio results in a height smaller than min height
                minHeight = 0,
                maxHeight = height,
            )

        val placeable = measurable.measure(newConstraints)

        // We relaxed the constraints earlier, but we still need to respect the incoming constraints
        // ourselves.
        val layoutHeight = placeable.height.coerceIn(constraints.minHeight, constraints.maxHeight)

        layout(placeable.width, layoutHeight) {
            // Center the content within the final layout height if needed
            val y = (layoutHeight - placeable.height) / 2
            placeable.placeRelative(0, y)
        }
    }
}

/** Default values used for [Card] */
public object CardDefaults {
    /**
     * Default content padding used for a [Card]
     *
     * This affects the outermost content padding applied around header images and the content
     * container. Note that there is additional padding applied around the content / text / icons
     * inside a card, this only represents the outer padding for the entire content.
     */
    public val contentPadding: PaddingValues
        @Composable get() = PaddingValues(GlimmerTheme.componentSpacingValues.medium)

    /** The default shape of [Card], which determines its corner radius. */
    public val shape: Shape
        @Composable get() = GlimmerTheme.shapes.medium
}

/** Default minimum height for a [Card] */
private val MinimumHeight = 80.dp

/** Spacing between title / subtitle / body text */
private val TextVerticalSpacing = 3.dp

/** Shape used to clip the header image */
private val HeaderShape = RoundedCornerShape(24.dp)

/**
 * Width / height aspect ratio for header images, to prevent the images from taking up too much
 * vertical space
 */
private const val HeaderMaximumAspectRatio = 1.6f

/** How far the action button is inset from the underlying card's edge */
private val ActionInset = 16.dp
```

<br />