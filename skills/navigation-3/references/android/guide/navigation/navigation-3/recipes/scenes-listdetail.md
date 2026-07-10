# List-Detail Scene Recipe

This example shows how to create a list-detail layout using the Scenes API.

A `ListDetailSceneStrategy` will return a `ListDetailScene` if:

- the window width is over 600dp
- A `Detail` entry is the last item in the back stack
- A `List` entry is in the back stack

The `ListDetailScene` provides a `CompositionLocal` named `LocalBackButtonVisibility` that can be used by the detail `NavEntry` to control whether it displays a back button. This is useful when the detail entry usually displays a back button but should not display it when being displayed in a `ListDetailScene`. See <https://github.com/android/nav3-recipes/issues/151> for more details on this use case.

See `ListDetailScene.kt` for more implementation details.
[![](https://developer.android.com/static/images/picto-icons/code.svg) Explore View the full recipe on GitHub.](https://github.com/android/nav3-recipes/tree/main/app/src/main/java/com/example/nav3recipes/scenes/listdetail)

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

package com.example.nav3recipes.scenes.listdetail

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.adaptive.currentWindowAdaptiveInfoV2
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.compositionLocalOf
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

/**
 * A [Scene] that displays a list and a detail [NavEntry] side-by-side in a 40/60 split.
 *
 */
data class ListDetailScene<T : Any>(
    override val key: Any,
    override val previousEntries: List<NavEntry<T>>,
    val listEntry: NavEntry<T>,
    val detailEntry: NavEntry<T>,
) : Scene<T> {
    override val entries: List<NavEntry<T>> = listOf(listEntry, detailEntry)
    override val content: @Composable (() -> Unit) = {
        Row(modifier = Modifier.fillMaxSize()) {
            Column(modifier = Modifier.weight(0.4f)) {
                listEntry.Content()
            }

            // Let the detail entry know not to display a back button.
            CompositionLocalProvider(LocalBackButtonVisibility provides false) {
                Column(modifier = Modifier.weight(0.6f)) {
                    AnimatedContent(
                        targetState = detailEntry,
                        contentKey = { entry -> entry.contentKey },
                        transitionSpec = {
                            slideInHorizontally(
                                initialOffsetX = { it }
                            ) togetherWith
                                    slideOutHorizontally(targetOffsetX = { -it })
                        }
                    ) { entry ->
                        entry.Content()
                    }
                }
            }
        }
    }

    companion object {
        /**
         * Helper function to add metadata to a [NavEntry] indicating it can be displayed
         * in the list pane of a [ListDetailScene].
         */
        fun listPane() = metadata {
            put(ListKey, true)
        }

        /**
         * Helper function to add metadata to a [NavEntry] indicating it can be displayed
         * in the detail pane of a the [ListDetailScene].
         */
        fun detailPane() = metadata {
            put(DetailKey, true)
        }
    }

    object ListKey : NavMetadataKey<Boolean>
    object DetailKey : NavMetadataKey<Boolean>
}

/**
 * This `CompositionLocal` can be used by a detail `NavEntry` to decide whether to display
 * a back button. Default is `true`. It is set to `false` for a detail `NavEntry` when being
 * displayed in a `ListDetailScene`.
 */
val LocalBackButtonVisibility = compositionLocalOf { true }

@Composable
fun <T : Any> rememberListDetailSceneStrategy(): ListDetailSceneStrategy<T> {
    val windowSizeClass = currentWindowAdaptiveInfoV2().windowSizeClass

    return remember(windowSizeClass) {
        ListDetailSceneStrategy(windowSizeClass)
    }
}


/**
 * A [SceneStrategy] that returns a [ListDetailScene] if:
 *
 * - the window width is over 600dp
 * - A `Detail` entry is the last item in the back stack
 * - A `List` entry is in the back stack
 *
 * Notably, when the detail entry changes the scene's key does not change. This allows the scene,
 * rather than the NavDisplay, to handle animations when the detail entry changes.
 */
class ListDetailSceneStrategy<T : Any>(val windowSizeClass: WindowSizeClass) : SceneStrategy<T> {

    override fun SceneStrategyScope<T>.calculateScene(entries: List<NavEntry<T>>): Scene<T>? {

        if (!windowSizeClass.isWidthAtLeastBreakpoint(WIDTH_DP_MEDIUM_LOWER_BOUND)) {
            return null
        }

        val detailEntry =
            entries.lastOrNull()?.takeIf { it.metadata.contains(ListDetailScene.DetailKey) }
                ?: return null
        val listEntry =
            entries.findLast { it.metadata.contains(ListDetailScene.ListKey) } ?: return null

        // We use the list's contentKey to uniquely identify the scene.
        // This allows the detail panes to be animated in and out by the scene, rather than
        // having NavDisplay animate the whole scene out when the selected detail item changes.
        val sceneKey = listEntry.contentKey

        return ListDetailScene(
            key = sceneKey,
            previousEntries = entries.dropLast(1),
            listEntry = listEntry,
            detailEntry = detailEntry
        )
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

package com.example.nav3recipes.scenes.listdetail

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.animation.ExperimentalSharedTransitionApi
import androidx.compose.animation.SharedTransitionLayout
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
import androidx.compose.ui.Modifier
import androidx.navigation3.runtime.NavBackStack
import androidx.navigation3.runtime.NavKey
import androidx.navigation3.runtime.entryProvider
import androidx.navigation3.runtime.rememberNavBackStack
import androidx.navigation3.ui.NavDisplay
import com.example.nav3recipes.ui.setEdgeToEdgeConfig
import kotlinx.serialization.Serializable

/**
 * This example shows how to create a list-detail layout using the Scenes API.
 *
 * A `ListDetailScene` will render content in two panes if:
 *
 * - the window width is over 600dp
 * - A `Detail` entry is the last item in the back stack
 * - A `List` entry is in the back stack
 *
 * @see `ListDetailScene`
 */
@Serializable
data object ConversationList : NavKey

@Serializable
data class ConversationDetail(
    val id: Int,
    val colorId: Int
) : NavKey

@Serializable
data object Profile : NavKey

class ListDetailActivity : ComponentActivity() {

    @OptIn(ExperimentalSharedTransitionApi::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        setEdgeToEdgeConfig()
        super.onCreate(savedInstanceState)

        setContent {

            Scaffold { paddingValues ->

                val backStack = rememberNavBackStack(ConversationList)
                val listDetailStrategy = rememberListDetailSceneStrategy<NavKey>()

                SharedTransitionLayout {
                    NavDisplay(
                        backStack = backStack,
                        onBack = { backStack.removeLastOrNull() },
                        sceneStrategies = listOf(listDetailStrategy),
                        sharedTransitionScope = this,
                        modifier = Modifier.padding(paddingValues),
                        entryProvider = entryProvider {
                            entry<ConversationList>(
                                metadata = ListDetailScene.listPane()
                            ) {
                                ConversationListScreen(
                                    onConversationClicked = { detailRoute ->
                                        backStack.addDetail(detailRoute)
                                    }
                                )
                            }
                            entry<ConversationDetail>(
                                metadata = ListDetailScene.detailPane()
                            ) { conversationDetail ->
                                ConversationDetailScreen(
                                    conversationDetail = conversationDetail,
                                    onBack = { backStack.removeLastOrNull() },
                                    onProfileClicked = { backStack.add(Profile) }
                                )
                            }
                            entry<Profile> {
                                ProfileScreen()
                            }
                        }
                    )
                }
            }
        }
    }
}

private fun NavBackStack<NavKey>.addDetail(detailRoute: ConversationDetail) {

    // Remove any existing detail routes before adding this detail route.
    // In certain scenarios, such as when multiple detail panes can be shown at once, it may
    // be desirable to keep existing detail routes on the back stack.
    removeIf { it is ConversationDetail }
    add(detailRoute)
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

package com.example.nav3recipes.scenes.listdetail

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.dropUnlessResumed
import com.example.nav3recipes.ui.theme.colors

@Composable
fun ConversationListScreen(
    onConversationClicked: (ConversationDetail) -> Unit
) {
    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.surface),
    ) {
        items(10) { index ->
            val conversationId = index + 1
            val conversationDetail = ConversationDetail(
                id = conversationId,
                colorId = conversationId % colors.size
            )
            val backgroundColor = colors[conversationDetail.colorId]
            ListItem(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable(onClick = dropUnlessResumed {
                        onConversationClicked(conversationDetail)
                    }),
                headlineContent = {
                    Text(
                        text = "Conversation $conversationId",
                        style = MaterialTheme.typography.headlineSmall,
                        color = MaterialTheme.colorScheme.onSurface
                    )
                },
                colors = ListItemDefaults.colors(
                    containerColor = backgroundColor // Set container color directly
                )
            )
        }
    }
}

@Composable
fun ConversationDetailScreen(
    conversationDetail: ConversationDetail,
    onBack: () -> Unit,
    onProfileClicked: () -> Unit
) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(colors[conversationDetail.colorId])
            .padding(16.dp)
    ) {
        if (LocalBackButtonVisibility.current) {
            IconButton(
                onClick = onBack,
                modifier = Modifier.align(Alignment.TopStart)
            ) {
                Icon(
                    imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                    contentDescription = "Back"
                )
            }
        }
        Column(
            modifier = Modifier
                .fillMaxSize(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center
        ) {
            Text(
                text = "Conversation Detail Screen: ${conversationDetail.id}",
                style = MaterialTheme.typography.headlineMedium,
                color = MaterialTheme.colorScheme.onSurface
            )
            Spacer(modifier = Modifier.height(16.dp))
            Button(onClick = dropUnlessResumed(block = onProfileClicked)) {
                Text("View Profile")
            }
        }
    }
}

@Composable
fun ProfileScreen() {
    val profileColor = MaterialTheme.colorScheme.surfaceVariant
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(profileColor)
            .padding(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Text(
            text = "Profile Screen",
            style = MaterialTheme.typography.headlineMedium,
            color = MaterialTheme.colorScheme.onSurface
        )
    }
}
```