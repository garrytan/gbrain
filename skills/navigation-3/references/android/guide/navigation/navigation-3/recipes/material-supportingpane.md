# Material Supporting Pane Recipe

This recipe demonstrates how to create an adaptive layout with a main pane and a supporting pane using the `SupportingPaneSceneStrategy` from the Material 3 Adaptive library. This layout is useful for displaying supplementary content alongside the main content on larger screens.

## How it works

This example has three destinations: `MainVideo`, `RelatedVideos`, and `Profile`.

### `SupportingPaneSceneStrategy`

The `rememberSupportingPaneSceneStrategy` provides the logic for this adaptive layout.

- **Pane Roles**: Each destination is assigned a role using metadata:

  - `SupportingPaneSceneStrategy.mainPane()`: For the primary content. This pane is always visible.
  - `SupportingPaneSceneStrategy.supportingPane()`: For the supplementary content. This pane is shown alongside the main pane on larger screens.
  - `SupportingPaneSceneStrategy.extraPane()`: For tertiary content that can be displayed alongside the supporting pane on even larger screens.
- **Adaptive Layout** : The `SupportingPaneSceneStrategy` automatically handles the layout. On smaller screens, only the main pane is shown. On larger screens, the supporting pane is shown next to the main pane.

- **Back Navigation** : The `BackNavigationBehavior` is customized in this example to `PopUntilCurrentDestinationChange`. This means that when the user presses the back button, the supporting pane will be dismissed, revealing the main pane underneath.

- **Navigation** : Navigation is handled by adding and removing destinations from the back stack. The `SupportingPaneSceneStrategy` observes these changes and adjusts the layout accordingly.

[![](https://developer.android.com/static/images/picto-icons/code.svg) Explore View the full recipe on GitHub.](https://github.com/android/nav3-recipes/tree/main/app/src/main/java/com/example/nav3recipes/material/supportingpane)

```
package com.example.nav3recipes.material.supportingpane

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

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.material3.adaptive.ExperimentalMaterial3AdaptiveApi
import androidx.compose.material3.adaptive.currentWindowAdaptiveInfoV2
import androidx.compose.material3.adaptive.layout.calculatePaneScaffoldDirective
import androidx.compose.material3.adaptive.navigation.BackNavigationBehavior
import androidx.compose.material3.adaptive.navigation3.SupportingPaneSceneStrategy
import androidx.compose.material3.adaptive.navigation3.rememberSupportingPaneSceneStrategy
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.dropUnlessResumed
import androidx.navigation3.runtime.NavKey
import androidx.navigation3.runtime.entryProvider
import androidx.navigation3.runtime.rememberNavBackStack
import androidx.navigation3.ui.NavDisplay
import com.example.nav3recipes.content.ContentBlue
import com.example.nav3recipes.content.ContentGreen
import com.example.nav3recipes.content.ContentRed
import com.example.nav3recipes.ui.setEdgeToEdgeConfig
import kotlinx.serialization.Serializable

@Serializable
private object MainVideo : NavKey

@Serializable
private data object RelatedVideos : NavKey

@Serializable
private data object Profile : NavKey

class MaterialSupportingPaneActivity : ComponentActivity() {

    @OptIn(ExperimentalMaterial3AdaptiveApi::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        setEdgeToEdgeConfig()
        super.onCreate(savedInstanceState)

        setContent {

            val backStack = rememberNavBackStack(MainVideo)

            // Override the defaults so that there isn't a horizontal or vertical space between the panes.
            // See b/444438086
            val windowAdaptiveInfo = currentWindowAdaptiveInfoV2()
            val directive = remember(windowAdaptiveInfo) {
                calculatePaneScaffoldDirective(windowAdaptiveInfo)
                    .copy(horizontalPartitionSpacerSize = 0.dp, verticalPartitionSpacerSize = 0.dp)
            }

            // Override the defaults so that the supporting pane can be dismissed by pressing back.
            // See b/445826749
            val supportingPaneStrategy = rememberSupportingPaneSceneStrategy<NavKey>(
                backNavigationBehavior = BackNavigationBehavior.PopUntilCurrentDestinationChange,
                directive = directive
            )

            NavDisplay(
                backStack = backStack,
                onBack = { backStack.removeLastOrNull() },
                sceneStrategies = listOf(supportingPaneStrategy),
                entryProvider = entryProvider {
                    entry<MainVideo>(
                        metadata = SupportingPaneSceneStrategy.mainPane()
                    ) {
                        ContentRed("Video content") {
                            Button(onClick = dropUnlessResumed {
                                backStack.add(RelatedVideos)
                            }) {
                                Text("View related videos")
                            }
                        }
                    }
                    entry<RelatedVideos>(
                        metadata = SupportingPaneSceneStrategy.supportingPane()
                    ) {
                        ContentBlue("Related videos") {
                            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                Button(onClick = dropUnlessResumed {
                                    backStack.add(Profile)
                                }) {
                                    Text("View profile")
                                }
                            }
                        }
                    }
                    entry<Profile>(
                        metadata = SupportingPaneSceneStrategy.extraPane()
                    ) {
                        ContentGreen("Profile")
                    }
                }
            )
        }
    }
}
```