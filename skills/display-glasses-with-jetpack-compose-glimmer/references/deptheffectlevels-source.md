When simulating depth on AI glasses using shadows, refer to the following source
code in `DepthEffectLevels.kt`:


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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.shadow.Shadow
import androidx.compose.ui.unit.dp

/**
 * Jetpack Compose Glimmer components can use [DepthEffect] to establish a sense of hierarchy.
 * [DepthEffectLevels] contains different levels of [DepthEffect] to express this hierarchy. Higher
 * levels contain larger shadows, and represent components with a higher z-order than lower levels.
 * In their baseline state (not focused) most components should have no (`null`) [DepthEffect].
 *
 * @property level1 the lowest level of [DepthEffect]. This level will have the smallest shadows.
 * @property level2 a level of [DepthEffect] higher than [level1] and lower than [level3].
 * @property level3 a level of [DepthEffect] higher than [level2] and lower than [level4].
 * @property level4 a level of [DepthEffect] higher than [level3] and lower than [level5].
 * @property level5 the highest level of [DepthEffect]. This level will have the largest shadows.
 * @see DepthEffect
 * @see depthEffect
 */
@Immutable
public class DepthEffectLevels(
    public val level1: DepthEffect = DepthEffectLevel1,
    public val level2: DepthEffect = DepthEffectLevel2,
    public val level3: DepthEffect = DepthEffectLevel3,
    public val level4: DepthEffect = DepthEffectLevel4,
    public val level5: DepthEffect = DepthEffectLevel5,
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is DepthEffectLevels) return false

        if (level1 != other.level1) return false
        if (level2 != other.level2) return false
        if (level3 != other.level3) return false
        if (level4 != other.level4) return false
        if (level5 != other.level5) return false

        return true
    }

    override fun hashCode(): Int {
        var result = level1.hashCode()
        result = 31 * result + level2.hashCode()
        result = 31 * result + level3.hashCode()
        result = 31 * result + level4.hashCode()
        result = 31 * result + level5.hashCode()
        return result
    }

    override fun toString(): String {
        return "DepthEffectLevels(level1=$level1, level2=$level2, level3=$level3, level4=$level4, level5=$level5)"
    }
}

private val DepthEffectLevel1 =
    DepthEffect(
        layer1 = Shadow(radius = 12.dp, color = Color.Black, spread = 6.dp, alpha = 0.90f),
        layer2 = Shadow(radius = 6.dp, color = Color.Black, spread = 2.dp),
    )
private val DepthEffectLevel2 =
    DepthEffect(
        layer1 = Shadow(radius = 23.dp, color = Color.Black, spread = 13.dp, alpha = 0.90f),
        layer2 = Shadow(radius = 8.dp, color = Color.Black, spread = 5.dp),
    )
private val DepthEffectLevel3 =
    DepthEffect(
        layer1 = Shadow(radius = 34.dp, color = Color.Black, spread = 19.dp, alpha = 0.90f),
        layer2 = Shadow(radius = 9.dp, color = Color.Black, spread = 7.dp),
    )
private val DepthEffectLevel4 =
    DepthEffect(
        layer1 = Shadow(radius = 45.dp, color = Color.Black, spread = 26.dp, alpha = 0.90f),
        layer2 = Shadow(radius = 11.dp, color = Color.Black, spread = 10.dp),
    )
private val DepthEffectLevel5 =
    DepthEffect(
        layer1 = Shadow(radius = 56.dp, color = Color.Black, spread = 32.dp, alpha = 0.90f),
        layer2 = Shadow(radius = 12.dp, color = Color.Black, spread = 12.dp),
    )
```

<br />