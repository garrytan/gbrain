# Two-Pane Scene Recipe

This example shows how to create a two pane layout using the Scenes API.

A `TwoPaneSceneStrategy` will return a `TwoPaneScene` if:

- the window width is over 600dp
- the last two nav entries on the back stack have indicated that they support being displayed in a `TwoPaneScene` in their metadata.

See `TwoPaneScene.kt` for more implementation details.
[![](https://developer.android.com/static/images/picto-icons/code.svg) Explore View the full recipe on GitHub.](https://github.com/android/nav3-recipes/tree/main/app/src/main/java/com/example/nav3recipes/scenes/twopane)

```
package com.example.nav3recipes.scenes.twopane

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.adaptive.currentWindowAdaptiveInfoV2
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.navigation3.runtime.NavEntry
import androidx.navigation3.runtime.NavMetadataKey
import androidx.navigation3.runtime.contains
import androidx.navigation3.runtime.metadata
import androidx.navigation3.scene.Scene
import androidx.navigation3.scene.SceneStrategy
import androidx.navigation3.scene.SceneStrategyScope
import androidx.window.core.layout.WindowSizeClass
import androidx.window.core.layout.WindowSizeClass.Companion.WIDTH_DP_MEDIUM_LOWER_BOUND

// --- TwoPaneScene ---
/**
 * A custom [Scene] that displays two [NavEntry]s side-by-side in a 50/50 split.
 */
data class TwoPaneScene<T : Any>(
    override val key: Any,
    override val previousEntries: List<NavEntry<T>>,
    val firstEntry: NavEntry<T>,
    val secondEntry: NavEntry<T>
) : Scene<T> {
    override val entries: List<NavEntry<T>> = listOf(firstEntry, secondEntry)
    override val content: @Composable (() -> Unit) = {
        Row(modifier = Modifier.fillMaxSize()) {
            Column(modifier = Modifier.weight(0.5f)) {
                firstEntry.Content()
            }
            Column(modifier = Modifier.weight(0.5f)) {
                secondEntry.Content()
            }
        }
    }

    companion object {
        /**
         * Helper function to add metadata to a [NavEntry] indicating it can be displayed
         * in a two-pane layout.
         */
        fun twoPane() = metadata {
            put(TwoPaneKey, true)
        }
    }

    object TwoPaneKey : NavMetadataKey<Boolean>
}

@Composable
fun <T : Any> rememberTwoPaneSceneStrategy(): TwoPaneSceneStrategy<T> {
    val windowSizeClass = currentWindowAdaptiveInfoV2().windowSizeClass

    return remember(windowSizeClass) {
        TwoPaneSceneStrategy(windowSizeClass)
    }
}


// --- TwoPaneSceneStrategy ---
/**
 * A [SceneStrategy] that activates a [TwoPaneScene] if the window is wide enough
 * and the top two back stack entries declare support for two-pane display.
 */
class TwoPaneSceneStrategy<T : Any>(val windowSizeClass: WindowSizeClass) : SceneStrategy<T> {

    override fun SceneStrategyScope<T>.calculateScene(entries: List<NavEntry<T>>): Scene<T>? {

        // Condition 1: Only return a Scene if the window is sufficiently wide to render two panes.
        // We use isWidthAtLeastBreakpoint with WIDTH_DP_MEDIUM_LOWER_BOUND (600dp).
        if (!windowSizeClass.isWidthAtLeastBreakpoint(WIDTH_DP_MEDIUM_LOWER_BOUND)) {
            return null
        }

        val lastTwoEntries = entries.takeLast(2)

        // Condition 2: Only return a Scene if there are two entries, and both have declared
        // they can be displayed in a two pane scene.
        return if (lastTwoEntries.size == 2
            && lastTwoEntries.all { it.metadata.contains(TwoPaneScene.TwoPaneKey) }
        ) {
            val firstEntry = lastTwoEntries.first()
            val secondEntry = lastTwoEntries.last()

            // The scene key must uniquely represent the state of the scene.
            // A Pair of the first and second entry keys ensures uniqueness.
            val sceneKey = Pair(firstEntry.contentKey, secondEntry.contentKey)

            TwoPaneScene(
                key = sceneKey,
                // Where we go back to is a UX decision. In this case, we only remove the top
                // entry from the back stack, despite displaying two entries in this scene.
                // This is because in this app we only ever add one entry to the
                // back stack at a time. It would therefore be confusing to the user to add one
                // when navigating forward, but remove two when navigating back.
                previousEntries = entries.dropLast(1),
                firstEntry = firstEntry,
                secondEntry = secondEntry
            )

        } else {
            null
        }
    }


}
```

```
/*
 * Copyright 2025 The Android Open Source Project
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

package com.example.nav3recipes.scenes.twopane

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.animation.SharedTransitionLayout
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.dropUnlessResumed
import androidx.navigation3.runtime.NavBackStack
import androidx.navigation3.runtime.NavKey
import androidx.navigation3.runtime.entryProvider
import androidx.navigation3.runtime.rememberNavBackStack
import androidx.navigation3.ui.NavDisplay
import com.example.nav3recipes.content.ContentBase
import com.example.nav3recipes.content.ContentGreen
import com.example.nav3recipes.content.ContentRed
import com.example.nav3recipes.ui.setEdgeToEdgeConfig
import com.example.nav3recipes.ui.theme.colors
import kotlinx.serialization.Serializable

@Serializable
private object Home : NavKey

@Serializable
private data class Product(val id: Int) : NavKey

@Serializable
private data object Profile : NavKey

class TwoPaneActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        setEdgeToEdgeConfig()
        super.onCreate(savedInstanceState)

        setContent {
            val backStack = rememberNavBackStack(Home)
            val twoPaneStrategy = rememberTwoPaneSceneStrategy<NavKey>()

            SharedTransitionLayout {
                NavDisplay(
                    backStack = backStack,
                    onBack = { backStack.removeLastOrNull() },
                    sceneStrategies = listOf(twoPaneStrategy),
                    sharedTransitionScope = this,
                    entryProvider = entryProvider {
                        entry<Home>(
                            metadata = TwoPaneScene.twoPane()
                        ) {
                            ContentRed("Welcome to Nav3") {
                                Button(onClick = { backStack.addProductRoute(1) }) {
                                    Text("View the first product")
                                }
                            }
                        }
                        entry<Product>(
                            metadata = TwoPaneScene.twoPane()
                        ) { product ->
                            ContentBase(
                                "Product ${product.id} ",
                                Modifier.background(colors[product.id % colors.size])
                            ) {
                                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                    Button(onClick = dropUnlessResumed {
                                        backStack.addProductRoute(product.id + 1)
                                    }) {
                                        Text("View the next product")
                                    }
                                    Button(onClick = dropUnlessResumed {
                                        backStack.add(Profile)
                                    }) {
                                        Text("View profile")
                                    }
                                }
                            }
                        }
                        entry<Profile> {
                            ContentGreen("Profile (single pane only)")
                        }
                    }
                )
            }
        }
    }
}

private fun NavBackStack<NavKey>.addProductRoute(productId: Int) {
    val productRoute =
        Product(productId)
    // Avoid adding the same product route to the back stack twice.
    if (!contains(productRoute)) {
        add(productRoute)
    }
}
```