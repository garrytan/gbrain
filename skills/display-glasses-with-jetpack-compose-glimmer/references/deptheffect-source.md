When simulating depth on AI glasses using shadows, refer to the following source
code in `DepthEffect.kt`:


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

import androidx.compose.runtime.Immutable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.ShadowScope
import androidx.compose.ui.draw.dropShadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.DefaultAlpha
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.drawscope.ContentDrawScope
import androidx.compose.ui.graphics.shadow.DropShadowPainter
import androidx.compose.ui.graphics.shadow.Shadow
import androidx.compose.ui.graphics.shadow.lerp
import androidx.compose.ui.node.DrawModifierNode
import androidx.compose.ui.node.ModifierNodeElement
import androidx.compose.ui.node.requireGraphicsContext
import androidx.compose.ui.platform.InspectorInfo

/**
 * The depth effect establishes a sense of hierarchy by using shadows to occlude content underneath.
 * It consists of two shadow layers, [layer1] and [layer2]. [layer2] is drawn on top of [layer1]:
 *
 *     _________________
 *    |    _________    |
 *    |   | content |   |
 *    |   |_________|   |
 *    |   ___________   |
 *    |  |  layer 2  |  |
 *    |  |___________|  |
 *    |  _____________  |
 *    | |   layer 1   | |
 *    | |_____________| |
 *    |_________________|
 *
 * [GlimmerTheme.depthEffectLevels] provides theme defined depth effect levels that should be used
 * to add depth to surfaces.
 *
 * Higher level components apply the depth effect automatically when needed. The depth effect can
 * also be configured through [surface]. To manually render depth shadows for advanced use-cases,
 * see the [depthEffect] [Modifier].
 *
 * @property layer1 the 'base' [Shadow] layer, drawn first
 * @property layer2 the second [Shadow] layer, drawn on top of [layer1]
 */
@Immutable
public class DepthEffect(public val layer1: Shadow, public val layer2: Shadow) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is DepthEffect) return false

        if (layer1 != other.layer1) return false
        if (layer2 != other.layer2) return false

        return true
    }

    override fun hashCode(): Int {
        var result = layer1.hashCode()
        result = 31 * result + layer2.hashCode()
        return result
    }
}

/**
 * Renders shadows for the provided [depthEffect].
 *
 * @param depthEffect Depth effect to render shadows for. If `null`, no shadows will be rendered.
 * @param shape [Shape] of the shadows
 */
public fun Modifier.depthEffect(depthEffect: DepthEffect?, shape: Shape): Modifier {
    if (depthEffect == null) return this
    return this then DepthEffectElement(depthEffect, shape)
}

/**
 * Renders depth effect shadows by lerping between the provided [from] and [to] depth effects using
 * [progress]. This allows for efficient animation - to render a static depth effect, see the other
 * overload.
 *
 * @param from Depth effect to render shadows for when [progress] is 0.
 * @param to Depth effect to render shadows for when [progress] is 1.
 * @param shape [Shape] of the shadows
 * @param progress progress of the animation between [from] and [to], from 0 to 1. Values may go
 *   outside these bounds for overshoot / undershoot.
 */
// TODO: can be simplified with style API in the future
internal fun Modifier.depthEffect(
    from: DepthEffect?,
    to: DepthEffect?,
    shape: Shape,
    progress: () -> Float,
): Modifier {
    // dropShadow draws the shadow, and then the content on top. So in order to get layer2 to
    // render on top of layer1, we draw layer1 first - this means that layer1's dropShadow will
    // draw its shadow, and then its content on top (since the 'content' includes children
    // modifiers, this includes layer2's shadow).
    return this.dropShadow(shape) {
            val shadow = lerp(from?.layer1, to?.layer1, progress())
            if (shadow != null) {
                updateFrom(shadow)
            }
        }
        .dropShadow(shape) {
            val shadow = lerp(from?.layer2, to?.layer2, progress())
            if (shadow != null) {
                updateFrom(shadow)
            }
        }
}

private fun ShadowScope.updateFrom(shadow: Shadow) {
    this.radius = shadow.radius.toPx()
    this.spread = shadow.spread.toPx()
    this.offset = Offset(shadow.offset.x.toPx(), shadow.offset.y.toPx())
    this.color = shadow.color
    this.brush = shadow.brush
    this.alpha = shadow.alpha
    this.blendMode = shadow.blendMode
}

private class DepthEffectElement(private val depthEffect: DepthEffect, private val shape: Shape) :
    ModifierNodeElement<DepthEffectNode>() {

    override fun create(): DepthEffectNode = DepthEffectNode(depthEffect, shape)

    override fun update(node: DepthEffectNode) {
        node.update(depthEffect, shape)
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is DepthEffectElement) return false

        if (depthEffect != other.depthEffect) return false
        if (shape != other.shape) return false

        return true
    }

    override fun hashCode(): Int {
        var result = depthEffect.hashCode()
        result = 31 * result + shape.hashCode()
        return result
    }

    override fun InspectorInfo.inspectableProperties() {
        name = "depthEffect"
        properties["depthEffect"] = depthEffect
        properties["shape"] = shape
    }
}

/**
 * Renders shadows for the provided [shape] and [depthEffect].
 *
 * @param depthEffect Depth effect to render shadows for.
 * @param shape [Shape] of the shadows.
 */
internal class DepthEffectNode(private var depthEffect: DepthEffect, private var shape: Shape) :
    Modifier.Node(), DrawModifierNode {

    private var layer1ShadowPainter: DropShadowPainter? = null
    private var layer2ShadowPainter: DropShadowPainter? = null

    fun update(depthEffect: DepthEffect, shape: Shape) {
        if (this.depthEffect.layer1 != depthEffect.layer1) layer1ShadowPainter = null
        if (this.depthEffect.layer2 != depthEffect.layer2) layer2ShadowPainter = null
        if (this.shape != shape) {
            layer1ShadowPainter = null
            layer2ShadowPainter = null
        }
        this.shape = shape
        this.depthEffect = depthEffect
    }

    override fun ContentDrawScope.draw() {
        drawDepthEffect()
        drawContent()
    }

    internal fun ContentDrawScope.drawDepthEffect(alpha: Float = DefaultAlpha) {
        // In order to get layer2 to render on top of layer1, we draw layer1 first.
        with(obtainLayer1ShadowPainter()) { draw(size, alpha = alpha) }
        with(obtainLayer2ShadowPainter()) { draw(size, alpha = alpha) }
    }

    private fun obtainLayer1ShadowPainter(): DropShadowPainter =
        layer1ShadowPainter
            ?: requireGraphicsContext()
                .shadowContext
                .createDropShadowPainter(shape, depthEffect.layer1)
                .also { layer1ShadowPainter = it }

    private fun obtainLayer2ShadowPainter(): DropShadowPainter =
        layer2ShadowPainter
            ?: requireGraphicsContext()
                .shadowContext
                .createDropShadowPainter(shape, depthEffect.layer2)
                .also { layer2ShadowPainter = it }
}
```

<br />