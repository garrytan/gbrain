When creating a Glimmer List component, refer to the following source code in
`List.kt`:


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

package androidx.xr.glimmer.list

import androidx.compose.foundation.OverscrollEffect
import androidx.compose.foundation.gestures.FlingBehavior
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.snapping.rememberSnapFlingBehavior
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.lazy.layout.LazyLayout
import androidx.compose.foundation.rememberOverscrollEffect
import androidx.compose.foundation.scrollableArea
import androidx.compose.runtime.Composable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.util.fastForEach
import androidx.compose.ui.util.fastMap
import androidx.xr.glimmer.GlimmerTheme
import androidx.xr.glimmer.edgeScrim
import kotlin.math.max

/**
 * This is a scrolling list component that only composes and lays out the currently visible items.
 * It is based on [androidx.compose.foundation.lazy.LazyColumn], but with extra functionality and
 * customized behavior required for Jetpack Compose Glimmer. For Jetpack Compose Glimmer
 * applications, it is recommended to use [VerticalList] instead of
 * [androidx.compose.foundation.lazy.LazyColumn], as it is specifically designed to provide seamless
 * focus-based navigation, visual scrim edge effects and support for focus-aware snap behavior.
 *
 * The [content] block defines a DSL which allows you to emit items of different types. For example,
 * you can use [ListScope.item] to add a single item and [ListScope.items] to add a list of items.
 *
 * See the other [VerticalList] overload for a variant with a title slot.
 *
 * @sample androidx.xr.glimmer.samples.VerticalListSample
 * @param modifier the modifier to apply to this layout.
 * @param state the state object to be used to control or observe the list's state.
 * @param contentPadding a padding around the whole content. This will add padding for the content
 *   after it has been clipped, which is not possible via [modifier] param. You can use it to add a
 *   padding before the first item or after the last one.
 * @param userScrollEnabled If user gestures are enabled.
 * @param overscrollEffect the [OverscrollEffect] that will be used to render overscroll for this
 *   layout. Note that the [OverscrollEffect.node] will be applied internally as well - you do not
 *   need to use Modifier.overscroll separately.
 * @param flingBehavior logic describing fling and snapping behavior when drag has finished.
 * @param reverseLayout reverses the direction of scrolling and layout.
 * @param horizontalAlignment aligns items horizontally.
 * @param verticalArrangement is arrangement for items. This only applies if the content is smaller
 *   than the viewport.
 * @param content a block which describes the content. Inside this block you can use methods like
 *   [ListScope.item] to add a single item or [ListScope.items] to add a list of items.
 */
@Composable
public fun VerticalList(
    modifier: Modifier = Modifier,
    state: ListState = rememberListState(),
    contentPadding: PaddingValues = VerticalListDefaults.contentPadding,
    userScrollEnabled: Boolean = true,
    overscrollEffect: OverscrollEffect? = rememberOverscrollEffect(),
    flingBehavior: FlingBehavior = VerticalListDefaults.flingBehavior(state),
    reverseLayout: Boolean = false,
    horizontalAlignment: Alignment.Horizontal = Alignment.Start,
    verticalArrangement: Arrangement.Vertical = VerticalListDefaults.verticalArrangement,
    content: ListScope.() -> Unit,
): Unit =
    List(
        orientation = Orientation.Vertical,
        modifier = modifier,
        state = state,
        reverseLayout = reverseLayout,
        contentPadding = contentPadding,
        userScrollEnabled = userScrollEnabled,
        overscrollEffect = overscrollEffect,
        flingBehavior = flingBehavior,
        horizontalAlignment = horizontalAlignment,
        verticalArrangement = verticalArrangement,
        verticalAlignment = null,
        horizontalArrangement = null,
        content = content,
    )

