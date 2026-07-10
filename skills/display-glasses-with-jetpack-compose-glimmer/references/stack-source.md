When creating a Glimmer Stack component, refer to the following source code in
`Stack.kt`:


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

package androidx.xr.glimmer.stack

import androidx.compose.animation.core.VisibilityThreshold
import androidx.compose.animation.core.spring
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.pager.PagerDefaults
import androidx.compose.foundation.pager.PagerSnapDistance
import androidx.compose.foundation.pager.PagerState
import androidx.compose.foundation.pager.VerticalPager
import androidx.compose.runtime.Composable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.referentialEqualityPolicy
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.onPlaced
import androidx.compose.ui.unit.dp
import androidx.compose.ui.util.fastFirstOrNull
import androidx.compose.ui.util.fastForEach
import androidx.compose.ui.util.fastMap
import androidx.compose.ui.util.lerp
import androidx.compose.ui.zIndex
import androidx.xr.glimmer.internal.SingleItemScrollConstraintConnection
import kotlin.math.roundToInt

/**
 * [VerticalStack] is a lazy, vertically scrollable layout that arranges its items in a visually
 * overlapping, three-dimensional sequence, which resembles a deck of cards. The primary item is
 * prominently displayed in the foreground. Subsequent items are positioned behind the primary item
 * along the z-axis with a small portion of the next item revealed to indicate depth and upcoming
 * content.
 *
 * As the user scrolls vertically, the active foreground item transitions out of view, allowing the
 * item immediately beneath it to slide into the prominent foreground position. Items always
 * snap-animate into the foreground position after the user's gesture ends.
 *
 * Note: When displaying text within a [VerticalStack], it is strongly recommended to set
 * [androidx.compose.ui.text.TextStyle.textMotion] to
 * [androidx.compose.ui.text.style.TextMotion.Animated]. This ensures smooth rendering during layout
 * animations or scaling transitions, preventing pixel-snapping artifacts.
 *
 * @sample androidx.xr.glimmer.samples.VerticalStackSample
 * @param modifier the modifier to apply to this layout.
 * @param state the state of the stack.
 * @param content a block that describes the content. Inside this block you can use methods like
 *   [StackScope.item] to add a single item or [StackScope.items] to add a collection of items.
 */
@Composable
public fun VerticalStack(
    modifier: Modifier = Modifier,
    state: StackState = rememberStackState(),
    content: StackScope.() -> Unit,
) {
    val latestContent = rememberUpdatedState(content)
    val stackItemHolderState =
        remember(state) {
            // Re-run the DSL to parse items only when the content lambda instance changes.
            derivedStateOf(referentialEqualityPolicy()) {
                    StackItemHolder(state, latestContent.value).also {
                        // Set the item count on the StackState immediately when the derived state
                        // re-evaluates (i.e., when content changes), even before recomposition.
                        state.itemCount = it.itemCount
                    }
                }
                .also {
                    // This second assignment is necessary to force the derivedStateOf lambda above
                    // (which is executed lazily) to execute synchronously inside this block.
                    state.itemCount = it.value.itemCount
                }
        }

    val singleItemScrollConstraintConnection =
        remember(state.pagerState) { SingleItemScrollConstraintConnection(state.pagerState) }

    VerticalPager(
        state = state.pagerState,
        modifier =
            modifier
                .then(StackInitialFocusElement(state))
                .stackScrim()
                .nestedScroll(singleItemScrollConstraintConnection),
        contentPadding = PaddingValues(bottom = RevealAreaSize),
        key = { page -> stackItemHolderState.value.getKey(page) },
        beyondViewportPageCount = MaxNextVisibleItemCount,
        flingBehavior =
            PagerDefaults.flingBehavior(
                state = state.pagerState,
                pagerSnapDistance = PagerSnapDistance.atMost(1),
                snapAnimationSpec = SnapAnimationSpec,
            ),
    ) { page ->
        val stackItemHolder = stackItemHolderState.value
        stackItemHolder.withInterval(page) { localIndex, itemInterval ->
            val key =
                itemInterval.getKeyOrDefault(globalIndex = page, localIntervalIndex = localIndex)
            val itemScope = itemInterval.getOrCreateItemScope(key)
            itemScope.index = page
            StackItemLayout(page = page, state = state, itemScope = itemScope) {
                itemInterval.item(itemScope, localIndex)
            }
        }
    }
}

