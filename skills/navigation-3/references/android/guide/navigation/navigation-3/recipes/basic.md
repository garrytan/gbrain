# Basic Recipe

This recipe shows a basic example of how to use the Navigation 3 API with two screens.

## How it works

This example defines two routes: `RouteA` and `RouteB`. `RouteA` is a `data object` representing a simple screen, while `RouteB` is a `data class` that takes an `id` as a parameter.

A `mutableStateListOf<Any>` is used to manage the navigation back stack.

The `NavDisplay` composable is used to display the current screen. Its `entryProvider` parameter is a lambda that takes a route from the back stack and returns a `NavEntry`. Inside the `entryProvider`, a `when` statement is used to determine which composable to display based on the route.

To navigate from `RouteA` to `RouteB`, we simply add a `RouteB` instance to the back stack. The `id` is passed as an argument to the `RouteB` data class.
[![](https://developer.android.com/static/images/picto-icons/code.svg) Explore View the full recipe on GitHub.](https://github.com/android/nav3-recipes/tree/main/app/src/main/java/com/example/nav3recipes/basic)

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

package com.example.nav3recipes.basic

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.lifecycle.compose.dropUnlessResumed
import androidx.navigation3.runtime.NavEntry
import androidx.navigation3.ui.NavDisplay
import com.example.nav3recipes.content.ContentBlue
import com.example.nav3recipes.content.ContentGreen
import com.example.nav3recipes.ui.setEdgeToEdgeConfig

private data object RouteA

private data class RouteB(val id: String)

class BasicActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        setEdgeToEdgeConfig()
        super.onCreate(savedInstanceState)
        setContent {
            val backStack = remember { mutableStateListOf<Any>(RouteA) }

            NavDisplay(
                backStack = backStack,
                onBack = { backStack.removeLastOrNull() },
                entryProvider = { key ->
                    when (key) {
                        is RouteA -> NavEntry(key) {
                            ContentGreen("Welcome to Nav3") {
                                Button(onClick = dropUnlessResumed {
                                    backStack.add(RouteB("123"))
                                }) {
                                    Text("Click to navigate")
                                }
                            }
                        }

                        is RouteB -> NavEntry(key) {
                            ContentBlue("Route id: ${key.id} ")
                        }

                        else -> {
                            error("Unknown route: $key")
                        }
                    }
                }
            )
        }
    }
}
```