/**
 * This is a scrolling list component that only composes and lays out the currently visible items.
 * It is based on [androidx.compose.foundation.lazy.LazyColumn], but with extra functionality and
 * customized behavior required for Jetpack Compose Glimmer. Jetpack Compose Glimmer applications
 * should always use VerticalList instead of LazyColumn to ensure correct behavior.
 *
 * The [content] block defines a DSL which allows you to emit items of different types. For example,
 * you can use [ListScope.item] to add a single item and [ListScope.items] to add a list of items.
 *
 * This overload of `VerticalList` contains a `title` slot. The title is expected to be a
 * [androidx.xr.glimmer.TitleChip]. It is positioned at the top center and visually overlaps the
 * list content. The list is vertically offset to start from the title's vertical center. When the
 * list is scrolled, the title remains static.
 *
 * See the other [VerticalList] overload for a variant with no title slot.
 *
 * @sample androidx.xr.glimmer.samples.VerticalListWithTitleChipSample
 * @param title a composable slot for the list title, expected to be a
 *   [androidx.xr.glimmer.TitleChip]. It overlaps the list, positioned at the top-center, and
 *   remains stuck to the top when the list is scrolled.
 * @param modifier applies to the layout that contains both list and title.
 * @param state the state object to be used to control or observe the list's state.
 * @param contentPadding a padding around the whole content. This will add padding for the content
 *   after it has been clipped, which is not possible via [modifier] param. You can use it to add a
 *   padding before the first item or after the last one. The list is vertically offset to start
 *   from the title's vertical center, so custom content paddings must provide sufficient space to
 *   avoid content being obscured.
 * @param userScrollEnabled If user gestures are enabled.
 * @param overscrollEffect the [OverscrollEffect] that will be used to render overscroll for this
 *   layout. Note that the [OverscrollEffect.node] will be applied internally as well - you do not
 *   need to use Modifier.overscroll separately.
 * @param flingBehavior logic describing fling and snapping behavior when drag has finished.
 * @param reverseLayout reverses the direction of scrolling and layout.
 * @param horizontalAlignment aligns items horizontally.
 * @param verticalArrangement is arrangement for items. This only applies if the content is smaller
 *   than the viewport.
 * @param content a block which describes the content. Inside this block you can use methods like
 *   [ListScope.item] to add a single item or [ListScope.items] to add a list of items.
 */
@Suppress(
    // The main trailing lambda is [content], but it's DSL.
    "ComposableLambdaParameterNaming",
    "ComposableLambdaParameterPosition",
)
@Composable
public fun VerticalList(
    title: @Composable () -> Unit,
    modifier: Modifier = Modifier,
    state: ListState = rememberListState(),
    contentPadding: PaddingValues = VerticalListDefaults.contentPaddingWithTitle,
    userScrollEnabled: Boolean = true,
    overscrollEffect: OverscrollEffect? = rememberOverscrollEffect(),
    flingBehavior: FlingBehavior = VerticalListDefaults.flingBehavior(state),
    reverseLayout: Boolean = false,
    horizontalAlignment: Alignment.Horizontal = Alignment.Start,
    verticalArrangement: Arrangement.Vertical = VerticalListDefaults.verticalArrangement,
    content: ListScope.() -> Unit,
) {
    VerticalListWithTitleLayout(
        modifier = modifier,
        title = title,
        list = {
            VerticalList(
                state = state,
                contentPadding = contentPadding,
                userScrollEnabled = userScrollEnabled,
                overscrollEffect = overscrollEffect,
                flingBehavior = flingBehavior,
                reverseLayout = reverseLayout,
                horizontalAlignment = horizontalAlignment,
                verticalArrangement = verticalArrangement,
                content = content,
            )
        },
    )
}

/** Contains the default values used by [VerticalList]. */
public object VerticalListDefaults {
    /**
     * Recommended value for the distance between items.
     *
     * @see [verticalArrangement] for the default arrangement that uses this spacing.
     */
    public val itemSpacing: Dp
        @Composable get() = GlimmerTheme.componentSpacingValues.extraLarge

    /** The maximum height of the fade effects on the sides of the list. */
    public val ScrimMaxHeight: Dp = 46.dp

