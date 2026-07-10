# Deep Link Advanced Recipe

This recipe demonstrates how to apply the principles of navigation in the context of deep links by
managing a synthetic backStack and Task stacks.

# Recipe Structure

This recipe simulates a real-world scenario where "App A" deeplinks
into "App B".

"App A" is simulated by the module [com.example.nav3recipes.deeplink.advanced](https://developer.android.com/app/src/main/java/com/example/nav3recipes/deeplink/advanced), which
contains the `CreateAdvancedDeepLinkActivity` that allows you to create a deeplink intent and
trigger that in either the existing Task, or in a new Task.

"App B" is simulated by the module [advanceddeeplinkapp](https://developer.android.com/advanceddeeplinkapp/src/main/java/com/example/nav3recipes/deeplink/advanced), which contains
the MainActivity that you deeplink into. That module shows you how to build a synthetic backStack
and how to manage the Task stack properly in order to support both Back and Up buttons.

# Core implementation

The core helper functions for navigateUp and building synthetic backStack can be
found [here](https://developer.android.com/static/advanceddeeplinkapp/src/main/java/com/example/nav3recipes/deeplink/advanced/util/DeepLinkBackStackUtil.kt)

# Further Read

Check out the [deep link guide](https://developer.android.com/docs/deeplink-guide) for a
comprehensive guide on Deep linking principles and how to apply them in Navigation 3.
[![](https://developer.android.com/static/images/picto-icons/code.svg) Explore View the full recipe on GitHub.](https://github.com/android/nav3-recipes/tree/main/app/src/main/java/com/example/nav3recipes/deeplink/advanced)

```
package com.example.nav3recipes.deeplink.advanced

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.core.net.toUri
import androidx.lifecycle.compose.dropUnlessResumed
import com.example.nav3recipes.common.deeplink.EntryScreen
import com.example.nav3recipes.common.deeplink.LIST_FIRST_NAMES
import com.example.nav3recipes.common.deeplink.LIST_LOCATIONS
import com.example.nav3recipes.common.deeplink.MenuDropDown
import com.example.nav3recipes.common.deeplink.PaddedButton
import com.example.nav3recipes.common.deeplink.TextContent
import com.example.nav3recipes.ui.setEdgeToEdgeConfig

internal const val ADVANCED_PATH_BASE = "https://www.nav3deeplink.com"

/**
 * The recipe entry point that allows users to create a deep link and make a request with it.
 *
 * **HOW THIS RECIPE WORKS** This recipe simulates a real-world scenario where "App A" deeplinks
 * into "App B".
 *
 * "App A" is simulated by this current module [com.example.nav3recipes.deeplink.advanced], which
 * contains the [AdvancedCreateDeepLinkActivity] that allows you to create a deeplink intent and
 * trigger that in either the existing Task, or in a new Task.
 *
 * "App B" is simulated by the module [com.example.nav3recipes.deeplink.advanced], which contains
 * the MainActivity that you deeplink into. That module shows you how to build a synthetic backStack
 * and how to manage the Task stack properly in order to support both Back and Up buttons.
 *
 * See the [README](README.md) file of current module for more info on advanced deep linking.
 */
class AdvancedCreateDeepLinkActivity: ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        setEdgeToEdgeConfig()
        super.onCreate(savedInstanceState)

        setContent {
            EntryScreen("Sandbox - Build Your Deeplink Intent") {
                val initFirstName = MENU_OPTIONS_FIRST_NAME.values.first().first()
                val initLocation = MENU_OPTIONS_LOCATION.values.last().first()
                val initTaskStack = MENU_OPTIONS_TASK_STACK.values.first().first()
                var firstName by remember { mutableStateOf(initFirstName) }
                var location by remember { mutableStateOf(initLocation) }
                var taskStack by remember { mutableStateOf(initTaskStack) }

                // select first name
                MenuDropDown(
                    menuOptions = MENU_OPTIONS_FIRST_NAME,
                ) { _, selected ->
                    firstName = selected
                }

                // select first name
                MenuDropDown(
                    menuOptions = MENU_OPTIONS_LOCATION,
                ) { _, selected ->
                    location = selected
                }

                // select current task stack or build new task stack
                MenuDropDown(
                    menuOptions = MENU_OPTIONS_TASK_STACK,
                ) { _, selected ->
                    taskStack = selected
                }

                // build final deeplink URL and Intent
                val finalUrl = "${ADVANCED_PATH_BASE}/user/$firstName/$location"

                // display Intent info
                val flagString = if (taskStack == TAG_NEW_TASK) {
                    "Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK"
                } else "<none>"
                val intentString = """
                    | Final Intent:
                    | data = "$finalUrl"
                    | action = Intent.ACTION_VIEW
                    | flags = $flagString
                """.trimMargin()

                TextContent(intentString)

                // deeplink to target
                PaddedButton("Deeplink Away!", onClick = dropUnlessResumed {
                    val intent = Intent().apply {
                        data = finalUrl.toUri()
                        action = Intent.ACTION_VIEW
                        if (taskStack == TAG_NEW_TASK) {
                            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
                        }
                    }

                    startActivity(intent)
                })
            }
        }
    }
}

private const val TAG_FIRST_NAME = "firstName"
private const val TAG_LOCATION = "location"
private const val TAG_TASK_STACK = "Task stack"
private const val TAG_CURRENT_TASK = "Use Current Task Stack"
private const val TAG_NEW_TASK = "Start New Task Stack"

private val MENU_OPTIONS_FIRST_NAME = mapOf(
    TAG_FIRST_NAME to LIST_FIRST_NAMES
)

private val MENU_OPTIONS_LOCATION = mapOf(
    TAG_LOCATION to LIST_LOCATIONS
)

private val MENU_OPTIONS_TASK_STACK = mapOf(
    TAG_TASK_STACK to listOf(TAG_CURRENT_TASK, TAG_NEW_TASK),
)
```