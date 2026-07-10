# Common UI Recipe

This recipe demonstrates how to implement a common navigation UI pattern with a bottom navigation bar and multiple back stacks, where each tab in the navigation bar has its own navigation history.

## How it works

This example has three top-level destinations: `Home`, `ChatList`, and `Camera`. The `ChatList` destination also has a sub-route, `ChatDetail`.

### `TopLevelBackStack`

The core of this recipe is the `TopLevelBackStack` class, which is responsible for managing the navigation state. It works as follows:

- It maintains a separate back stack for each top-level destination (tab).
- It keeps track of the currently selected top-level destination.
- It provides a single, flattened back stack that can be used by the `NavDisplay` composable. This flattened back stack is a combination of the individual back stacks of all the tabs.

### UI Structure

The UI is built using a `Scaffold` composable, with a `NavigationBar` as the `bottomBar`.

- The `NavigationBar` displays an item for each top-level destination. When an item is clicked, it calls `topLevelBackStack.addTopLevel` to switch to the corresponding tab, preserving the navigation history of each tab.
- The `NavDisplay` composable is placed in the content area of the `Scaffold`. It is responsible for displaying the current screen based on the flattened back stack provided by `TopLevelBackStack`.

This approach allows for a common navigation pattern where users can switch between different sections of the app, and each section maintains its own navigation history.

### State Preservation

It's important to note how the navigation state is managed in this recipe. When a user navigates away from a top-level destination (e.g., by pressing the back button until they return to a previous tab), the entire navigation history for that destination is cleared. The state is not saved. When the user returns to that tab later, they will start from its initial screen.

**Note** : In this example, the `Home` route can move above the `ChatList` and `Camera` routes, meaning navigating back from `Home` doesn't necessarily leave the app. The app will exit when the user goes back from a single remaining top level route in the back stack.
[![](https://developer.android.com/static/images/picto-icons/code.svg) Explore View the full recipe on GitHub.](https://github.com/android/nav3-recipes/tree/main/app/src/main/java/com/example/nav3recipes/commonui)

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

package com.example.nav3recipes.commonui

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Face
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.lifecycle.compose.dropUnlessResumed
import androidx.navigation3.runtime.entryProvider
import androidx.navigation3.ui.NavDisplay
import com.example.nav3recipes.content.ContentBlue
import com.example.nav3recipes.content.ContentGreen
import com.example.nav3recipes.content.ContentPurple
import com.example.nav3recipes.content.ContentRed
import com.example.nav3recipes.ui.setEdgeToEdgeConfig

private sealed interface TopLevelRoute {
    val icon: ImageVector
}
private data object Home : TopLevelRoute { override val icon = Icons.Default.Home }
private data object ChatList : TopLevelRoute { override val icon = Icons.Default.Face }
private data object ChatDetail
private data object Camera : TopLevelRoute { override val icon = Icons.Default.PlayArrow }

private val TOP_LEVEL_ROUTES : List<TopLevelRoute> = listOf(Home, ChatList, Camera)

class CommonUiActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        setEdgeToEdgeConfig()
        super.onCreate(savedInstanceState)
        setContent {
            val topLevelBackStack = remember { TopLevelBackStack<Any>(Home) }

            Scaffold(
                bottomBar = {
                    NavigationBar {
                        TOP_LEVEL_ROUTES.forEach { topLevelRoute ->

                            val isSelected = topLevelRoute == topLevelBackStack.topLevelKey
                            NavigationBarItem(
                                selected = isSelected,
                                onClick = {
                                    topLevelBackStack.addTopLevel(topLevelRoute)
                                },
                                icon = {
                                    Icon(
                                        imageVector = topLevelRoute.icon,
                                        contentDescription = null
                                    )
                                }
                            )
                        }
                    }
                }
            ) { _ ->
                NavDisplay(
                    backStack = topLevelBackStack.backStack,
                    onBack = { topLevelBackStack.removeLast() },
                    entryProvider = entryProvider {
                        entry<Home>{
                            ContentRed("Home screen")
                        }
                        entry<ChatList>{
                            ContentGreen("Chat list screen"){
                                Button(onClick = dropUnlessResumed {
                                    topLevelBackStack.add(ChatDetail)
                                }) {
                                    Text("Go to conversation")
                                }
                            }
                        }
                        entry<ChatDetail>{
                            ContentBlue("Chat detail screen")
                        }
                        entry<Camera>{
                            ContentPurple("Camera screen")
                        }
                    },
                )
            }
        }
    }
}

class TopLevelBackStack<T: Any>(startKey: T) {

    // Maintain a stack for each top level route
    private var topLevelStacks : LinkedHashMap<T, SnapshotStateList<T>> = linkedMapOf(
        startKey to mutableStateListOf(startKey)
    )

    // Expose the current top level route for consumers
    var topLevelKey by mutableStateOf(startKey)
        private set

    // Expose the back stack so it can be rendered by the NavDisplay
    val backStack = mutableStateListOf(startKey)

    private fun updateBackStack() =
        backStack.apply {
            clear()
            addAll(topLevelStacks.flatMap { it.value })
        }

    fun addTopLevel(key: T){

        // If the top level doesn't exist, add it
        if (topLevelStacks[key] == null){
            topLevelStacks.put(key, mutableStateListOf(key))
        } else {
            // Otherwise just move it to the end of the stacks
            topLevelStacks.apply {
                remove(key)?.let {
                    put(key, it)
                }
            }
        }
        topLevelKey = key
        updateBackStack()
    }

    fun add(key: T){
        topLevelStacks[topLevelKey]?.add(key)
        updateBackStack()
    }

    fun removeLast(){
        val removedKey = topLevelStacks[topLevelKey]?.removeLastOrNull()
        // If the removed key was a top level key, remove the associated top level stack
        topLevelStacks.remove(removedKey)
        topLevelKey = topLevelStacks.keys.last()
        updateBackStack()
    }
}

```