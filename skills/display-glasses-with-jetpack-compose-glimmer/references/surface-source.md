When using surfaces to build a custom component, refer to the following source
code in `Surface.kt`:


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

import android.graphics.RuntimeShader
import android.os.Build
import androidx.annotation.RequiresApi
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.AnimationSpec
import androidx.compose.animation.core.AnimationVector1D
import androidx.compose.animation.core.LinearOutSlowInEasing
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.FocusInteraction
import androidx.compose.foundation.interaction.Interaction
import androidx.compose.foundation.interaction.InteractionSource
import androidx.compose.foundation.interaction.PressInteraction
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shader
import androidx.compose.ui.graphics.ShaderBrush
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.drawscope.ContentDrawScope
import androidx.compose.ui.graphics.layer.GraphicsLayer
import androidx.compose.ui.layout.layout
import androidx.compose.ui.node.DrawModifierNode
import androidx.compose.ui.node.ModifierNodeElement
import androidx.compose.ui.node.invalidateDraw
import androidx.compose.ui.node.requireGraphicsContext
import androidx.compose.ui.platform.InspectorInfo
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.lerp
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.intellij.lang.annotations.Language

/**
 * A surface is a fundamental building block in Glimmer. A surface represents a distinct visual area
 * or 'physical' boundary for components such as buttons and cards. A [surface] implements shared
 * visual decoration for Jetpack Compose Glimmer components:
 * 1) Clipping: a surface clips its children to the shape specified by [shape]
 * 2) Border: a surface draws an inner [border] to emphasize the boundary of the component. When
 *    focused, a surface draws a wider border with a focused highlight on top to indicate the focus
 *    state.
 * 3) Background: a surface has a background color of [color].
 * 4) Depth effect: a surface can have different [DepthEffect] shadows for different states, as
 *    specified by [depthEffect].
 * 5) Content color: a surface provides a [contentColor] for text and icons inside the surface. By
 *    default this is calculated from the provided background color.
 * 6) Interaction states: when focused, a surface displays draws a wider border with a focused
 *    highlight on top. When pressed, a surface draws a pressed overlay. This happens for
 *    interactions emitted from [interactionSource].
 *
 * Use surface on its own for decorative elements that cannot be interacted with by a user:
 *
 * @sample androidx.xr.glimmer.samples.SurfaceSample
 *
 * In most cases surfaces should be interactive, to allow users to consistently move focus and
 * navigate between components. You can use [androidx.compose.foundation.focusable] for focus-only
 * surfaces, or [androidx.compose.foundation.clickable] and other modifiers for surfaces with
 * actions. To ensure the surface correctly reflects the interaction states, provide the same
 * [InteractionSource] to all modifiers.
 *
 * For example, to create a clickable surface:
 *
 * @sample androidx.xr.glimmer.samples.ClickableSurfaceSample
 *
 * Similarly, to create a focusable surface:
 *
 * @sample androidx.xr.glimmer.samples.FocusableSurfaceSample
 * @param enabled controls the enabled state of this surface. When `false`, a disabled overlay
 *   visual will be drawn on top of the surface. Note that this only affects the visual decoration;
 *   it does not intercept input or block interaction states (such as focus or press) from the
 *   [interactionSource].
 * @param shape the [Shape] used to clip this surface, and also used to draw the background and
 *   border
 * @param color the background [Color] for this surface
 * @param contentColor the [Color] for content inside this surface
 * @param depthEffect the [SurfaceDepthEffect] for this surface, representing the [DepthEffect]
 *   shadows rendered in different states.
 * @param border an optional inner border for this surface
 * @param interactionSource the [InteractionSource] that emits [Interaction]s for this surface. For
 *   interactive surfaces, the [InteractionSource] instance provided to this surface must be shared
 *   with the modifier responsible for emitting [Interaction]s, such as
 *   [androidx.compose.foundation.focusable] or [androidx.compose.foundation.clickable].
 */
