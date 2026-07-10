# Animations Recipe

This recipe shows how to override the default animations at the `NavDisplay` level, and at the individual destination level.

## How it works

The `NavDisplay` composable takes `transitionSpec`, `popTransitionSpec`, and `predictivePopTransitionSpec` parameters to define the animations for forward, backward, and predictive back navigation respectively. These animations will be applied to all destinations by default.

In this example, we use `slideInHorizontally` and `slideOutHorizontally` to create a sliding animation for forward and backward navigation.

It is also possible to override these animations for a specific destination by providing a different `transitionSpec` and `popTransitionSpec` to the `entry` composable. In this recipe, `ScreenC` has a custom vertical slide animation.
[![](https://developer.android.com/static/images/picto-icons/code.svg) Explore View the full recipe on GitHub.](https://github.com/android/nav3-recipes/tree/main/app/src/main/java/com/example/nav3recipes/animations)

```
package com.example.nav3recipes.animations


import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.lifecycle.compose.dropUnlessResumed
import androidx.navigation3.runtime.NavKey
import androidx.navigation3.runtime.entryProvider
import androidx.navigation3.runtime.metadata
import androidx.navigation3.runtime.rememberNavBackStack
import androidx.navigation3.ui.NavDisplay
import com.example.nav3recipes.content.ContentGreen
import com.example.nav3recipes.content.ContentMauve
import com.example.nav3recipes.content.ContentOrange
import com.example.nav3recipes.ui.setEdgeToEdgeConfig
import kotlinx.serialization.Serializable


@Serializable
private data object ScreenA : NavKey

@Serializable
private data object ScreenB : NavKey

@Serializable
private data object ScreenC : NavKey


class AnimatedActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        setEdgeToEdgeConfig()
        super.onCreate(savedInstanceState)
        setContent {

            val backStack = rememberNavBackStack(ScreenA)

            NavDisplay(
                backStack = backStack,
                onBack = { backStack.removeLastOrNull() },
                entryProvider = entryProvider {
                    entry<ScreenA> {
                        ContentOrange("This is Screen A") {
                            Button(onClick = dropUnlessResumed { backStack.add(ScreenB) }) {
                                Text("Go to Screen B")
                            }
                        }
                    }
                    entry<ScreenB> {
                        ContentMauve("This is Screen B") {
                            Button(onClick = dropUnlessResumed { backStack.add(ScreenC) }) {
                                Text("Go to Screen C")
                            }
                        }
                    }
                    entry<ScreenC>(
                        metadata = metadata {
                            // Slide new content up, keeping the old content in place underneath
                            put(NavDisplay.TransitionKey) {
                                slideInVertically(
                                    initialOffsetY = { it },
                                    animationSpec = tween(1000)
                                ) togetherWith ExitTransition.KeepUntilTransitionsFinished
                            }

                            // Slide old content down, revealing the new content in place underneath
                            put(NavDisplay.PopTransitionKey) {
                                EnterTransition.None togetherWith
                                        slideOutVertically(
                                            targetOffsetY = { it },
                                            animationSpec = tween(1000)
                                        )
                            }

                            // Slide old content down, revealing the new content in place underneath
                            put(NavDisplay.PredictivePopTransitionKey) {
                                EnterTransition.None togetherWith
                                        slideOutVertically(
                                            targetOffsetY = { it },
                                            animationSpec = tween(1000)
                                        )
                            }
                        }
                    ) {
                        ContentGreen("This is Screen C")
                    }
                },
                transitionSpec = {
                    // Slide in from right when navigating forward
                    slideInHorizontally(
                        initialOffsetX = { it },
                        animationSpec = tween(1000)
                    ) togetherWith slideOutHorizontally(
                        targetOffsetX = { -it },
                        animationSpec = tween(1000)
                    )
                },
                popTransitionSpec = {
                    // Slide in from left when navigating back
                    slideInHorizontally(
                        initialOffsetX = { -it },
                        animationSpec = tween(1000)
                    ) togetherWith slideOutHorizontally(
                        targetOffsetX = { it },
                        animationSpec = tween(1000)
                    )
                },
                predictivePopTransitionSpec = {
                    // Slide in from left when navigating back
                    slideInHorizontally(
                        initialOffsetX = { -it },
                        animationSpec = tween(1000)
                    ) togetherWith slideOutHorizontally(
                        targetOffsetX = { it },
                        animationSpec = tween(1000)
                    )
                }
            )
        }
    }
}
```