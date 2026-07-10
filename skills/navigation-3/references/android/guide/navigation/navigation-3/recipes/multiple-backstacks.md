# Multiple back stacks recipe

This recipe demonstrates how to create multiple back stacks.

The app has three top level routes: `RouteA`, `RouteB` and `RouteC`. These routes have sub routes `RouteA1`, `RouteB1` and `RouteC1` respectively. The content for the sub routes is a counter that can be used to verify state retention through configuration changes and process death.

The app's navigation state is held in the `NavigationState` class. The state itself is created using `rememberNavigationState`.

Navigation events are handled by the `Navigator`. It updates the navigation state.

The navigation state is converted into `NavEntry`s with `NavigationState.toDecoratedEntries`. These entries are then displayed by `NavDisplay`.

Key behaviors:

- This app follows the "exit through home" pattern where the user always exits through the starting back stack. This means that `RouteA`'s entries are *always* in the list of entries.
- Navigating to a top level route that is not the starting route *replaces* the other entries. For example, navigating A-\>B-\>C would result in entries for A+C, B's entries are removed.

Important implementation details:

- Each top level route has its own `SaveableStateHolderNavEntryDecorator`. This is the object responsible for managing the state for the entries in its back stack.

[![](https://developer.android.com/static/images/picto-icons/code.svg) Explore View the full recipe on GitHub.](https://github.com/android/nav3-recipes/tree/main/app/src/main/java/com/example/nav3recipes/multiplestacks)

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

package com.example.nav3recipes.multiplestacks

import androidx.navigation3.runtime.NavKey

/**
 * Handles navigation events (forward and back) by updating the navigation state.
 */
class Navigator(val state: NavigationState){
    fun navigate(route: NavKey){
        if (route in state.backStacks.keys){
            // This is a top level route, just switch to it
            state.topLevelRoute = route
        } else {
            state.backStacks[state.topLevelRoute]?.add(route)
        }
    }

    fun goBack(){
        val currentStack = state.backStacks[state.topLevelRoute] ?:
        error("Stack for ${state.topLevelRoute} not found")
        val currentRoute = currentStack.last()

        // If we're at the base of the current route, go back to the start route stack.
        if (currentRoute == state.topLevelRoute){
            state.topLevelRoute = state.startRoute
        } else {
            currentStack.removeLastOrNull()
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

package com.example.nav3recipes.multiplestacks

import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSerializable
import androidx.compose.runtime.setValue
import androidx.navigation3.runtime.NavBackStack
import androidx.navigation3.runtime.NavEntry
import androidx.navigation3.runtime.NavKey
import androidx.navigation3.runtime.rememberDecoratedNavEntries
import androidx.navigation3.runtime.rememberNavBackStack
import androidx.navigation3.runtime.rememberSaveableStateHolderNavEntryDecorator
import androidx.navigation3.runtime.serialization.NavKeySerializer
import androidx.savedstate.compose.serialization.serializers.MutableStateSerializer

/**
 * Create a navigation state that persists config changes and process death.
 *
 * @param startRoute - The top level route to start on. This should also be in `topLevelRoutes`.
 * @param topLevelRoutes - The top level routes in the app.
 */
@Composable
fun rememberNavigationState(
    startRoute: NavKey,
    topLevelRoutes: Set<NavKey>
): NavigationState {

    val topLevelRoute = rememberSerializable(
        startRoute, topLevelRoutes,
        serializer = MutableStateSerializer(NavKeySerializer())
    ) {
        mutableStateOf(startRoute)
    }

    // Create a back stack for each top level route.
    val backStacks = topLevelRoutes.associateWith { key -> rememberNavBackStack(key) }

    return remember(startRoute, topLevelRoutes) {
        NavigationState(
            startRoute = startRoute,
            topLevelRoute = topLevelRoute,
            backStacks = backStacks
        )
    }
}

/**
 * State holder for navigation state. This class does not modify its own state. It is designed
 * to be modified using the `Navigator` class.
 *
 * @param startRoute - the start route. The user will exit the app through this route.
 * @param topLevelRoute - the state object that backs the top level route.
 * @param backStacks - the back stacks for each top level route.
 */
class NavigationState(
    val startRoute: NavKey,
    topLevelRoute: MutableState<NavKey>,
    val backStacks: Map<NavKey, NavBackStack<NavKey>>
) {

    /**
     * The top level route.
     */
    var topLevelRoute: NavKey by topLevelRoute

    /**
     * Convert the navigation state into `NavEntry`s that have been decorated with a
     * `SaveableStateHolder`.
     *
     * @param entryProvider - the entry provider used to convert the keys in the
     * back stacks to `NavEntry`s.
     */
    @Composable
    fun toDecoratedEntries(
        entryProvider: (NavKey) -> NavEntry<NavKey>
    ): List<NavEntry<NavKey>> {

        // For each back stack, create a `SaveableStateHolder` decorator and use it to decorate
        // the entries from that stack. When backStacks changes, `rememberDecoratedNavEntries` will
        // be recomposed and a new list of decorated entries is returned.
        val decoratedEntries = backStacks.mapValues { (_, stack) ->
            val decorators = listOf(
                rememberSaveableStateHolderNavEntryDecorator<NavKey>(),
            )
            rememberDecoratedNavEntries(
                backStack = stack,
                entryDecorators = decorators,
                entryProvider = entryProvider
            )
        }

        // Only return the entries for the stacks that are currently in use.
        return getTopLevelRoutesInUse()
            .flatMap { decoratedEntries[it] ?: emptyList() }
    }

    /**
     * Get the top level routes that are currently in use. The start route is always the first route
     * in the list. This means the user will always exit the app through the starting route
     * ("exit through home" pattern). The list will contain a maximum of one other route. This is a
     * design decision. In your app, you may wish to allow more than two top level routes to be
     * active.
     *
     * Note that even if a top level route is not in use its state is still retained.
     *
     * @return the current top level routes that are in use.
     */
    private fun getTopLevelRoutesInUse() : List<NavKey> =
		if (topLevelRoute == startRoute) {
            listOf(startRoute)
        } else {
            listOf(startRoute, topLevelRoute)
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

package com.example.nav3recipes.multiplestacks

import android.annotation.SuppressLint
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Camera
import androidx.compose.material.icons.filled.Face
import androidx.compose.material.icons.filled.Home
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.navigation3.runtime.NavKey
import androidx.navigation3.runtime.entryProvider
import androidx.navigation3.ui.NavDisplay
import com.example.nav3recipes.ui.setEdgeToEdgeConfig
import kotlinx.serialization.Serializable


@Serializable
data object RouteA : NavKey

@Serializable
data object RouteA1 : NavKey

@Serializable
data object RouteB : NavKey

@Serializable
data object RouteB1 : NavKey

@Serializable
data object RouteC : NavKey

@Serializable
data object RouteC1 : NavKey

private val TOP_LEVEL_ROUTES = mapOf<NavKey, NavBarItem>(
    RouteA to NavBarItem(icon = Icons.Default.Home, description = "Route A"),
    RouteB to NavBarItem(icon = Icons.Default.Face, description = "Route B"),
    RouteC to NavBarItem(icon = Icons.Default.Camera, description = "Route C"),
)

data class NavBarItem(
    val icon: ImageVector,
    val description: String
)

class MultipleStacksActivity : ComponentActivity() {
    @SuppressLint("UnusedMaterial3ScaffoldPaddingParameter")
    override fun onCreate(savedInstanceState: Bundle?) {
        setEdgeToEdgeConfig()
        super.onCreate(savedInstanceState)
        setContent {
            val navigationState = rememberNavigationState(
                startRoute = RouteA,
                topLevelRoutes = TOP_LEVEL_ROUTES.keys
            )

            val navigator = remember { Navigator(navigationState) }

            val entryProvider = entryProvider {
                featureASection(onSubRouteClick = { navigator.navigate(RouteA1) })
                featureBSection(onSubRouteClick = { navigator.navigate(RouteB1) })
                featureCSection(onSubRouteClick = { navigator.navigate(RouteC1) })
            }

            Scaffold(bottomBar = {
                NavigationBar {
                    TOP_LEVEL_ROUTES.forEach { (key, value) ->
                        val isSelected = key == navigationState.topLevelRoute
                        NavigationBarItem(
                            selected = isSelected,
                            onClick = { navigator.navigate(key) },
                            icon = {
                                Icon(
                                    imageVector = value.icon,
                                    contentDescription = value.description
                                )
                            },
                            label = { Text(value.description) }
                        )
                    }
                }
            }) {
                NavDisplay(
                    entries = navigationState.toDecoratedEntries(entryProvider),
                    onBack = { navigator.goBack() }
                )
            }
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

package com.example.nav3recipes.multiplestacks

import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.lifecycle.compose.dropUnlessResumed
import androidx.navigation3.runtime.EntryProviderScope
import androidx.navigation3.runtime.NavKey
import com.example.nav3recipes.content.ContentGreen
import com.example.nav3recipes.content.ContentMauve
import com.example.nav3recipes.content.ContentOrange
import com.example.nav3recipes.content.ContentPink
import com.example.nav3recipes.content.ContentPurple
import com.example.nav3recipes.content.ContentRed

fun EntryProviderScope<NavKey>.featureASection(
    onSubRouteClick: () -> Unit,
) {
    entry<RouteA> {
        ContentRed("Route A") {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Button(onClick = dropUnlessResumed(block = onSubRouteClick)) {
                    Text("Go to A1")
                }
            }
        }
    }
    entry<RouteA1> {
        ContentPink("Route A1") {
            var count by rememberSaveable {
                mutableIntStateOf(0)
            }

            Button(onClick = { count++ }) {
                Text("Value: $count")
            }
        }
    }
}

fun EntryProviderScope<NavKey>.featureBSection(
    onSubRouteClick: () -> Unit,
) {
    entry<RouteB> {
        ContentGreen("Route B") {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Button(onClick = dropUnlessResumed(block = onSubRouteClick)) {
                    Text("Go to B1")
                }
            }
        }
    }
    entry<RouteB1> {
        ContentPurple("Route B1") {
            var count by rememberSaveable {
                mutableIntStateOf(0)
            }
            Button(onClick = { count++ }) {
                Text("Value: $count")
            }
        }
    }
}

fun EntryProviderScope<NavKey>.featureCSection(
    onSubRouteClick: () -> Unit,
) {
    entry<RouteC> {
        ContentMauve("Route C") {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Button(onClick = dropUnlessResumed(block = onSubRouteClick)) {
                    Text("Go to C1")
                }
            }
        }
    }
    entry<RouteC1> {
        ContentOrange("Route C1") {
            var count by rememberSaveable {
                mutableIntStateOf(0)
            }

            Button(onClick = { count++ }) {
                Text("Value: $count")
            }
        }
    }
}
```