    /** Recommended content padding values for lists without a title. */
    public val contentPadding: PaddingValues
        @Composable get() = PaddingValues(vertical = itemSpacing, horizontal = 0.dp)

    /** Recommended content padding values for lists with a title. */
    public val contentPaddingWithTitle: PaddingValues
        @Composable get() = PaddingValues(top = ScrimMaxHeight, bottom = itemSpacing)

    /** Recommended values for the vertical arrangement. */
    public val verticalArrangement: Arrangement.Vertical
        @Composable get() = Arrangement.spacedBy(itemSpacing)

    /**
     * Creates and remembers the default fling behavior for a [VerticalList] that aligns the focus
     * position with list scroll.
     *
     * @param state The [ListState] to observe for layout and focus information.
     * @return A [FlingBehavior] instance that provides focus-aware snapping.
     */
    @Composable
    public fun flingBehavior(state: ListState): FlingBehavior {
        val snapLayoutInfoProvider = remember(state) { SnapLayoutInfoProvider(state) }
        return rememberSnapFlingBehavior(snapLayoutInfoProvider)
    }
}

@Composable
private fun VerticalListWithTitleLayout(
    modifier: Modifier = Modifier,
    title: @Composable () -> Unit,
    list: @Composable () -> Unit,
) {
    Layout(modifier = modifier, contents = listOf(list, title)) { measurables, constraints ->
        // The title parameter is provided by users, requiring iteration through all measurables.
        // The list parameter is provided by us, allowing to guarantee that it contains only
        // a single measurable.
        val listMeasurable = measurables[0][0]
        val titleMeasurables = measurables[1]
        // Measure title(s) first.
        var titleMaxHeight = 0
        var titleMaxWidth = 0
        val titleConstraints = constraints.copyMaxDimensions()
        val titlePlaceables =
            titleMeasurables.fastMap { measurable ->
                val placeable = measurable.measure(titleConstraints)
                titleMaxHeight = max(titleMaxHeight, placeable.height)
                titleMaxWidth = max(titleMaxWidth, placeable.width)
                placeable
            }

        // List shouldn't use the space above the vertical center of the title.
        val titleYOffset = titleMaxHeight / 2
        val maxListHeight = constraints.maxHeight - titleYOffset
        val minListHeight = minOf(constraints.minHeight, maxListHeight)
        val listConstraints = constraints.copy(minHeight = minListHeight, maxHeight = maxListHeight)
        val listPlaceable = listMeasurable.measure(listConstraints)

        val layoutWidth = maxOf(listPlaceable.width, titleMaxWidth)
        val layoutHeight = listPlaceable.height + titleYOffset
        layout(width = layoutWidth, height = layoutHeight) {
            // Place the list first.
            listPlaceable.placeRelative(
                x = (layoutWidth - listPlaceable.width) / 2,
                y = titleYOffset,
            )
            // Then place the rest of the titles on top of the list.
            titlePlaceables.fastForEach { titlePlaceable ->
                // Each title's center aligned with the top of the list.
                titlePlaceable.placeRelative(
                    x = (layoutWidth - titlePlaceable.width) / 2,
                    y = (titleMaxHeight - titlePlaceable.height) / 2,
                )
            }
        }
    }
}