@Composable
private fun StackItemLayout(
    page: Int,
    state: StackState,
    itemScope: StackItemScopeImpl,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    val focusRequester = remember { FocusRequester() }
    Layout(
        content = content,
        modifier =
            modifier
                .zIndex(-page.toFloat())
                .onPlaced { itemScope.coordinates = it }
                .maskItemsBelow(state, itemScope)
                .focusRequester(focusRequester)
                .onFocusChanged { state.onItemFocusChanged(page, it) },
    ) { measurables, constraints ->
        var maxWidth = 0
        var maxHeight = 0
        val placeables =
            measurables.fastMap {
                it.measure(constraints).also { placeable ->
                    maxWidth = maxOf(maxWidth, placeable.width)
                    maxHeight = maxOf(maxHeight, placeable.height)
                }
            }

        if (!isLookingAhead) {
            state.layoutInfoInternal.updateMeasuredHeight(index = page, height = maxHeight)
        }

        layout(maxWidth, maxHeight) {
            placeables.fastForEach { placeable ->
                placeable.placeRelativeWithLayer(x = 0, y = 0) {
                    val revealHeight = RevealAreaSize.roundToPx()
                    val topItem = state.topItem
                    when {
                        page.isTopItem(topItem = topItem) -> {
                            translationY =
                                state.topItemTranslationY(
                                    revealHeight = revealHeight,
                                    topItemHeight = placeable.height,
                                )

                            state.notifyAutoFocus(page, focusRequester)
                        }

                        page.isNextItem(topItem = topItem) -> {
                            translationY =
                                state.nextItemTranslationY(
                                    revealHeight = revealHeight,
                                    topItem = topItem,
                                    nextItemHeight = placeable.height,
                                )
                            val scale = state.nextItemScale()
                            scaleX = scale
                            scaleY = scale

                            state.notifyAutoFocus(page, focusRequester)
                        }

                        page.isNextNextItem(topItem = topItem) -> {
                            translationY =
                                state.nextNextItemTranslationY(
                                    revealHeight = revealHeight,
                                    topItem = topItem,
                                    nextNextItemHeight = placeable.height,
                                )
                            scaleX = NextItemMinScale
                            scaleY = NextItemMinScale
                        }
                    }
                }
            }
        }
    }
}

/**
 * Masks the items following the current item (items that are below the current item on Z-axis) if
 * the item's decoration fills the viewport width.
 */
private fun Modifier.maskItemsBelow(state: StackState, itemScope: StackItemScopeImpl): Modifier =
    this.drawWithContent {
        val viewportSize = state.layoutInfoInternal.viewportSize
        val viewportWidth = viewportSize.width.toFloat()

        if (itemScope.maskWidth >= (viewportWidth - DecorationWidthNoiseThresholdPx)) {
            // Only apply the mask to the items below (Z-axis) if the mask fills the viewport width.
            val viewportHeight = viewportSize.height.toFloat()
            drawRect(
                Color.Black,
                blendMode = BlendMode.DstOut,
                // The coordinate space here is for the item's layout, which changes position in the
                // stack viewport depending on the scroll position. We need to deduct the viewport
                // height to make the starting Y offset negative, so that the mask region extends
                // upwards to the top of the stack viewport.
                topLeft = Offset(x = 0f, y = itemScope.maskBottomY - viewportHeight),
                size = Size(width = viewportWidth, height = viewportHeight),
            )
        }

        drawContent()
    }

/**
 * The translation Y of the top item in pixels, which is always equal to the snapped position
 * offset.
 */
private fun StackState.topItemTranslationY(revealHeight: Int, topItemHeight: Int) =
    calculateTopPositionOffset(topItemHeight, revealHeight)

/** The current translation Y of the next item in pixels. */
private fun StackState.nextItemTranslationY(
    revealHeight: Int,
    topItem: Int,
    nextItemHeight: Int,
): Float {
    val nextPageOffset = pagerState.pageOffset(topItem + 1)
    val progress = topItemOffsetFraction
    val topItemHeight = layoutInfoInternal.measuredTopItemHeight

    val topPageTopPositionOffset = calculateTopPositionOffset(topItemHeight, revealHeight)
    val nextPageTopPositionOffset = calculateTopPositionOffset(nextItemHeight, revealHeight)

    val topItemBottom = topPageTopPositionOffset + topItemHeight
    // startOffset is the initial offset of the next item when it's revealed below the top item.
    val startOffset =
        calculateInitialBehindPosition(
            itemAboveBottom = topItemBottom + revealHeight,
            itemBehindHeight = nextItemHeight,
        )

    val currentOffset =
        lerp(start = startOffset, stop = nextPageTopPositionOffset, fraction = progress)

    return currentOffset - nextPageOffset
}