@Composable
public fun Modifier.surface(
    enabled: Boolean = true,
    shape: Shape = GlimmerTheme.shapes.medium,
    color: Color = GlimmerTheme.colors.surface,
    contentColor: Color = calculateContentColor(color),
    depthEffect: SurfaceDepthEffect? = null,
    border: BorderStroke? = SurfaceDefaults.border(),
    interactionSource: InteractionSource? = null,
): Modifier {
    return this.surfaceDepthEffect(depthEffect, shape, interactionSource)
        .clip(shape)
        .contentColorProvider(contentColor)
        .then(
            SurfaceNodeElement(
                enabled = enabled,
                shape = shape,
                border = border,
                interactionSource = interactionSource,
            )
        )
        .background(color = color, shape = shape)
}

/**
 * Represents the [DepthEffect] used by a [surface] in different states.
 *
 * Focused [surface]s with a [focusedDepthEffect] will have a higher zIndex set so they can draw
 * their focused depth effect over siblings.
 *
 * @property [depthEffect] the [DepthEffect] used when the [surface] is in its default state (no
 *   other interactions are ongoing)
 * @property [focusedDepthEffect] the [DepthEffect] used when the [surface] is focused
 */
@Immutable
public class SurfaceDepthEffect(
    public val depthEffect: DepthEffect?,
    public val focusedDepthEffect: DepthEffect?,
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is SurfaceDepthEffect) return false

        if (depthEffect != other.depthEffect) return false
        if (focusedDepthEffect != other.focusedDepthEffect) return false

        return true
    }

    override fun hashCode(): Int {
        var result = depthEffect?.hashCode() ?: 0
        result = 31 * result + (focusedDepthEffect?.hashCode() ?: 0)
        return result
    }
}

/** Default values used for [surface]. */
public object SurfaceDefaults {
    /**
     * Create the default [BorderStroke] used for a [surface]. Use the other overload in order to
     * change the width or color.
     */
    @Composable
    public fun border(): BorderStroke {
        return GlimmerTheme.LocalGlimmerTheme.current.defaultSurfaceBorder
    }

    /**
     * Create the default [BorderStroke] used for a [surface], with optional overrides for [width]
     * and [color].
     *
     * @param width width of the border in [Dp]. Use [Dp.Hairline] for one-pixel border.
     * @param color color to paint the border with
     */
    @Composable
    public fun border(
        width: Dp = DefaultSurfaceBorderWidth,
        color: Color = GlimmerTheme.colors.outline,
    ): BorderStroke {
        return BorderStroke(width, color)
    }

    /** Returns the default (cached) border for a [surface]. */
    internal val GlimmerTheme.defaultSurfaceBorder: BorderStroke
        get() {
            return defaultSurfaceBorderCached
                ?: BorderStroke(DefaultSurfaceBorderWidth, colors.outline).also {
                    defaultSurfaceBorderCached = it
                }
        }
}

/**
 * Surface node responsible for drawing the border, focused border and highlight, and pressed
 * overlay.
 */
private class SurfaceNodeElement(
    private val enabled: Boolean,
    private val shape: Shape,
    private val border: BorderStroke?,
    private val interactionSource: InteractionSource?,
) : ModifierNodeElement<SurfaceNode>() {
    override fun create(): SurfaceNode =
        SurfaceNode(
            enabled = enabled,
            shape = shape,
            border = border,
            interactionSource = interactionSource,
        )

    override fun update(node: SurfaceNode) =
        node.update(
            enabled = enabled,
            shape = shape,
            border = border,
            interactionSource = interactionSource,
        )

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is SurfaceNodeElement) return false

        if (enabled != other.enabled) return false
        if (shape != other.shape) return false
        if (border != other.border) return false
        if (interactionSource != other.interactionSource) return false

        return true
    }

    override fun hashCode(): Int {
        var result = enabled.hashCode()
        result = 31 * result + shape.hashCode()
        result = 31 * result + (border?.hashCode() ?: 0)
        result = 31 * result + (interactionSource?.hashCode() ?: 0)
        return result
    }

    override fun InspectorInfo.inspectableProperties() {
        name = "surface"
        properties["enabled"] = enabled
        properties["shape"] = shape
        properties["border"] = border
        properties["interactionSource"] = interactionSource
    }
}

