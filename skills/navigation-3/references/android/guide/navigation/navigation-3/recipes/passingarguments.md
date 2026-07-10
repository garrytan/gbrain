# Passing Arguments to ViewModels (Hilt)

This recipe demonstrates how to pass navigation arguments (keys) to a `ViewModel` using Hilt for dependency injection.

## How it works

This example uses Dagger/Hilt's assisted injection feature:

1. The `ViewModel` is annotated with `@HiltViewModel` and its constructor uses `@AssistedInject` to receive the navigation key (which is annotated with `@Assisted`).
2. An `@AssistedFactory` interface is defined to create the `ViewModel`.
3. The `hiltViewModel` composable function is used to obtain the `ViewModel` instance. A `creationCallback` is provided to pass the navigation key to the factory, making it available to the `ViewModel`.

**Note** : The `rememberViewModelStoreNavEntryDecorator` is added to the `NavDisplay`'s `entryDecorators`. This ensures that `ViewModel`s are correctly scoped to their corresponding `NavEntry`, so that a new `ViewModel` instance is created for each unique navigation key.
[![](https://developer.android.com/static/images/picto-icons/code.svg) Explore View the full recipe on GitHub.](https://github.com/android/nav3-recipes/tree/main/app/src/main/java/com/example/nav3recipes/passingarguments/viewmodels/hilt)

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

package com.example.nav3recipes.passingarguments.viewmodels.hilt

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.hilt.lifecycle.viewmodel.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.dropUnlessResumed
import androidx.lifecycle.viewmodel.navigation3.rememberViewModelStoreNavEntryDecorator
import androidx.navigation3.runtime.entryProvider
import androidx.navigation3.runtime.rememberSaveableStateHolderNavEntryDecorator
import androidx.navigation3.ui.NavDisplay
import com.example.nav3recipes.content.ContentBlue
import com.example.nav3recipes.content.ContentGreen
import com.example.nav3recipes.passingarguments.viewmodels.basic.RouteB
import com.example.nav3recipes.ui.setEdgeToEdgeConfig
import dagger.assisted.Assisted
import dagger.assisted.AssistedFactory
import dagger.assisted.AssistedInject
import dagger.hilt.android.AndroidEntryPoint
import dagger.hilt.android.lifecycle.HiltViewModel

data object RouteA
data class RouteB(val id: String)

@AndroidEntryPoint
class HiltViewModelsActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        setEdgeToEdgeConfig()
        super.onCreate(savedInstanceState)
        setContent {
            val backStack = remember { mutableStateListOf<Any>(RouteA) }

            NavDisplay(
                backStack = backStack,
                onBack = { backStack.removeLastOrNull() },

                // In order to add the `ViewModelStoreNavEntryDecorator` (see comment below for why)
                // we also need to add the default `NavEntryDecorator`s as well. These provide
                // extra information to the entry's content to enable it to display correctly
                // and save its state.
                entryDecorators = listOf(
                    rememberSaveableStateHolderNavEntryDecorator(),
                    rememberViewModelStoreNavEntryDecorator()
                ),
                entryProvider = entryProvider {
                    entry<RouteA> {
                        ContentGreen("Welcome to Nav3") {
                            LazyColumn {
                                items(10) { i ->
                                    Button(onClick = dropUnlessResumed {
                                        backStack.add(RouteB("$i"))
                                    }) {
                                        Text("$i")
                                    }
                                }
                            }
                        }
                    }
                    entry<RouteB> { key ->
                        val viewModel = hiltViewModel<RouteBViewModel, RouteBViewModel.Factory>(
                            // Note: We need a new ViewModel for every new RouteB instance. Usually
                            // we would need to supply a `key` String that is unique to the
                            // instance, however, the ViewModelStoreNavEntryDecorator (supplied
                            // above) does this for us, using `NavEntry.contentKey` to uniquely
                            // identify the viewModel.
                            //
                            // tl;dr: Make sure you use rememberViewModelStoreNavEntryDecorator()
                            // if you want a new ViewModel for each new navigation key instance.
                            creationCallback = { factory ->
                                factory.create(key)
                            }
                        )
                        ScreenB(viewModel = viewModel)
                    }
                }
            )
        }
    }
}

