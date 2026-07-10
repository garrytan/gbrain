When creating a Glimmer Icon component, refer to the following source code in
`Icon.kt`:


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

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ProvidableCompositionLocal
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.structuralEqualityPolicy
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.CacheDrawModifierNode
import androidx.compose.ui.draw.paint
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ColorProducer
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.isSpecified
import androidx.compose.ui.graphics.layer.drawLayer
import androidx.compose.ui.graphics.painter.BitmapPainter
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.graphics.toolingGraphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.node.DelegatingNode
import androidx.compose.ui.node.ModifierNodeElement
import androidx.compose.ui.node.invalidateDraw
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp

/**
 * An icon component that draws [imageVector], with a default size of [LocalIconSize], and applies a
 * content color tint. Icon is an opinionated component designed to be used with single-color icons
 * so that they can be tinted correctly for the component they are placed in. The recommended icon
 * sizes can be retrieved using [GlimmerTheme.Companion.iconSizes]. A size can be set explicitly
 * using [size], and components can use [LocalIconSize] to set the preferred size for any Icons
 * inside the component. The content color used to tint this icon is provided by [surface]. To set a
 * custom tint color, use the Icon overload with a tint parameter. For multicolored icons and icons
 * that should not be tinted, use the overload and set [Color.Unspecified] as the tint color. For
 * generic images that should not be tinted, and should not use the provided icon size, use the
 * generic [androidx.compose.foundation.Image] instead.
 *
 * @param imageVector [ImageVector] to draw inside this icon
 * @param contentDescription text used by accessibility services to describe what this icon
 *   represents. This should always be provided unless this icon is used for decorative purposes,
 *   and does not represent a meaningful action that a user can take. This text should be localized,
 *   such as by using [androidx.compose.ui.res.stringResource] or similar
 * @param modifier the [Modifier] to be applied to this icon
 * @see LocalIconSize
 * @see GlimmerTheme.Companion.iconSizes
 */
@Composable
public fun Icon(
    imageVector: ImageVector,
    contentDescription: String?,
    modifier: Modifier = Modifier,
) {
    Icon(
        painter = rememberVectorPainter(imageVector),
        contentDescription = contentDescription,
        modifier = modifier,
    )
}

/**
 * An icon component that draws [imageVector], with a default size of [LocalIconSize], and applies a
 * tint of [tint]. Icon is an opinionated component designed to be used with single-color icons so
 * that they can be tinted correctly for the component they are placed in. The recommended icon
 * sizes can be retrieved using [GlimmerTheme.Companion.iconSizes]. A size can be set explicitly
 * using [size], and components can use [LocalIconSize] to set the preferred size for any Icons
 * inside the component. Use the other overload of Icon without a [tint] parameter to apply the
 * recommended content color provided by a [surface]. For multicolored icons and icons that should
 * not be tinted, set [tint] to [Color.Unspecified]. For generic images that should not be tinted,
 * and should not use the provided icon size, use the generic [androidx.compose.foundation.Image]
 * instead.
 *
 * @param imageVector [ImageVector] to draw inside this icon
 * @param tint tint to be applied to [imageVector]. If [Color.Unspecified] is provided, then no tint
 *   is applied.
 * @param contentDescription text used by accessibility services to describe what this icon
 *   represents. This should always be provided unless this icon is used for decorative purposes,
 *   and does not represent a meaningful action that a user can take. This text should be localized,
 *   such as by using [androidx.compose.ui.res.stringResource] or similar
 * @param modifier the [Modifier] to be applied to this icon
 * @see LocalIconSize
 * @see GlimmerTheme.Companion.iconSizes
 */
@Composable
public fun Icon(
    imageVector: ImageVector,
    tint: Color,
    contentDescription: String?,
    modifier: Modifier = Modifier,
) {
    Icon(
        painter = rememberVectorPainter(imageVector),
        tint =
            if (tint.isSpecified) {
                { tint }
            } else null,
        contentDescription = contentDescription,
        modifier = modifier,
    )
}

/**
 * An icon component that draws [bitmap], with a default size of [LocalIconSize], and applies a
 * content color tint. Icon is an opinionated component designed to be used with single-color icons
 * so that they can be tinted correctly for the component they are placed in. The recommended icon
 * sizes can be retrieved using [GlimmerTheme.Companion.iconSizes]. A size can be set explicitly
 * using [size], and components can use [LocalIconSize] to set the preferred size for any Icons
 * inside the component. The content color used to tint this icon is provided by [surface]. To set a
 * custom tint color, use the Icon overload with a tint parameter. For multicolored icons and icons
 * that should not be tinted, use the overload and set [Color.Unspecified] as the tint color. For
 * generic images that should not be tinted, and should not use the provided icon size, use the
 * generic [androidx.compose.foundation.Image] instead.
 *
 * @param bitmap [ImageBitmap] to draw inside this icon
 * @param contentDescription text used by accessibility services to describe what this icon
 *   represents. This should always be provided unless this icon is used for decorative purposes,
 *   and does not represent a meaningful action that a user can take. This text should be localized,
 *   such as by using [androidx.compose.ui.res.stringResource] or similar
 * @param modifier the [Modifier] to be applied to this icon
 * @see LocalIconSize
 * @see GlimmerTheme.Companion.iconSizes
 */
