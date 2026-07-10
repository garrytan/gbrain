When implementing Glimmer styles, refer to the following source code in
`GlimmerTheme.kt`:


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
import androidx.compose.foundation.IndicationNodeFactory
import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.interaction.InteractionSource
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocal
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ProvidableCompositionLocal
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.node.DelegatableNode
import androidx.xr.glimmer.GlimmerTheme.Companion.colors
import androidx.xr.glimmer.GlimmerTheme.Companion.depthEffectLevels
import androidx.xr.glimmer.GlimmerTheme.Companion.iconSizes
import androidx.xr.glimmer.GlimmerTheme.Companion.shapes

/**
 * Jetpack Compose Glimmer contains different theme subsystems to allow visual customization across
 * an application.
 *
 * Components use properties provided here when retrieving default values.
 *
 * Any values that are not set will inherit the current value from the theme, falling back to the
 * defaults if there is no parent GlimmerTheme. This allows using a GlimmerTheme at the top of your
 * application, and then separate GlimmerTheme(s) for different screens / parts of your UI,
 * overriding only the parts of the theme definition that need to change.
 *
 * @param colors [Colors] used by components within this hierarchy
 * @param typography [Typography] used by components within this hierarchy
 * @param componentSpacingValues [ComponentSpacingValues] used by components within this hierarchy
 * @param content The content that can retrieve values from this theme
 */
@Composable
public fun GlimmerTheme(
    colors: Colors = GlimmerTheme.colors,
    typography: Typography = GlimmerTheme.typography,
    componentSpacingValues: ComponentSpacingValues = GlimmerTheme.componentSpacingValues,
    content: @Composable () -> Unit,
) {
    val theme = GlimmerTheme(colors, typography, componentSpacingValues)
    CompositionLocalProvider(
        _localGlimmerTheme provides theme,
        // TODO: b/413429405
        LocalIndication provides NoIndication,
        LocalTextStyle provides typography.bodySmall,
        LocalIconSize provides theme.iconSizes.medium,
        content = content,
    )
}

/**
 * Jetpack Compose Glimmer contains different theme subsystems to allow visual customization across
 * an application.
 *
 * Components use properties provided here when retrieving default values.
 *
 * @property colors [Colors] used by Jetpack Compose Glimmer components
 * @property typography [Typography] used by Jetpack Compose Glimmer components. It is recommended
 *   to use `createGoogleSansFlexTypography()` from `androidx.xr.glimmer:glimmer-google-fonts` to
 *   create this.
 * @property componentSpacingValues [ComponentSpacingValues] used by Jetpack Compose Glimmer
 *   components
 * @property shapes [Shapes] used by Jetpack Compose Glimmer components
 * @property depthEffectLevels [DepthEffectLevels] used by Jetpack Compose Glimmer components
 * @property iconSizes [IconSizes] used by icons
 */
@Immutable
public class GlimmerTheme(
    public val colors: Colors = Colors(),
    public val typography: Typography = Typography(),
    public val componentSpacingValues: ComponentSpacingValues = ComponentSpacingValues(),
) {
    public val shapes: Shapes = _shapes
    public val depthEffectLevels: DepthEffectLevels = _depthEffectLevels
    public val iconSizes: IconSizes = _iconSizes

    public companion object {
        /** Retrieves the current [Colors] at the call site's position in the hierarchy. */
        public val colors: Colors
            @Composable @ReadOnlyComposable get() = LocalGlimmerTheme.current.colors

        /** Retrieves the current [Typography] at the call site's position in the hierarchy. */
        public val typography: Typography
            @Composable @ReadOnlyComposable get() = LocalGlimmerTheme.current.typography

        /**
         * Retrieves the current [ComponentSpacingValues] at the call site's position in the
         * hierarchy.
         */
        public val componentSpacingValues: ComponentSpacingValues
            @Composable @ReadOnlyComposable get() = LocalGlimmerTheme.current.componentSpacingValues

        /** Retrieves the current [Shapes] at the call site's position in the hierarchy. */
        public val shapes: Shapes
            @Composable @ReadOnlyComposable get() = LocalGlimmerTheme.current.shapes

        /**
         * Retrieves the current [DepthEffectLevels] at the call site's position in the hierarchy.
         */
        public val depthEffectLevels: DepthEffectLevels
            @Composable @ReadOnlyComposable get() = LocalGlimmerTheme.current.depthEffectLevels

        /** Retrieves the current [IconSizes] at the call site's position in the hierarchy. */
        public val iconSizes: IconSizes
            @Composable @ReadOnlyComposable get() = LocalGlimmerTheme.current.iconSizes

        /**
         * [CompositionLocal] providing [GlimmerTheme] throughout the hierarchy. You can use
         * properties in the companion object to access specific subsystems, for example [colors].
         * To provide a new value for this, use [GlimmerTheme]. This API is exposed to allow
         * retrieving values from inside CompositionLocalConsumerModifierNode implementations - in
         * most cases you should use [colors] and other properties directly.
         */
        public val LocalGlimmerTheme: CompositionLocal<GlimmerTheme>
            get() = _localGlimmerTheme

        /**
         * Cached Shapes instance to be used across [GlimmerTheme] instances - currently shapes are
         * not user-configurable.
         */
        private val _shapes = Shapes()

        /**
         * Cached [DepthEffectLevels] instance to be used across [GlimmerTheme] instances -
         * currently depth effect levels are not user-configurable.
         */
        private val _depthEffectLevels = DepthEffectLevels()

        /**
         * Cached IconSizes instance to be used across [GlimmerTheme] instances - currently icon
         * sizes are not user-configurable.
         */
        internal val _iconSizes = IconSizes()
    }

    internal var defaultSurfaceBorderCached: BorderStroke? = null
}

private object NoIndication : IndicationNodeFactory {
    override fun create(interactionSource: InteractionSource): DelegatableNode {
        return object : Modifier.Node() {}
    }

    override fun equals(other: Any?): Boolean = other === this

    override fun hashCode(): Int = -5
}

/** Use [GlimmerTheme.LocalGlimmerTheme] to access this publicly. */
@Suppress("CompositionLocalNaming")
private val _localGlimmerTheme: ProvidableCompositionLocal<GlimmerTheme> =
    staticCompositionLocalOf {
        GlimmerTheme()
    }
```

<br />