private class SurfaceNode(
    private var enabled: Boolean,
    private var shape: Shape,
    private var border: BorderStroke?,
    private var interactionSource: InteractionSource?,
) : DrawModifierNode, Modifier.Node() {

    override val shouldAutoInvalidate = false

    // Cache borders and highlight for unfocused and focused states. This means we
    // can avoid recreating these for a given surface, if the border and shape never
    // change. Changing between unfocused and focus states only requires a draw
    // invalidation, as the borders are already cached.

    // Unfocused border
    private val unfocusedBorderLogic: BorderLogic = BorderLogic()
    private val unfocusedBorderWidth: () -> Dp = { border?.width ?: 0.dp }
    // Focused border - this consists of two layers. A 'base' layer (which is the
    // unfocused border with a different size) and the highlight we draw on top of
    // this base layer. We need to increase the size of the underlying border to
    // make sure that the highlight area fully matches the underlying border, to
    // avoid inconsistent areas of coverage due to the transparency of the
    // highlight.
    private var focusedBorderLogic: BorderLogic? = null
    private var focusedHighlightBorderLogic: BorderLogic? = null
    private var focusedBorderWidth: (() -> Dp)? = null

    // Highlight shader / brush
    var shader: Shader? = null
    var shaderBrush: Brush? = null

    // Graphics Layer
    private var unfocusedBorderLayer: GraphicsLayer? = null
    private var unfocusedGraphicsLayerProvider: (() -> GraphicsLayer)? = null

    private var focusedBorderLayer: GraphicsLayer? = null
    private var focusedGraphicsLayerProvider: (() -> GraphicsLayer)? = null

    private var focusedHighlightBorderLayer: GraphicsLayer? = null
    private var focusedHighlightGraphicsLayerProvider: (() -> GraphicsLayer)? = null

    private var interactionCollectionJob: Job? = null

    // Enter / exit animation progress for the width and fade effect applied to the highlight
    private var _focusedHighlightProgress: Animatable<Float, AnimationVector1D>? = null
    private val focusedHighlightProgress
        get() = _focusedHighlightProgress?.value ?: 0f

    // Rotation progress applied to the highlight
    private var _focusedHighlightRotationProgress: Animatable<Float, AnimationVector1D>? = null
    private val focusedHighlightRotationProgress
        get() = _focusedHighlightRotationProgress?.value ?: 0f

    private var pressedOverlayAlpha: Animatable<Float, AnimationVector1D>? = null
    // Job that runs for a minimum duration to make sure quick presses are still visible
    private var minimumPressDuration: Job? = null
    private var pressReleaseAnimation: Job? = null

    fun update(
        enabled: Boolean,
        shape: Shape,
        border: BorderStroke?,
        interactionSource: InteractionSource?,
    ) {
        if (this.enabled != enabled) {
            this.enabled = enabled
            invalidateDraw()
        }
        if (this.shape != shape) {
            this.shape = shape
            invalidateDraw()
        }
        if (this.border != border) {
            this.border = border
            invalidateDraw()
        }
        if (this.interactionSource != interactionSource) {
            this.interactionSource = interactionSource
            observeInteractions()
        }
    }

    override fun onAttach() {
        observeInteractions()
    }

    var isFocused = false
        set(value) {
            if (field != value) {
                field = value
                if (value) {
                    startFocusAnimation()
                } else {
                    stopFocusAnimation()
                }
                // No need to invalidate the border cache - we build it ahead of time to account for
                // focus changes. Just invalidate draw so we can switch to drawing the correct
                // border.
                invalidateDraw()
            }
        }

    var isPressed = false
        set(value) {
            if (field != value) {
                field = value
                if (value) {
                    pressedOverlayAlpha = pressedOverlayAlpha ?: Animatable(0f)
                    pressReleaseAnimation?.cancel()
                    minimumPressDuration?.cancel()

                    minimumPressDuration =
                        coroutineScope.launch(start = CoroutineStart.UNDISPATCHED) {
                            delay(PressedOverlayMinimumDurationMillis)
                        }
                    coroutineScope.launch(start = CoroutineStart.UNDISPATCHED) {
                        pressedOverlayAlpha?.animateTo(
                            PressedOverlayAlpha,
                            PressedOverlayEnterAnimationSpec,
                        )
                    }
                } else {
                    pressedOverlayAlpha?.let { progress ->
                        pressReleaseAnimation =
                            coroutineScope.launch(start = CoroutineStart.UNDISPATCHED) {
                                minimumPressDuration?.join()
                                progress.animateTo(0f, PressedOverlayExitAnimationSpec)
                            }
                    }
                }
                invalidateDraw()
            }
        }

    private fun observeInteractions() {
        interactionCollectionJob?.cancel()
        interactionCollectionJob = null
        isFocused = false
        isPressed = false
        interactionSource?.let { source ->
            interactionCollectionJob =
                coroutineScope.launch(start = CoroutineStart.UNDISPATCHED) {
                    var focusCount = 0
                    var pressCount = 0
                    source.interactions.collect { interaction ->
                        when (interaction) {
                            is FocusInteraction.Focus -> focusCount++
                            is FocusInteraction.Unfocus -> focusCount--
                            is PressInteraction.Press -> pressCount++
                            is PressInteraction.Release -> pressCount--
                            is PressInteraction.Cancel -> pressCount--
                        }
                        isFocused = focusCount > 0
                        isPressed = pressCount > 0
                    }
                }
        }
    }

    private fun startFocusAnimation() {
        _focusedHighlightProgress = _focusedHighlightProgress ?: Animatable(0f)
        _focusedHighlightRotationProgress = _focusedHighlightRotationProgress ?: Animatable(0f)
        coroutineScope.launch(start = CoroutineStart.UNDISPATCHED) {
            _focusedHighlightProgress?.snapTo(0f)
            _focusedHighlightProgress?.animateTo(
                targetValue = 1f,
                animationSpec = FocusedEnterAnimationSpec,
            )
        }
        coroutineScope.launch(start = CoroutineStart.UNDISPATCHED) {
            _focusedHighlightRotationProgress?.snapTo(0f)
            _focusedHighlightRotationProgress?.animateTo(
                targetValue = 1f,
                animationSpec = FocusedHighlightRotationAnimationSpec,
            )
        }
    }

    private fun stopFocusAnimation() {
        coroutineScope.launch(start = CoroutineStart.UNDISPATCHED) {
            _focusedHighlightProgress?.animateTo(
                targetValue = 0f,
                animationSpec = FocusedExitAnimationSpec,
            )
            if (isActive) {
                _focusedHighlightRotationProgress?.snapTo(0f)
            }
        }
    }

    override fun ContentDrawScope.draw() {
        val outline = shape.createOutline(size, layoutDirection, this)
        drawContent()
        val pressedOverlayColor = PressedOverlayColor.copy(alpha = pressedOverlayAlpha?.value ?: 0f)
        drawRect(color = pressedOverlayColor)
        if (border != null) {
            val progress = focusedHighlightProgress
            val gContext = requireGraphicsContext()
            if (progress > 0f) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    val rotationProgressRadians =
                        (FocusedHighlightRotationEndAngleRadians -
                            FocusedHighlightRotationStartAngleRadians) *
                            focusedHighlightRotationProgress
                    val rotationRadians =
                        FocusedHighlightRotationStartAngleRadians + rotationProgressRadians
                    shader =
                        HighlightShaderHelper.configureShader(
                            shader = shader,
                            size = size,
                            rotationRadians = rotationRadians.toFloat(),
                            progress = progress,
                        )
                    shaderBrush = shaderBrush ?: ShaderBrush(shader!!)
                }
                focusedBorderLogic = focusedBorderLogic ?: BorderLogic()
                focusedHighlightBorderLogic = focusedHighlightBorderLogic ?: BorderLogic()
                focusedBorderWidth =
                    focusedBorderWidth
                        ?: {
                            val b = border
                            if (b != null) {
                                lerp(
                                    b.width,
                                    FocusedSurfaceBorderWidth,
                                    // Capture class property instead of function-local progress to
                                    // make sure this will read the animation state when the lambda
                                    // is invoked and not capture a stale variable
                                    focusedHighlightProgress,
                                )
                            } else {
                                0.dp
                            }
                        }
                focusedBorderLogic!!.drawBorder(
                    this,
                    focusedBorderWidth!!,
                    border!!.brush,
                    focusedGraphicsLayerProvider
                        ?: {
                                focusedBorderLayer
                                    ?: gContext.createGraphicsLayer().also {
                                        focusedBorderLayer = it
                                    }
                            }
                            .also { focusedGraphicsLayerProvider = it },
                    outline,
                )

                shaderBrush?.let {
                    focusedHighlightBorderLogic!!.drawBorder(
                        this,
                        focusedBorderWidth!!,
                        it,
                        focusedHighlightGraphicsLayerProvider
                            ?: {
                                    focusedHighlightBorderLayer
                                        ?: gContext.createGraphicsLayer().also {
                                            focusedHighlightBorderLayer = it
                                        }
                                }
                                .also { focusedHighlightGraphicsLayerProvider = it },
                        outline,
                    )
                }
            } else {
                unfocusedBorderLogic.drawBorder(
                    this,
                    unfocusedBorderWidth,
                    border!!.brush,
                    unfocusedGraphicsLayerProvider
                        ?: {
                                unfocusedBorderLayer
                                    ?: gContext.createGraphicsLayer().also {
                                        unfocusedBorderLayer = it
                                    }
                            }
                            .also { unfocusedGraphicsLayerProvider = it },
                    outline,
                )
            }
        }
        if (!enabled) {
            drawRect(DisabledOverlayColor)
        }
    }

    override fun onDetach() {
        _focusedHighlightProgress = null
        _focusedHighlightRotationProgress = null
        pressedOverlayAlpha = null

        unfocusedGraphicsLayerProvider = null
        val gContext = requireGraphicsContext()
        unfocusedBorderLayer?.let {
            gContext.releaseGraphicsLayer(it)
            unfocusedBorderLayer = null
        }

        focusedGraphicsLayerProvider = null
        focusedBorderLayer?.let {
            gContext.releaseGraphicsLayer(it)
            focusedBorderLayer = null
        }

        focusedHighlightGraphicsLayerProvider = null
        focusedHighlightBorderLayer?.let {
            gContext.releaseGraphicsLayer(it)
            focusedHighlightBorderLayer = null
        }
    }
}

