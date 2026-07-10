When creating a Glimmer Stack component, refer to the following source code in
`StackItemScope.kt` for setting the stack item scope:


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

import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.PathMeasure
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.drawOutline
import androidx.compose.ui.graphics.drawscope.ContentDrawScope
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.node.CompositionLocalConsumerModifierNode
import androidx.compose.ui.node.DelegatingNode
import androidx.compose.ui.node.DrawModifierNode
import androidx.compose.ui.node.LayoutAwareModifierNode
import androidx.compose.ui.node.ModifierNodeElement
import androidx.compose.ui.node.currentValueOf
import androidx.compose.ui.platform.InspectorInfo
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.toSize
import androidx.compose.ui.util.fastForEach
import androidx.xr.glimmer.DepthEffectNode
import androidx.xr.glimmer.GlimmerTheme.Companion.LocalGlimmerTheme
import kotlin.math.abs

/** Receiver scope used by item content in [VerticalStack]. */
@Stable
public sealed interface StackItemScope {

    /**
     * Adds a decoration shape for this item, which is used in graphical effects applied to stack
     * items, e.g., item masking and depth effects. For each distinct shape inside a stack item,
     * this modifier should be applied to match that shape's bounds. For simple items with just one
     * shape (such as a card), only one modifier is needed.
     *
     * Applying this modifier is optional but highly recommended. If not applied, the item will
     * render normally but will not have the expected depth effect or masking behavior. Omitting
     * this modifier is a valid use case when no visual item decoration effects are desired.
     *
     * @sample androidx.xr.glimmer.samples.VerticalStackSample
     * @sample androidx.xr.glimmer.samples.VerticalStackWithMultipleShapesSample
     * @param shape The shape of the element this modifier is applied to.
     */
    public fun Modifier.itemDecoration(shape: Shape): Modifier =
        this then ItemDecorationElement(this@StackItemScope as StackItemScopeImpl, shape)
}

internal class ItemDecorationElement
internal constructor(private val stackItemScope: StackItemScopeImpl, private val shape: Shape) :
    ModifierNodeElement<ItemDecorationNode>() {

    override fun create(): ItemDecorationNode = ItemDecorationNode(stackItemScope, shape)

    override fun update(node: ItemDecorationNode) {
        node.update(stackItemScope, shape)
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is ItemDecorationElement) return false

        if (stackItemScope != other.stackItemScope) return false
        if (shape != other.shape) return false

        return true
    }

    override fun hashCode(): Int {
        var result = stackItemScope.hashCode()
        result = 31 * result + shape.hashCode()
        return result
    }

    override fun InspectorInfo.inspectableProperties() {
        name = "stackItemDecoration"
        properties["shape"] = shape
    }
}

internal class StackItemScopeImpl(internal val state: StackState) : StackItemScope {

    internal var index = -1
    internal val decorations = mutableListOf<ItemDecorationNode>()
    internal var coordinates: LayoutCoordinates? = null

    internal var maskWidth by mutableFloatStateOf(0f)
        private set

    internal var maskBottomY by mutableFloatStateOf(0f)
        private set

    internal fun recalculateMask() {
        // First find the max width to avoid unnecessary calls to calculateMaskBottomYInItem.
        var maxDecorationWidth = 0f
        decorations.fastForEach { decoration ->
            val width = decoration.outline?.bounds?.width ?: 0f
            if (width > maxDecorationWidth) {
                maxDecorationWidth = width
            }
        }

        if (maxDecorationWidth <= 0f) {
            maskWidth = 0f
            maskBottomY = 0f
            return
        }

        var selectedDecoration: ItemDecorationNode? = null
        var selectedDecorationMaskBottomY = 0f

        decorations.fastForEach { decoration ->
            val outline = decoration.outline ?: return@fastForEach
            val bounds = outline.bounds

            // Skip decorations that are narrower than the max found.
            if (abs(bounds.width - maxDecorationWidth) > DecorationWidthNoiseThresholdPx) {
                return@fastForEach
            }

            val decorationMaskBottomY = decoration.calculateMaskBottomYInItem()
            if (selectedDecoration == null) {
                selectedDecoration = decoration
                selectedDecorationMaskBottomY = decorationMaskBottomY
            } else {
                // Tie-breaking: prefer higher widest point (smaller Y).
                if (decorationMaskBottomY < selectedDecorationMaskBottomY) {
                    selectedDecoration = decoration
                    selectedDecorationMaskBottomY = decorationMaskBottomY
                }
            }
        }

        maskWidth = selectedDecoration?.outline?.bounds?.width ?: 0f
        maskBottomY = selectedDecorationMaskBottomY
    }
}