@Composable
fun ScreenB(viewModel: RouteBViewModel) {
    ContentBlue("Route id: ${viewModel.navKey.id} ")
}

@HiltViewModel(assistedFactory = RouteBViewModel.Factory::class)
class RouteBViewModel @AssistedInject constructor(
    @Assisted val navKey: RouteB
) : ViewModel() {

    @AssistedFactory
    interface Factory {
        fun create(navKey: RouteB): RouteBViewModel
    }
}
```

# Passing Arguments to ViewModels (Basic)

This recipe demonstrates how to pass navigation arguments (keys) to a `ViewModel` using a custom `ViewModelProvider.Factory`.

## How it works

1. A custom `ViewModelProvider.Factory` is created that takes the navigation key as a constructor parameter.
2. Inside the `entry` composable, `viewModel(factory = ...)` is used to create the `ViewModel` instance, passing the current navigation key to the factory. This makes the navigation key available to the `ViewModel`.

**Note** : The `rememberViewModelStoreNavEntryDecorator` is added to the `NavDisplay`'s `entryDecorators`. This ensures that `ViewModel`s are correctly scoped to their corresponding `NavEntry`, so that a new `ViewModel` instance is created for each unique navigation key.
[![](https://developer.android.com/static/images/picto-icons/code.svg) Explore View the full recipe on GitHub.](https://github.com/android/nav3-recipes/tree/main/app/src/main/java/com/example/nav3recipes/passingarguments/viewmodels/basic)

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

package com.example.nav3recipes.passingarguments.viewmodels.basic

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.compose.dropUnlessResumed
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.navigation3.rememberViewModelStoreNavEntryDecorator
import androidx.navigation3.runtime.entryProvider
import androidx.navigation3.runtime.rememberSaveableStateHolderNavEntryDecorator
import androidx.navigation3.ui.NavDisplay
import com.example.nav3recipes.content.ContentBlue
import com.example.nav3recipes.content.ContentGreen
import com.example.nav3recipes.ui.setEdgeToEdgeConfig

data object RouteA

data class RouteB(val id: String)

class BasicViewModelsActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        setEdgeToEdgeConfig()
        super.onCreate(savedInstanceState)
        setContent {
            val backStack = remember { mutableStateListOf<Any>(RouteA) }

            NavDisplay(
                backStack = backStack,
                onBack = { backStack.removeLastOrNull() },
                // In order to add the `ViewModelStoreNavEntryDecorator` (see comment below for why)
                // we also need to add the default `NavEntryDecorator`s as well. These provide
                // extra information to the entry's content to enable it to display correctly
                // and save its state.
                entryDecorators = listOf(
                    rememberSaveableStateHolderNavEntryDecorator(),
                    rememberViewModelStoreNavEntryDecorator()
                ),
                entryProvider = entryProvider {
                    entry<RouteA> {
                        ContentGreen("Welcome to Nav3") {
                            LazyColumn {
                                items(10) { i ->
                                    Button(onClick = dropUnlessResumed {
                                        backStack.add(RouteB("$i"))
                                    }) {
                                        Text("$i")
                                    }
                                }
                            }
                        }
                    }
                    entry<RouteB> { key ->
                        // Note: We need a new ViewModel for every new RouteB instance. Usually
                        // we would need to supply a `key` String that is unique to the
                        // instance, however, the ViewModelStoreNavEntryDecorator (supplied
                        // above) does this for us, using `NavEntry.contentKey` to uniquely
                        // identify the viewModel.
                        //
                        // tl;dr: Make sure you use rememberViewModelStoreNavEntryDecorator()
                        // if you want a new ViewModel for each new navigation key instance.
                        ScreenB(viewModel = viewModel(factory = RouteBViewModel.Factory(key)))
                    }
                }
            )
        }
    }
}

@Composable
fun ScreenB(viewModel: RouteBViewModel = viewModel()) {
    ContentBlue("Route id: ${viewModel.key.id} ")
}

class RouteBViewModel(
    val key: RouteB
) : ViewModel() {
    class Factory(
        private val key: RouteB,
    ) : ViewModelProvider.Factory {
        override fun <T : ViewModel> create(modelClass: Class<T>): T {
            return RouteBViewModel(key) as T
        }
    }
}
```

