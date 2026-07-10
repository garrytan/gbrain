When creating a Glimmer Stack component, refer to the following source code in
`StackState.kt` for creating a state for the stack:


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

import androidx.annotation.IntRange
import androidx.collection.MutableIntIntMap
import androidx.compose.animation.core.AnimationSpec
import androidx.compose.animation.core.spring
import androidx.compose.foundation.MutatePriority
import androidx.compose.foundation.gestures.ScrollScope
import androidx.compose.foundation.gestures.ScrollableState
import androidx.compose.foundation.interaction.InteractionSource
import androidx.compose.foundation.pager.PagerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.State
import androidx.compose.runtime.annotation.FrequentlyChangingValue
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.FocusState
import androidx.compose.ui.unit.IntSize

/**
 * Creates and remembers a [StackState] for a [VerticalStack].
 *
 * The returned [StackState] is remembered across compositions and can be used to control or observe
 * the state of a [VerticalStack]. It's essential to pass this state to the `state` parameter of the
 * corresponding [VerticalStack] composable.
 *
 * Note: Properties of the state will only be correctly populated after the [VerticalStack] it is
 * associated with has been composed for the first time.
 *
 * Warning: A single [StackState] instance must not be shared across multiple [VerticalStack]
 * composables.
 *
 * @param initialTopItem The index of the item to show at the top of the stack initially. Must be
 *   non-negative. Defaults to 0.
 * @see StackState
 * @see VerticalStack
 */
@Composable
public fun rememberStackState(@IntRange(from = 0) initialTopItem: Int = 0): StackState =
    rememberSaveable(saver = StackState.Saver) { StackState(initialTopItem) }

/**
 * The [VerticalStack] state that allows programmatic control and observation of the stack's state.
 *
 * A [StackState] object can be created and remembered using [rememberStackState].
 *
 * Note: Properties of the state will only be correctly populated after the [VerticalStack] it is
 * associated with has been composed for the first time.
 *
 * Warning: A single [StackState] instance must not be shared across multiple [VerticalStack]
 * composables.
 *
 * @param initialTopItem The index of the item to show at the top of the stack initially. Must be
 *   non-negative. Defaults to 0.
 * @see rememberStackState
 * @see VerticalStack
 */
// TODO(b/413429531): add ScrollIndicatorState.
@Stable
public class StackState(@IntRange(from = 0) initialTopItem: Int = 0) : ScrollableState {

    init {
        require(initialTopItem >= 0) { "initialTopItem must be non-negative" }
    }

    internal var itemCount by mutableIntStateOf(0)

    internal val pagerState = PagerState(currentPage = initialTopItem, pageCount = { itemCount })

    /** The index of the item that's currently at the top of the stack, defaults to 0. */
    public val topItem: Int
        get() = topItemState.value

    /**
     * Backing state for [topItem] derived from [PagerState.currentPage] and
     * [PagerState.currentPageOffsetFraction].
     *
     * In Stack, an item is considered the top of the stack item until it completely moves off the
     * viewport (when scrolling forward), or until the previous item enters the viewport (when
     * scrolling backward).
     */
    internal val topItemState = derivedStateOf {
        if (pagerState.currentPageOffsetFraction >= 0) pagerState.currentPage
        else pagerState.currentPage - 1
    }

    /**
     * The offset of the top item as a fraction of the stack item container size. The value
     * indicates how much the item is offset from the snapped position. This value ranges between
     * 0.0 (snapped position) and 1.0 (lower bound of the top item is at the top of the viewport).
     */
    public val topItemOffsetFraction: Float
        @FrequentlyChangingValue
        get() {
            // In Pager, [PagerState.currentPage] changes to the next page when the current page
            // scrolls more than half way off the viewport, which is also when
            // [PagerState.currentPageOffsetFraction] reaches 0.5. Similarly, when scrolling back,
            // the [PagerState.currentPage] switches to the previous page when
            // [PagerState.currentPageOffsetFraction] reaches -0.5. In other words, the current
            // page's offset fraction ranges between -0.5 and 0.5. In Stack, an item is considered
            // the top of the stack item until it completely moves off the viewport when scrolling
            // forward, or until the previous item enters the viewport when scrolling backward. In
            // other words, the top item's offset fraction ranges between 0 (at the snapped
            // position) to 1.0 (at the top of the viewport).
            val currentPageOffsetFraction = pagerState.currentPageOffsetFraction
            return if (currentPageOffsetFraction >= 0) currentPageOffsetFraction
            else currentPageOffsetFraction + 1f
        }

    /**
     * [InteractionSource] that's used to dispatch drag events when this stack is being dragged. To
     * know whether a fling (or animated scroll) is in progress, use [isScrollInProgress].
     */
    public val interactionSource: InteractionSource
        get() = pagerState.interactionSource

    /**
     * Contains useful information about the currently displayed layout of this stack. The
     * information is available after the first measure pass.
     */
    // TODO(b/446933128): when making layoutInfo public, consider making it a State.
    internal val layoutInfoInternal = StackLayoutInfoImpl(pagerState, topItemState)

    private var hasFocus: Boolean = false
    private var focusedItem: Int = initialTopItem

    /**
     * Scroll (jump immediately) to a given [item] index.
     *
     * @param item The index of the destination item
     */
    public suspend fun scrollToItem(item: Int) {
        if (itemCount == 0) return
        pagerState.scrollToPage(item.coerceIn(0, itemCount - 1))
    }

