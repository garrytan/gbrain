When creating a Glimmer Icon component, refer to the following source code in
`IconSizes.kt` for setting icon sizes:


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
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * A set of named icon sizes.
 *
 * Sizes can be provided using [LocalIconSize] to set the size for [Icon]s within a component, or
 * they can be set explicitly using [androidx.compose.foundation.layout.size].
 *
 * @property small the size of a small icon.
 * @property medium the size of a medium icon. This is the default icon size.
 * @property large the size of a large icon.
 * @see Icon
 * @see LocalIconSize
 */
@Immutable
public class IconSizes(
    public val small: Dp = 32.dp,
    public val medium: Dp = 40.dp,
    public val large: Dp = 48.dp,
) {

    /** Returns a copy of this IconSizes, optionally overriding some of the values. */
    public fun copy(
        small: Dp = this.small,
        medium: Dp = this.medium,
        large: Dp = this.large,
    ): IconSizes = IconSizes(small = small, medium = medium, large = large)

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is IconSizes) return false

        if (small != other.small) return false
        if (medium != other.medium) return false
        if (large != other.large) return false

        return true
    }

    override fun hashCode(): Int {
        var result = small.hashCode()
        result = 31 * result + medium.hashCode()
        result = 31 * result + large.hashCode()
        return result
    }

    override fun toString(): String {
        return "IconSizes(small=$small, medium=$medium, large=$large)"
    }
}
```

<br />