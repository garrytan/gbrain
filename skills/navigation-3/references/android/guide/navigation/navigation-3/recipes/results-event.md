# Returning a Result (Event-Based)

This recipe demonstrates how to return a result from one screen to a previous screen using an event-based approach.

## How it works

This example uses a `ResultEventBus` to facilitate communication between the screens.

1. **ResultEventBusNavEntryDecorator** : A `NavEntryDecorator` that provides a `ResultEventBus` via `LocalResultEventBus`.
2. **`ResultEventBus`** : A `ResultEventBus` is created and made available to the composables via `LocalResultEventBus`. This EventBus sends and receives the results.
3. **Sending the result** : The screen that produces the result calls `resultBus.sendResult(person)` to send the data back as a one-time event.
4. **Receiving the result** : The screen that needs the result uses a `ResultEffect` composable to listen for results of a specific type. When a result is received, the effect's lambda is triggered.

This approach is useful for results that are transient and should be handled as one-time events.
[![](https://developer.android.com/static/images/picto-icons/code.svg) Explore View the full recipe on GitHub.](https://github.com/android/nav3-recipes/tree/main/app/src/main/java/com/example/nav3recipes/results/event)

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

package com.example.nav3recipes.results.common

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel

class HomeViewModel : ViewModel() {
    var person by mutableStateOf<Person?>(null)
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

package com.example.nav3recipes.results.common

import androidx.navigation3.runtime.NavKey
import kotlinx.serialization.Serializable

@Serializable
data object Home : NavKey

@Serializable
class PersonDetailsForm : NavKey
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

package com.example.nav3recipes.results.common

import android.os.Parcelable
import kotlinx.parcelize.Parcelize

@Parcelize
data class Person(val name: String, val favoriteColor: String) : Parcelable
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

package com.example.nav3recipes.results.common

import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.text.input.rememberTextFieldState
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.dropUnlessResumed
import com.example.nav3recipes.content.ContentBlue
import com.example.nav3recipes.content.ContentGreen

@Composable
fun HomeScreen(
    person: Person?,
    onNext: () -> Unit
) {
    ContentBlue("Hello ${person?.name ?: "unknown person"}") {

        if (person != null) {
            Text("Your favorite color is ${person.favoriteColor}")
        }

        Spacer(Modifier.height(16.dp))
        Button(onClick = dropUnlessResumed(block = onNext)) {
            Text("Tell us about yourself")
        }
    }
}

@Composable
fun PersonDetailsScreen(
    onSubmit: (Person) -> Unit
) {
    ContentGreen("About you") {

        val nameTextState = rememberTextFieldState()
        OutlinedTextField(
            state = nameTextState,
            label = { Text("Please enter your name") }
        )

        val favoriteColorTextState = rememberTextFieldState()
        OutlinedTextField(
            state = favoriteColorTextState,
            label = { Text("Please enter your favorite color") }
        )

        Button(
            onClick = dropUnlessResumed {
                val person = Person(
                    name = nameTextState.text.toString(),
                    favoriteColor = favoriteColorTextState.text.toString()
                )
                onSubmit(person)
            },
            enabled = nameTextState.text.isNotBlank() &&
                    favoriteColorTextState.text.isNotBlank()
        ) {
            Text("Submit")
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

package com.example.nav3recipes.results.event

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation3.runtime.entryProvider
import androidx.navigation3.runtime.rememberNavBackStack
import androidx.navigation3.runtime.result.LocalResultEventBus
import androidx.navigation3.runtime.result.ResultEffect
import androidx.navigation3.runtime.result.ResultEventBus
import androidx.navigation3.runtime.result.rememberResultEventBusNavEntryDecorator
import androidx.navigation3.ui.NavDisplay
import com.example.nav3recipes.results.common.Home
import com.example.nav3recipes.results.common.HomeScreen
import com.example.nav3recipes.results.common.HomeViewModel
import com.example.nav3recipes.results.common.Person
import com.example.nav3recipes.results.common.PersonDetailsForm
import com.example.nav3recipes.results.common.PersonDetailsScreen
import com.example.nav3recipes.ui.setEdgeToEdgeConfig

class ResultEventActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        setEdgeToEdgeConfig()
        super.onCreate(savedInstanceState)

        setContent {
            Scaffold { paddingValues ->

                val backStack = rememberNavBackStack(Home)

                NavDisplay(
                    backStack = backStack,
                    modifier = Modifier.padding(paddingValues),
                    onBack = { backStack.removeLastOrNull() },
                    entryDecorators = listOf(rememberResultEventBusNavEntryDecorator()),
                    entryProvider = entryProvider {
                        entry<Home> {
                            val viewModel = viewModel<HomeViewModel>(key = Home.toString())
                            ResultEffect<Person> { person ->
                                viewModel.person = person
                            }

                            val person = viewModel.person
                            HomeScreen(
                                person = person,
                                onNext = { backStack.add(PersonDetailsForm()) }
                            )
                        }
                        entry<PersonDetailsForm> {
                            val resultBus = LocalResultEventBus.current
                            PersonDetailsScreen(
                                onSubmit = { person ->
                                    resultBus.sendResult<Person>(result = person)
                                    backStack.removeLastOrNull()
                                }
                            )
                        }
                    }
                )
            }
        }
    }
}
```