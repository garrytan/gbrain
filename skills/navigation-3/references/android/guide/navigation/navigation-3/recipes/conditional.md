# Conditional Navigation Recipe

This recipe demonstrates how to implement conditional navigation, where certain destinations are only accessible if a condition is met (in this case, if the user is logged in).

## How it works

This example has a `Profile` destination that requires the user to be logged in. If the user is not logged in and attempts to navigate to `Profile`, they are redirected to a `Login` screen. After a successful login, they are automatically navigated to the `Profile` screen.

### `AppBackStack`

The core of this recipe is the custom `AppBackStack` class, which encapsulates the logic for conditional navigation.

- **`RequiresLogin` interface** : A marker interface, `RequiresLogin`, is used to identify destinations that require the user to be logged in. The `Profile` destination implements this interface.

- **Redirecting to Login** : When the `add` function is called with a destination that implements `RequiresLogin` and the user is not logged in, `AppBackStack` stores the intended destination and adds the `Login` route to the back stack instead.

- **Handling Login** : When the `login` function is called, it sets the user's status to logged in. If there is a stored destination that the user was trying to access, it adds that destination to the back stack and removes the `Login` screen.

- **Handling Logout** : When the `logout` function is called, it sets the user's status to logged out and removes any destinations from the back stack that require the user to be logged in.

This approach provides a clean way to handle conditional navigation by centralizing the logic in a custom back stack implementation.
[![](https://developer.android.com/static/images/picto-icons/code.svg) Explore View the full recipe on GitHub.](https://github.com/android/nav3-recipes/tree/main/app/src/main/java/com/example/nav3recipes/conditional)

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

package com.example.nav3recipes.conditional

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSerializable
import androidx.compose.runtime.setValue
import androidx.lifecycle.compose.dropUnlessResumed
import androidx.navigation3.runtime.NavBackStack
import androidx.navigation3.runtime.NavKey
import androidx.navigation3.runtime.entryProvider
import androidx.navigation3.runtime.serialization.NavBackStackSerializer
import androidx.navigation3.runtime.serialization.NavKeySerializer
import androidx.navigation3.ui.NavDisplay
import com.example.nav3recipes.content.ContentBlue
import com.example.nav3recipes.content.ContentGreen
import com.example.nav3recipes.content.ContentYellow
import com.example.nav3recipes.ui.setEdgeToEdgeConfig
import kotlinx.serialization.Serializable


/**
 * Class for representing navigation keys in the app.
 *
 * Note: We use a sealed class because KotlinX Serialization handles
 * polymorphic serialization of sealed classes automatically.
 *
 * @param requiresLogin - true if the navigation key requires that the user is logged in
 * to navigate to it
 */
@Serializable
sealed class ConditionalNavKey(val requiresLogin: Boolean = false) : NavKey

/**
 * Key representing home screen
 */
@Serializable
private data object Home : ConditionalNavKey()

/**
 * Key representing profile screen that is only accessible once the user has logged in
 */
@Serializable
private data object Profile : ConditionalNavKey(requiresLogin = true)

/**
 * Key representing login screen
 *
 * @param redirectToKey - navigation key to redirect to after successful login
 */
@Serializable
private data class Login(
    val redirectToKey: ConditionalNavKey? = null
) : ConditionalNavKey()

class ConditionalActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        setEdgeToEdgeConfig()
        super.onCreate(savedInstanceState)
        setContent {

            val backStack = rememberNavBackStack<ConditionalNavKey>(Home)
            var isLoggedIn by rememberSaveable {
                mutableStateOf(false)
            }
            val navigator = remember {
                Navigator(
                    backStack = backStack,
                    onNavigateToRestrictedKey = { redirectToKey -> Login(redirectToKey) },
                    isLoggedIn = { isLoggedIn }
                )
            }

            NavDisplay(
                backStack = backStack,
                onBack = { navigator.goBack() },
                entryProvider = entryProvider {
                    entry<Home> {
                        ContentGreen("Welcome to Nav3. Logged in? ${isLoggedIn}") {
                            Column {
                                Button(onClick = dropUnlessResumed { navigator.navigate(Profile) }) {
                                    Text("Profile")
                                }
                                Button(onClick = dropUnlessResumed { navigator.navigate(Login()) }) {
                                    Text("Login")
                                }
                            }
                        }
                    }
                    entry<Profile> {
                        ContentBlue("Profile screen (only accessible once logged in)") {
                            Button(onClick = dropUnlessResumed {
                                isLoggedIn = false
                                navigator.navigate(Home)
                            }) {
                                Text("Logout")
                            }
                        }
                    }
                    entry<Login> { key ->
                        ContentYellow("Login screen. Logged in? $isLoggedIn") {
                            Button(onClick = dropUnlessResumed {
                                isLoggedIn = true
                                key.redirectToKey?.let { targetKey ->
                                    backStack.remove(key)
                                    navigator.navigate(targetKey)
                                }
                            }) {
                                Text("Login")
                            }
                        }
                    }
                }
            )
        }
    }
}


// An overload of `rememberNavBackStack` that returns a subtype of `NavKey`.
// See https://issuetracker.google.com/issues/463382671 for a discussion of this function
@Composable
fun <T : NavKey> rememberNavBackStack(vararg elements: T): NavBackStack<T> {
    return rememberSerializable(
        serializer = NavBackStackSerializer(elementSerializer = NavKeySerializer())
    ) {
        NavBackStack(*elements)
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

package com.example.nav3recipes.conditional

import androidx.navigation3.runtime.NavBackStack

/**
 * Provides navigation events with built-in support for conditional access. If the user attempts to
 * navigate to a [ConditionalNavKey] that requires login ([ConditionalNavKey.requiresLogin] is true)
 * but is not currently logged in, the Navigator will redirect the user to a login key.
 *
 * @property backStack The back stack that is modified by this class
 * @property onNavigateToRestrictedKey A lambda that is called when the user attempts to navigate
 * to a key that requires login. This should return the key that represents the login screen. The
 * user's target key is supplied as a parameter so that after successful login the user can be
 * redirected to their target destination.
 * @property isLoggedIn A lambda that returns whether the user is logged in.
 */
class Navigator(
    private val backStack: NavBackStack<ConditionalNavKey>,
    private val onNavigateToRestrictedKey: (targetKey: ConditionalNavKey?) -> ConditionalNavKey,
    private val isLoggedIn: () -> Boolean,
) {
    fun navigate(key: ConditionalNavKey) {
        if (key.requiresLogin && !isLoggedIn()) {
            val loginKey = onNavigateToRestrictedKey(key)
            backStack.add(loginKey)
        } else {
            backStack.add(key)
        }
    }

    fun goBack() = backStack.removeLastOrNull()
}
```