@Composable
public fun Icon(bitmap: ImageBitmap, contentDescription: String?, modifier: Modifier = Modifier) {
    val painter = remember(bitmap) { BitmapPainter(bitmap) }
    Icon(painter = painter, contentDescription = contentDescription, modifier = modifier)
}

/**
 * An icon component that draws [bitmap], with a default size of [LocalIconSize], and applies a tint
 * of [tint]. Icon is an opinionated component designed to be used with single-color icons so that
 * they can be tinted correctly for the component they are placed in. The recommended icon sizes can
 * be retrieved using [GlimmerTheme.Companion.iconSizes]. A size can be set explicitly using [size],
 * and components can use [LocalIconSize] to set the preferred size for any Icons inside the
 * component. Use the other overload of Icon without a [tint] parameter to apply the recommended
 * content color provided by a [surface]. For multicolored icons and icons that should not be
 * tinted, set [tint] to [Color.Unspecified]. For generic images that should not be tinted, and
 * should not use the provided icon size, use the generic [androidx.compose.foundation.Image]
 * instead.
 *
 * @param bitmap [ImageBitmap] to draw inside this icon
 * @param tint tint to be applied to [bitmap]. If [Color.Unspecified] is provided, then no tint is
 *   applied.
 * @param contentDescription text used by accessibility services to describe what this icon
 *   represents. This should always be provided unless this icon is used for decorative purposes,
 *   and does not represent a meaningful action that a user can take. This text should be localized,
 *   such as by using [androidx.compose.ui.res.stringResource] or similar
 * @param modifier the [Modifier] to be applied to this icon
 * @see LocalIconSize
 * @see GlimmerTheme.Companion.iconSizes
 */
@Composable
public fun Icon(
    bitmap: ImageBitmap,
    tint: Color,
    contentDescription: String?,
    modifier: Modifier = Modifier,
) {
    val painter = remember(bitmap) { BitmapPainter(bitmap) }
    Icon(
        painter = painter,
        tint =
            if (tint.isSpecified) {
                { tint }
            } else null,
        contentDescription = contentDescription,
        modifier = modifier,
    )
}

/**
 * An icon component that draws [painter], with a default size of [LocalIconSize], and applies a
 * content color tint. Icon is an opinionated component designed to be used with single-color icons
 * so that they can be tinted correctly for the component they are placed in. The recommended icon
 * sizes can be retrieved using [GlimmerTheme.Companion.iconSizes]. A size can be set explicitly
 * using [size], and components can use [LocalIconSize] to set the preferred size for any Icons
 * inside the component. The content color used to tint this icon is provided by [surface]. To set a
 * custom tint color, use the Icon overload with a tint parameter. For multicolored icons and icons
 * that should not be tinted, use the overload and set `null` for the tint parameter. For generic
 * images that should not be tinted, and should not use the provided icon size, use the generic
 * [androidx.compose.foundation.Image] instead.
 *
 * @param painter [Painter] to draw inside this icon
 * @param contentDescription text used by accessibility services to describe what this icon
 *   represents. This should always be provided unless this icon is used for decorative purposes,
 *   and does not represent a meaningful action that a user can take. This text should be localized,
 *   such as by using [androidx.compose.ui.res.stringResource] or similar
 * @param modifier the [Modifier] to be applied to this icon
 * @see LocalIconSize
 * @see GlimmerTheme.Companion.iconSizes
 */
@Composable
public fun Icon(painter: Painter, contentDescription: String?, modifier: Modifier = Modifier) {
    Icon(
        painter = painter,
        useContentColor = true,
        tint = null,
        contentDescription = contentDescription,
        modifier = modifier,
    )
}

