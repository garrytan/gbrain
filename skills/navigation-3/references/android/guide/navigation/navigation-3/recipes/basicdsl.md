# Basic DSL Recipe

This recipe shows a basic example of how to use the Navigation 3 API with two screens, using the `entryProvider` DSL and a persistent back stack.

## How it works

This example is similar to the basic recipe, but with a few key differences:

1. **Persistent Back Stack** : It uses `rememberNavBackStack(RouteA)` to create and remember the back stack. This makes the back stack persistent across configuration changes (e.g., screen rotation). To use `rememberNavBackStack`, the navigation keys must be serializable, which is why `RouteA` and `RouteB` are annotated with `@Serializable` and implement the `NavKey` interface.

2. **`entryProvider` DSL** : Instead of a `when` statement, this example uses the `entryProvider` DSL to define the content for each route. The `entry<RouteType>` function is used to associate a route type with its composable content.

The navigation logic remains the same: to navigate from `RouteA` to `RouteB`, we add a `RouteB` instance to the back stack.
[![](https://developer.android.com/static/images/picto-icons/code.svg) Explore View the full recipe on GitHub.](https://github.com/android/nav3-recipes/tree/main/app/src/main/java/com/example/nav3recipes/basicdsl)

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

package com.example.nav3recipes.basicdsl

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.lifecycle.compose.dropUnlessResumed
import androidx.navigation3.runtime.NavKey
import androidx.navigation3.runtime.entryProvider
import androidx.navigation3.runtime.rememberNavBackStack
import androidx.navigation3.ui.NavDisplay
import com.example.nav3recipes.content.ContentBlue
import com.example.nav3recipes.content.ContentGreen
import com.example.nav3recipes.ui.setEdgeToEdgeConfig
import kotlinx.serialization.Serializable

@Serializable
private data object RouteA : NavKey

@Serializable
private data class RouteB(val id: String) : NavKey

class BasicDslActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        setEdgeToEdgeConfig()
        super.onCreate(savedInstanceState)
        setContent {
            val backStack = rememberNavBackStack(RouteA)

            NavDisplay(
                backStack = backStack,
                onBack = { backStack.removeLastOrNull() },
                entryProvider = entryProvider {
                    entry<RouteA> {
                        ContentGreen("Welcome to Nav3") {
                            Button(onClick = dropUnlessResumed {
                                backStack.add(RouteB("123"))
                            }) {
                                Text("Click to navigate")
                            }
                        }
                    }
                    entry<RouteB> { key ->
                        ContentBlue("Route id: ${key.id} ")
                    }
                }
            )
        }
    }
}
```