/** The current scale of the next item. */
private fun StackState.nextItemScale(): Float {
    val progress = topItemOffsetFraction
    return lerp(start = NextItemMinScale, stop = 1f, fraction = progress)
}

/** The current translation Y of the next-next item in pixels. */
private fun StackState.nextNextItemTranslationY(
    revealHeight: Int,
    topItem: Int,
    nextNextItemHeight: Int,
): Float {
    val nextNextPageOffset = pagerState.pageOffset(topItem + 2)
    val nextItemHeight = layoutInfoInternal.measuredNextItemHeight

    // Calculate where the next item *would* be if it were currently the top item.
    val nextItemTopPositionOffset = calculateTopPositionOffset(nextItemHeight, revealHeight)
    val nextItemTopPositionBottom = nextItemTopPositionOffset + nextItemHeight

    // Calculate the static target position the next-next item.
    // We add revealHeight to nextItemBottom to ensure the item waits at the exact position
    // where it will need to be when it transitions to being the next item.
    val offset =
        calculateInitialBehindPosition(
            itemAboveBottom = nextItemTopPositionBottom + revealHeight,
            itemBehindHeight = nextNextItemHeight,
        )

    return offset - nextNextPageOffset
}

/**
 * Calculates the offset from the top of the viewport for an item of a given height for the item's
 * top snapped position. Items are aligned to the bottom of the stack layout.
 */
private fun StackState.calculateTopPositionOffset(itemHeight: Int, revealHeight: Int): Float {
    val viewportHeight = layoutInfoInternal.viewportSize.height
    return (viewportHeight - itemHeight - revealHeight).coerceAtLeast(0).toFloat()
}

/** Calculates the initial offset for an item when it is positioned behind the item above it. */
private fun calculateInitialBehindPosition(itemAboveBottom: Float, itemBehindHeight: Int): Float =
    itemAboveBottom - itemBehindHeight * NextItemPositioningScale

/**
 * The main axis offset of the item in pixels from the top of the viewport.
 *
 * If the page is in the visible list (inside the viewport), we return its exact offset. If it's not
 * in the list but is composed (due to beyondViewportPageCount), we calculate where it *should* be
 * based on the current page and offset fraction.
 *
 * Note: this method assumes that the Pager's layoutInfo is already available.
 */
private fun PagerState.pageOffset(page: Int): Int {
    val layoutInfo = layoutInfo

    // First check if the page is already visible.
    val visiblePage = layoutInfo.visiblePagesInfo.fastFirstOrNull { it.index == page }
    if (visiblePage != null) return visiblePage.offset

    // Calculate the distance in "pages" from the current snap position.
    // (page - currentPage) gives the index distance.
    // (- currentPageOffsetFraction) accounts for the sub-page scroll.
    val offsetFromCurrentPage = page - currentPage - currentPageOffsetFraction
    val stride = layoutInfo.pageSize + layoutInfo.pageSpacing
    return (offsetFromCurrentPage * stride).roundToInt()
}

/** The size of the area where the items beneath the top of the stack item are revealed. */
internal val RevealAreaSize = 18.dp

/** The maximum number of items that can be visible at the same time in addition to the top item. */
private const val MaxNextVisibleItemCount = 2

/**
 * The scale of the next item when it is fully behind the top item, and the default scale of the
 * item behind it (the next-next item).
 */
private const val NextItemMinScale = 0.94f

/** The scale factor that's between 1.0 and [NextItemMinScale], which is used in positioning. */
private const val NextItemPositioningScale = 0.97f // (1f + NextItemMinScale) / 2f

/** The animation spec used for snapping stack items. */
private val SnapAnimationSpec =
    spring(
        dampingRatio = 0.56f,
        stiffness = 118f,
        visibilityThreshold = Int.VisibilityThreshold.toFloat(),
    )
```

<br />