/**
 * An icon component that draws [painter], with a default size of [LocalIconSize], and applies a
 * tint of [tint]. Icon is an opinionated component designed to be used with single-color icons so
 * that they can be tinted correctly for the component they are placed in. The recommended icon
 * sizes can be retrieved using [GlimmerTheme.Companion.iconSizes]. A size can be set explicitly
 * using [size], and components can use [LocalIconSize] to set the preferred size for any Icons
 * inside the component. Use the other overload of Icon without a [tint] parameter to apply the
 * recommended content color provided by a [surface]. For multicolored icons and icons that should
 * not be tinted, set [tint] to `null`. For generic images that should not be tinted, and should not
 * use the provided icon size, use the generic [androidx.compose.foundation.Image] instead.
 *
 * @param painter [Painter] to draw inside this icon
 * @param tint tint to be applied to [painter]. If null, then no tint is applied.
 * @param contentDescription text used by accessibility services to describe what this icon
 *   represents. This should always be provided unless this icon is used for decorative purposes,
 *   and does not represent a meaningful action that a user can take. This text should be localized,
 *   such as by using [androidx.compose.ui.res.stringResource] or similar
 * @param modifier the [Modifier] to be applied to this icon
 * @see LocalIconSize
 * @see GlimmerTheme.Companion.iconSizes
 */
@Composable
public fun Icon(
    painter: Painter,
    tint: ColorProducer?,
    contentDescription: String?,
    modifier: Modifier = Modifier,
) {
    Icon(
        painter = painter,
        useContentColor = false,
        tint = tint,
        contentDescription = contentDescription,
        modifier = modifier,
    )
}

/**
 * CompositionLocal containing the preferred size of an icon. This value will be used by [Icon] by
 * default - it can be overridden with a [size] modifier.
 */
public val LocalIconSize: ProvidableCompositionLocal<Dp> =
    compositionLocalOf(structuralEqualityPolicy()) { GlimmerTheme._iconSizes.medium }

@Composable
private fun Icon(
    painter: Painter,
    useContentColor: Boolean,
    tint: ColorProducer?,
    contentDescription: String?,
    modifier: Modifier,
) {
    val colorFilter =
        if (useContentColor || tint != null) {
            IconColorFilterElement(
                useContentColor = useContentColor,
                tint = tint,
                painter = painter,
            )
        } else {
            Modifier
        }
    val semantics =
        if (contentDescription != null) {
            Modifier.semantics {
                this.contentDescription = contentDescription
                this.role = Role.Image
            }
        } else {
            Modifier
        }
    Box(
        modifier
            .toolingGraphicsLayer()
            .size(LocalIconSize.current)
            .then(colorFilter)
            .paint(painter, contentScale = ContentScale.Fit)
            .then(semantics)
    )
}

@Suppress("ModifierNodeInspectableProperties")
private class IconColorFilterElement(
    private val useContentColor: Boolean,
    private val tint: ColorProducer?,
    private val painter: Painter,
) : ModifierNodeElement<IconColorFilterNode>() {
    override fun create() = IconColorFilterNode(useContentColor, tint, painter)

    override fun update(node: IconColorFilterNode) {
        node.update(useContentColor, tint, painter)
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is IconColorFilterElement) return false

        if (useContentColor != other.useContentColor) return false
        if (tint != other.tint) return false
        if (painter != other.painter) return false

        return true
    }

    override fun hashCode(): Int {
        var result = useContentColor.hashCode()
        result = 31 * result + (tint?.hashCode() ?: 0)
        result = 31 * result + painter.hashCode()
        return result
    }
}

private class IconColorFilterNode(
    private var useContentColor: Boolean,
    private var tint: ColorProducer?,
    private var painter: Painter,
) : DelegatingNode() {
    val cacheDrawNode =
        delegate(
            CacheDrawModifierNode {
                val layer = obtainGraphicsLayer()
                layer.apply { record { drawContent() } }
                var cachedTintColor = Color.Unspecified
                var cachedColorFilter: ColorFilter? = null
                onDrawWithContent {
                    val tintColor =
                        if (useContentColor) {
                            currentContentColor()
                        } else {
                            tint?.invoke() ?: Color.Unspecified
                        }
                    if (cachedTintColor != tintColor) {
                        cachedTintColor = tintColor
                        cachedColorFilter =
                            if (tintColor.isSpecified) ColorFilter.tint(tintColor) else null
                        layer.colorFilter = cachedColorFilter
                    }
                    drawLayer(graphicsLayer = layer)
                }
            }
        )

    fun update(useContentColor: Boolean, tint: ColorProducer?, painter: Painter) {
        val painterChanged = this.painter != painter
        if (this.useContentColor != useContentColor || this.tint != tint || painterChanged) {
            this.useContentColor = useContentColor
            this.tint = tint
            this.painter = painter
            if (painterChanged) {
                cacheDrawNode.invalidateDrawCache()
            } else {
                cacheDrawNode.invalidateDraw()
            }
        }
    }
}
```

<br />