/**
 * The scrolling list that only composes and lays out the currently visible items. The [content]
 * block defines a DSL which allows you to emit items of different types. For example, you can use
 * [ListScope.item] to add a single item and [ListScope.items] to add a list of items.
 *
 * @param orientation The orientation in which to layout items in this list.
 * @param modifier the modifier to apply to this layout.
 * @param state the state object to be used to control or observe the list's state.
 * @param contentPadding a padding around the whole content. This will add padding for the content
 *   after it has been clipped, which is not possible via [modifier] param. You can use it to add a
 *   padding before the first item or after the last one.
 * @param userScrollEnabled If user gestures are enabled.
 * @param overscrollEffect the [OverscrollEffect] that will be used to render overscroll for this
 *   layout. Note that the [OverscrollEffect.node] will be applied internally as well - you do not
 *   need to use Modifier.overscroll separately.
 * @param flingBehavior logic describing fling and snapping behavior when drag has finished.
 * @param reverseLayout reverses the direction of scrolling and layout.
 * @param horizontalAlignment aligns items horizontally. It's required and used only if
 *   [orientation] is [Orientation.Vertical].
 * @param verticalArrangement is arrangement for items. This only applies if the content is smaller
 *   than the viewport. It's required and used only if [orientation] is [Orientation.Vertical].
 * @param verticalAlignment aligns items vertically. It's required and used only if [orientation] is
 *   [Orientation.Horizontal].
 * @param horizontalArrangement is arrangement for items. This only applies if the content is
 *   smaller than the viewport. It's required and used only if [orientation] is
 *   [Orientation.Vertical].
 * @param content a block which describes the content. Inside this block you can use methods like
 *   [ListScope.item] to add a single item or [ListScope.items] to add a list of items.
 */
@Composable
internal fun List(
    orientation: Orientation,
    modifier: Modifier,
    state: ListState,
    contentPadding: PaddingValues,
    userScrollEnabled: Boolean,
    overscrollEffect: OverscrollEffect?,
    flingBehavior: FlingBehavior,
    reverseLayout: Boolean,
    horizontalAlignment: Alignment.Horizontal?,
    verticalArrangement: Arrangement.Vertical?,
    verticalAlignment: Alignment.Vertical?,
    horizontalArrangement: Arrangement.Horizontal?,
    content: ListScope.() -> Unit,
) {
    val itemProvider = rememberGlimmerListItemProviderLambda(state, content)

    val semanticState = rememberGlimmerListSemanticState(state, orientation)

    val scrollEnabled = isScrollEnabled(userScrollEnabled, state)

    val measurePolicy =
        rememberGlimmerListMeasurePolicy(
            itemProviderLambda = itemProvider,
            state = state,
            contentPadding = contentPadding,
            reverseLayout = reverseLayout,
            orientation = orientation,
            horizontalAlignment = horizontalAlignment,
            verticalArrangement = verticalArrangement,
            verticalAlignment = verticalAlignment,
            horizontalArrangement = horizontalArrangement,
        )

    val beyondBoundsModifier =
        if (scrollEnabled) {
            Modifier.lazyLayoutBeyondBoundsModifier(
                state = rememberGlimmerListBeyondBoundsState(state),
                beyondBoundsInfo = state.beyondBoundsInfo,
                reverseLayout = reverseLayout,
                orientation = orientation,
            )
        } else {
            Modifier
        }

    LazyLayout(
        modifier =
            modifier
                .then(state.remeasurementModifier)
                .then(state.awaitLayoutModifier)
                .autoFocus(state.autoFocusState)
                .lazyLayoutSemantics(
                    itemProviderLambda = itemProvider,
                    state = semanticState,
                    orientation = orientation,
                    userScrollEnabled = scrollEnabled,
                    reverseScrolling = reverseLayout,
                )
                .then(beyondBoundsModifier)
                .edgeScrim(
                    state = state.scrollIndicatorState,
                    orientation = orientation,
                    maxScrimSize = VerticalListDefaults.ScrimMaxHeight,
                )
                .scrollableArea(
                    state = state,
                    orientation = orientation,
                    enabled = scrollEnabled,
                    interactionSource = state.internalInteractionSource,
                    overscrollEffect = overscrollEffect,
                    flingBehavior = flingBehavior,
                ),
        itemProvider = itemProvider,
        measurePolicy = measurePolicy,
    )
}

@Composable
private fun isScrollEnabled(userScrollEnabled: Boolean, state: ListState): Boolean {
    if (userScrollEnabled) {
        val derivedState =
            remember(state) { derivedStateOf { state.canScrollForward || state.canScrollBackward } }
        return derivedState.value
    } else {
        return false
    }
}
```

<br />