/**
 * Renders and animates a [surface]'s [depthEffect] for a given [shape], by observing
 * [interactionSource].
 */
@Composable
private fun Modifier.surfaceDepthEffect(
    depthEffect: SurfaceDepthEffect?,
    shape: Shape,
    interactionSource: InteractionSource?,
): Modifier {
    if (depthEffect == null) return this
    val focusedProgress = remember { Animatable(0f) }
    // If focused and there is focused depth effect, we need to draw the surface on top of
    // other siblings to make sure the depth effect occludes siblings.
    val zIndex by remember {
        // Derived to avoid invalidating layout each frame of the animation
        derivedStateOf {
            if (depthEffect.focusedDepthEffect != null && focusedProgress.value >= 0.5f) 1f else 0f
        }
    }
    if (interactionSource != null) {
        LaunchedEffect(interactionSource) {
            interactionSource.interactions.collect { interaction ->
                when (interaction) {
                    is FocusInteraction.Focus ->
                        launch(start = CoroutineStart.UNDISPATCHED) {
                            focusedProgress.animateTo(1f, FocusedEnterAnimationSpec)
                        }

                    is FocusInteraction.Unfocus ->
                        launch(start = CoroutineStart.UNDISPATCHED) {
                            focusedProgress.animateTo(0f, FocusedExitAnimationSpec)
                        }
                }
            }
        }
    }

    return layout { measurable, constraints ->
            val placeable = measurable.measure(constraints)
            layout(placeable.width, placeable.height) { placeable.place(0, 0, zIndex = zIndex) }
        }
        .depthEffect(
            from = depthEffect.depthEffect,
            to = depthEffect.focusedDepthEffect,
            shape = shape,
            progress = { focusedProgress.value },
        )
}