internal class ItemDecorationNode(
    private var stackItemScope: StackItemScopeImpl,
    private var shape: Shape,
) :
    DelegatingNode(),
    LayoutAwareModifierNode,
    CompositionLocalConsumerModifierNode,
    DrawModifierNode {

    internal var size = Size.Zero
    internal var outline: Outline? = null
    internal var offset: Offset = Offset.Zero

    private var depthEffectNode: DepthEffectNode? = null
    private var coordinates: LayoutCoordinates? = null

    private var lastOutlineForCachedMaskBottomY: Outline? = null
    private var cachedMaskBottomY: Float = 0f

    private var minX = FloatArray(0)
    private var maxX = FloatArray(0)
    private var pathMeasure: PathMeasure? = null

    override fun onAttach() {
        depthEffectNode = delegate(DepthEffectNode(currentValueOfDepth(), shape))
        stackItemScope.decorations.add(this)
        if (size != Size.Zero) {
            // If this node is reused, update the decoration in case there is no remeasure.
            updateDecoration()
        }
    }

    override fun onRemeasured(size: IntSize) {
        this.size = size.toSize()
        updateDecoration()
    }

    override fun onPlaced(coordinates: LayoutCoordinates) {
        this.coordinates = coordinates
        offset = calculateDecorationOffset()
        stackItemScope.recalculateMask()
    }

    override fun onDetach() {
        stackItemScope.decorations.remove(this)
        depthEffectNode?.let { undelegate(it) }
    }

    override fun ContentDrawScope.draw() {
        val index = stackItemScope.index
        if (index == -1) return
        val state = stackItemScope.state
        val topItem = state.topItem
        val offsetFraction = state.topItemOffsetFraction

        val contentAlpha =
            calculateContentAlpha(index = index, topItem = topItem, offsetFraction = offsetFraction)

        // Apply alpha to the depth separately from the content so that the shadows are not clipped.
        depthEffectNode?.apply { drawDepthEffect(alpha = contentAlpha) }

        // Draw item content with a scrim based on the current alpha.
        drawContent()

        val scrimAlpha =
            calculateScrimAlpha(index = index, topItem = topItem, offsetFraction = offsetFraction)
        val scrimColor = getScrimColor(index = index, topItem = topItem)
        val outline = getDecorationOutline()
        scrimColor?.let {
            // If there is a scrim color, apply it on top of the item.
            drawOutline(outline = outline, color = it, alpha = scrimAlpha)
        }

        if (contentAlpha < 1f) {
            drawOutline(
                outline = outline,
                blendMode = BlendMode.DstOut,
                color = Color.Black,
                alpha = 1f - contentAlpha,
            )
        }
    }

    fun update(stackItemScope: StackItemScopeImpl, shape: Shape) {
        depthEffectNode?.update(currentValueOfDepth(), shape)
        if (this.stackItemScope != stackItemScope || this.shape != shape) {
            this.stackItemScope.decorations.remove(this)
            stackItemScope.decorations.add(this)
            this.stackItemScope = stackItemScope
            this.shape = shape
            updateDecoration()
        }
    }

    internal fun getOrCalculateMaskBottomY(): Float {
        if (outline !== lastOutlineForCachedMaskBottomY) {
            cachedMaskBottomY = outline?.calculateMaskBottomY() ?: 0f
            lastOutlineForCachedMaskBottomY = outline
        }
        return cachedMaskBottomY
    }

    private fun ContentDrawScope.getDecorationOutline(): Outline {
        outline?.let {
            return it
        }
        return shape.createOutline(size, layoutDirection, this).also { outline = it }
    }

    private fun updateDecoration() {
        if (size == Size.Zero || !isAttached) return

        offset = calculateDecorationOffset()
        outline = createOutline()

        stackItemScope.recalculateMask()
    }

    private fun createOutline(): Outline {
        val density = currentValueOf(LocalDensity)
        val layoutDirection = currentValueOf(LocalLayoutDirection)
        return shape.createOutline(size, layoutDirection, density)
    }

    private fun calculateDecorationOffset(): Offset =
        coordinates?.let { decorationCoordinates ->
            stackItemScope.coordinates?.localPositionOf(
                sourceCoordinates = decorationCoordinates,
                relativeToSource = Offset.Zero,
            )
        } ?: Offset.Zero

    private fun calculateContentAlpha(index: Int, topItem: Int, offsetFraction: Float): Float =
        when {
            index.isTopItem(topItem = topItem) -> 1f - offsetFraction
            index.isNextItem(topItem = topItem) -> 1f
            index.isNextNextItem(topItem = topItem) -> offsetFraction
            else -> 0f
        }

    private fun calculateScrimAlpha(index: Int, topItem: Int, offsetFraction: Float): Float =
        when {
            index.isNextItem(topItem = topItem) -> (1f - offsetFraction) * MaxItemScrimAlpha
            index.isNextNextItem(topItem = topItem) -> MaxItemScrimAlpha
            else -> 0f
        }

    private fun getScrimColor(index: Int, topItem: Int): Color? =
        when {
            index.isNextItem(topItem = topItem) -> SurfaceLow
            index.isNextNextItem(topItem = topItem) -> SurfaceLow
            else -> null
        }

    private fun currentValueOfDepth() = currentValueOf(LocalGlimmerTheme).depthEffectLevels.level1

    /**
     * Returns the Y coordinate within [Outline] where the bottom boundary of the mask should be.
     */
    private fun Outline.calculateMaskBottomY(): Float =
        when (this) {
            is Outline.Rectangle -> 0f
            is Outline.Rounded ->
                // The mask's bottom is where the top corners of the round rect start curving.
                roundRect.top +
                    maxOf(roundRect.topLeftCornerRadius.y, roundRect.topRightCornerRadius.y)
            is Outline.Generic -> calculateYAtWidestPoint(this)
        }

    /**
     * Returns the Y coordinate within [Outline] where the outline is the widest.
     *
     * This uses a heuristic approach by sampling points along the path perimeter using
     * [PathMeasure] and aggregating them into vertical buckets to determine the min/max X for a
     * given Y. Shapes with sharp horizontal features might have their width slightly under-reported
     * depending on sampling phase.
     */
    private fun calculateYAtWidestPoint(outline: Outline.Generic): Float {
        val bounds = outline.bounds
        val height = bounds.height
        if (height <= 0f) return 0f

        // 1 bucket every 2 pixels clamped to a reasonable range.
        val resolution =
            (height / 2)
                .toInt()
                .coerceIn(
                    minimumValue = MinWidestPointSearchResolution,
                    maximumValue = MaxWidestPointSearchResolution,
                )

        if (minX.size < resolution || maxX.size < resolution) {
            // Allocate for max resolution to avoid reallocating the arrays on size changes.
            minX = FloatArray(MaxWidestPointSearchResolution)
            maxX = FloatArray(MaxWidestPointSearchResolution)
        }

        minX.fill(Float.POSITIVE_INFINITY, fromIndex = 0, toIndex = resolution)
        maxX.fill(Float.NEGATIVE_INFINITY, fromIndex = 0, toIndex = resolution)

        val measure = pathMeasure ?: PathMeasure().also { pathMeasure = it }
        measure.setPath(outline.path, forceClosed = true)
        val length = measure.length
        if (length == 0f) return 0f

        // 2 samples per bucket.
        val totalSamples = resolution * 2
        val stepSize = length / totalSamples

        // Scale for converting Y to a bucket index.
        val indexScale = (resolution - 1) / height
        val boundsTop = bounds.top

        var distance = 0f
        while (distance <= length) {
            val position = measure.getPosition(distance)
            val x = position.x
            val y = position.y

            val relativeY = y - boundsTop
            val bucketIndex = (relativeY * indexScale).toInt().coerceIn(0, resolution - 1)

            if (x < minX[bucketIndex]) minX[bucketIndex] = x
            if (x > maxX[bucketIndex]) maxX[bucketIndex] = x

            distance += stepSize
        }

        // Default to the vertical center if no points are processed or path is empty.
        var selectedIndex = resolution / 2
        var maxFoundWidth = -1f
        for (i in 0 until resolution) {
            if (minX[i] == Float.POSITIVE_INFINITY || maxX[i] == Float.NEGATIVE_INFINITY) continue
            val width = maxX[i] - minX[i]
            // If widths are effectively equal, we preserve the lower index.
            if (width > maxFoundWidth + DecorationWidthNoiseThresholdPx) {
                maxFoundWidth = width
                selectedIndex = i
            }
        }

        return boundsTop + (height * selectedIndex / resolution.toFloat())
    }
}

/**
 * Calculates the Y coordinate within the stack item where the bottom boundary of the mask should
 * be.
 */
private fun ItemDecorationNode.calculateMaskBottomYInItem(): Float =
    offset.y + getOrCalculateMaskBottomY()

/** Returns whether the index is of the top of the stack item. */
internal fun Int.isTopItem(topItem: Int) = this == topItem

/** Returns whether the index is of the next item that follows the top of the stack item. */
internal fun Int.isNextItem(topItem: Int) = this == topItem + 1

/** Returns whether the index is of the next-next item after the top of the stack item. */
internal fun Int.isNextNextItem(topItem: Int) = this == topItem + 2

/**
 * Tolerance in pixels used to account for floating-point and heuristic estimation inaccuracies when
 * comparing decoration widths.
 */
internal const val DecorationWidthNoiseThresholdPx = 0.5f

private val SurfaceLow = Color(0xFF4F4F4F)
private const val MaxItemScrimAlpha = 0.5f
private const val MinWidestPointSearchResolution = 20
private const val MaxWidestPointSearchResolution = 200
```

<br />