    /**
     * Scroll animate to a given [item]'s closest snap position. If the [item] is too far away from
     * [topItem], not all the items in the range will be composed. Instead, the stack will jump to a
     * nearer item, then compose and animate the rest of the items until the destination [item].
     *
     * @param item The index of the destination item
     * @param animationSpec An [AnimationSpec] to move between items
     */
    public suspend fun animateScrollToItem(
        item: Int,
        animationSpec: AnimationSpec<Float> = spring(),
    ) {
        if (itemCount == 0) return
        pagerState.animateScrollToPage(
            item.coerceIn(0, itemCount - 1),
            pageOffsetFraction = 0f,
            animationSpec,
        )
    }

    override suspend fun scroll(
        scrollPriority: MutatePriority,
        block: suspend ScrollScope.() -> Unit,
    ) {
        if (itemCount == 0) return
        pagerState.scroll(scrollPriority, block)
    }

    override fun dispatchRawDelta(delta: Float): Float {
        if (itemCount == 0) return 0f
        return pagerState.dispatchRawDelta(delta)
    }

    override val isScrollInProgress: Boolean
        get() = pagerState.isScrollInProgress

    @get:Suppress("GetterSetterNames")
    override val canScrollForward: Boolean
        get() = pagerState.currentPage < pagerState.pageCount - 1

    @get:Suppress("GetterSetterNames")
    override val canScrollBackward: Boolean
        get() = pagerState.currentPage > 0

    @get:Suppress("GetterSetterNames")
    override val lastScrolledForward: Boolean
        get() = pagerState.lastScrolledForward

    @get:Suppress("GetterSetterNames")
    override val lastScrolledBackward: Boolean
        get() = pagerState.lastScrolledBackward

    /** Callback for top-level (pager-level) focus state changes. */
    internal fun onTopLevelFocusChanged(focusState: FocusState) {
        hasFocus = focusState.hasFocus
    }

    /** Callback for item-level focus state changes for the item at [index]. */
    internal fun onItemFocusChanged(index: Int, focusState: FocusState) {
        if (focusState.isFocused) focusedItem = index
    }

    /**
     * Moves focus to [index] either to the current top item or the next item depending on whether
     * the top item has moved past [FocusMoveThreshold] and if the item is not already in focus.
     *
     * If the stack doesn't already have focus, the auto focus logic doesn't apply.
     */
    internal fun notifyAutoFocus(index: Int, focusRequester: FocusRequester) {
        if (!hasFocus) {
            // Do not move focus if the stack doesn't already have focus.
            return
        }

        val topItemValue = topItem
        val intendedFocusedItem =
            if (topItemOffsetFraction < FocusMoveThreshold) topItemValue
            else (topItemValue + 1).coerceAtMost(itemCount - 1)

        if (intendedFocusedItem != index) {
            // The intended focused item is not the item at the requested index.
            return
        }

        if (intendedFocusedItem == focusedItem) {
            // No need to move focus if the intended focused item is already in focus.
            return
        }

        focusRequester.requestFocus()
    }

    public companion object {
        /** The default [Saver] implementation for [StackState]. */
        public val Saver: Saver<StackState, *> =
            Saver(save = { it.topItem }, restore = { StackState(it) })
    }
}

/**
 * Contains useful information about the currently displayed layout of a [VerticalStack]. This
 * information is available after the first measure pass.
 *
 * Use [StackState.layoutInfoInternal] to retrieve this.
 */
@Stable
internal sealed interface StackLayoutInfo {
    // TODO(b/446933128): decide what properties should be exposed as public States.
}

/** The default implementation of [StackLayoutInfo]. */
internal class StackLayoutInfoImpl
internal constructor(private val pagerState: PagerState, private val topItemState: State<Int>) :
    StackLayoutInfo {

    /** The overall size of this stack's viewport. */
    internal val viewportSize: IntSize
        get() = pagerState.layoutInfo.viewportSize

    /** The measured height of the top of the stack item. */
    internal val measuredTopItemHeight: Int
        get() = measuredHeights.getOrDefault(topItemState.value, defaultValue = 0)

    /** The measured height of the item following the top of the stack item. */
    internal val measuredNextItemHeight: Int
        get() = measuredHeights.getOrDefault(topItemState.value + 1, defaultValue = 0)

    /** The measured height of the item following the next item in the stack. */
    internal val measuredNextNextItemHeight: Int
        get() = measuredHeights.getOrDefault(topItemState.value + 2, defaultValue = 0)

    /** The backing storage for measured item heights keyed by item index. */
    // TODO(b/446933128): remove this once PageInfo exposes page sizes.
    private val measuredHeights: MutableIntIntMap = MutableIntIntMap()

    /**
     * Updates the measured height of the item at the specified index and trims heights for items
     * outside of the close range to the top item.
     */
    internal fun updateMeasuredHeight(index: Int, height: Int) {
        measuredHeights.put(index, height)

        // Clean up measured heights for items that are not in the close range to the top item.
        // TODO(b/446933128): find a way to access currentPage inside of withoutReadObservation.
        val currentPage = pagerState.currentPage
        Snapshot.withoutReadObservation {
            val itemCount = pagerState.pageCount
            val itemRange = currentPage - 2..(currentPage + 3).coerceAtMost(itemCount - 1)
            measuredHeights.removeIf { index, _ -> index !in itemRange }
        }
    }
}

/**
 * The threshold of [StackState.topItemOffsetFraction] past which focus should automatically move to
 * the next item.
 */
private const val FocusMoveThreshold = 0.6f
```

<br />