# Passing Arguments to ViewModels (Koin)

This recipe demonstrates how to pass navigation arguments (keys) to a `ViewModel` using Koin for dependency injection.

## How it works

1. A Koin module is defined that provides the `ViewModel`.
2. The `koinViewModel` composable function is used to get the `ViewModel` instance.
3. The navigation key is passed to the `ViewModel`'s constructor using `parametersOf(key)`. This makes the navigation key available to the `ViewModel`.

**Note** : The `rememberViewModelStoreNavEntryDecorator` is added to the `NavDisplay`'s `entryDecorators`. This ensures that `ViewModel`s are correctly scoped to their corresponding `NavEntry`, so that a new `ViewModel` instance is created for each unique navigation key.
[![](https://developer.android.com/static/images/picto-icons/code.svg) Explore View the full recipe on GitHub.](https://github.com/android/nav3-recipes/tree/main/app/src/main/java/com/example/nav3recipes/passingarguments/viewmodels/koin)

```
package com.example.nav3recipes.passingarguments.viewmodels.koin

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.dropUnlessResumed
import androidx.lifecycle.viewmodel.navigation3.rememberViewModelStoreNavEntryDecorator
import androidx.navigation3.runtime.entryProvider
import androidx.navigation3.runtime.rememberSaveableStateHolderNavEntryDecorator
import androidx.navigation3.ui.NavDisplay
import com.example.nav3recipes.content.ContentBlue
import com.example.nav3recipes.content.ContentGreen
import com.example.nav3recipes.ui.setEdgeToEdgeConfig
import org.koin.compose.KoinApplication
import org.koin.compose.viewmodel.koinViewModel
import org.koin.core.module.dsl.viewModelOf
import org.koin.core.parameter.parametersOf
import org.koin.dsl.koinConfiguration
import org.koin.dsl.module

data object RouteA
data class RouteB(val id: String)

class KoinViewModelsActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {

        setEdgeToEdgeConfig()
        super.onCreate(savedInstanceState)
        setContent {
            val backStack = remember { mutableStateListOf<Any>(RouteA) }

            // Koin Compose Entry point
            KoinApplication(
                configuration = koinConfiguration {
                    modules(appModule)
                }
            ) {
                NavDisplay(
                    backStack = backStack,
                    onBack = { backStack.removeLastOrNull() },

                    // In order to add the `ViewModelStoreNavEntryDecorator` (see comment below for why)
                    // we also need to add the default `NavEntryDecorator`s as well. These provide
                    // extra information to the entry's content to enable it to display correctly
                    // and save its state.
                    entryDecorators = listOf(
                        rememberSaveableStateHolderNavEntryDecorator(),
                        rememberViewModelStoreNavEntryDecorator()
                    ),
                    entryProvider = entryProvider {
                        entry<RouteA> {
                            ContentGreen("Welcome to Nav3") {
                                LazyColumn {
                                    items(10) { i ->
                                        Button(onClick = dropUnlessResumed {
                                            backStack.add(RouteB("$i"))
                                        }) {
                                            Text("$i")
                                        }
                                    }
                                }
                            }
                        }
                        entry<RouteB> { key ->
                            val viewModel = koinViewModel<RouteBViewModel> {
                                parametersOf(key)
                            }
                            ScreenB(viewModel = viewModel)
                        }
                    }
                )
            }
        }
    }
}

// Local Koin Module
private val appModule = module {
    viewModelOf(::RouteBViewModel)
}

@Composable
fun ScreenB(viewModel: RouteBViewModel) {
    ContentBlue("Route id: ${viewModel.navKey.id} ")
}

class RouteBViewModel(val navKey: RouteB) : ViewModel()
```