/** Default border width for a [surface]. */
private val DefaultSurfaceBorderWidth = 2.dp

/** Focused border width for a [surface]. */
private val FocusedSurfaceBorderWidth = 5.dp

/** Enter animation for focus highlight and depth effect */
private val FocusedEnterAnimationSpec: AnimationSpec<Float> =
    spring(dampingRatio = 1f, stiffness = 600f)

/** Exit animation for focus highlight and depth effect */
private val FocusedExitAnimationSpec: AnimationSpec<Float> =
    spring(dampingRatio = 1f, stiffness = 100f)

private val FocusedHighlightRotationAnimationSpec: AnimationSpec<Float> =
    tween(durationMillis = 700, easing = LinearOutSlowInEasing, delayMillis = 40)

private val FocusedHighlightRotationStartAngleRadians: Double = Math.toRadians(-100.0)

private val FocusedHighlightRotationEndAngleRadians: Double = Math.toRadians(35.0)

private val PressedOverlayColor = Color.White

internal val DisabledOverlayColor = Color(0x8F191919)

private const val PressedOverlayAlpha = 0.16f

private val PressedOverlayEnterAnimationSpec: AnimationSpec<Float> =
    spring(dampingRatio = 0.84f, stiffness = 8000f)

private val PressedOverlayExitAnimationSpec: AnimationSpec<Float> =
    spring(dampingRatio = 0.85f, stiffness = 50f)

private const val PressedOverlayMinimumDurationMillis = 300L

@Language(value = "AGSL")
private const val FocusedHighlightShader =
    """
/**
 * Rotating linear gradient shader, where rotation is controlled by iRotation uniform.
 * This is essentially the same as:
 * LinearGradientShader(
 *     colors = FocusedHighlightColors,
 *     colorStops = FocusedHighlightColorStops,
 *     from = Offset.Zero,
 *     to = Offset(size.width, size.height),
 * )
 * But allowing for efficient rotation, instead of needing to create a new shader / brush every
 * frame with new coordinates.
 */
// Width / height
uniform float2 iResolution;
// Rotation in radians. 0 radians means a horizontal gradient.
// Positive values will have the effect of rotating the gradient clockwise.
uniform float iRotation;
// Alpha animation progress from 0 to 1. This will be applied to the color stops so that each
// color stop will fade in.
uniform float iAlphaProgress;

half4 main(float2 fragCoord) {
    // Horizontal gradient
    half4 colors[4];
    colors[0] = half4(1.0, 1.0, 1.0, 1.0 * iAlphaProgress); // White with 100% alpha
    colors[1] = half4(1.0, 1.0, 1.0, 0.2 * iAlphaProgress); // White with 20% alpha
    colors[2] = half4(1.0, 1.0, 1.0, 0.2 * iAlphaProgress); // White with 20% alpha
    colors[3] = half4(1.0, 1.0, 1.0, 0.8 * iAlphaProgress); // White with 80% alpha

    // Stops for the horizontal gradient
    float stops[4];
    stops[0] = 0.0;
    stops[1] = 0.3;
    stops[2] = 0.66;
    stops[3] = 1.0;

    // Normalize
    half2 uv = fragCoord.xy / iResolution.xy;

    // Offset around a rotational center
    half2 rotationCenter = half2(0.5, 0.5);
    uv -= rotationCenter;

    // Rotate
    // We rotate in the opposite direction as we are rotating the coordinate we sample the gradient
    // from. To create the effect of a gradient 'moving' clockwise, we need to move the
    // coordinate in the opposite direction (counter-clockwise).
    float2x2 matrix = float2x2(cos(-iRotation),-sin(-iRotation),sin(-iRotation),cos(-iRotation));
    uv *= matrix;

    // Translate back into [0,1] space
    uv += rotationCenter;

    // Blend through stops using the x coordinate, since we have a horizontal gradient
    half4 color = mix(colors[0], colors[1], smoothstep(stops[0], stops[1], uv.x));
    color = mix(color, colors[2], smoothstep(stops[1], stops[2], uv.x));
    color = mix(color, colors[3], smoothstep(stops[2], stops[3], uv.x));

    return color;
}
"""

@RequiresApi(Build.VERSION_CODES.TIRAMISU)
private object HighlightShaderHelper {
    @JvmStatic
    fun configureShader(
        shader: Shader?,
        size: Size,
        rotationRadians: Float,
        progress: Float,
    ): Shader {
        val shader = shader as? RuntimeShader ?: RuntimeShader(FocusedHighlightShader)
        shader.setFloatUniform("iResolution", size.width, size.height)
        shader.setFloatUniform("iRotation", rotationRadians)
        shader.setFloatUniform("iAlphaProgress", progress)
        return shader
    }
}
```

<br />