When creating a Glimmer Title Chip component, refer to the following
implementation samples in `TitleChipSamples.kt`:


```kotlin
/*
 * Copyright 2025 The Android Open Source Project
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

package androidx.xr.glimmer.samples

import androidx.annotation.Sampled
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.wrapContentSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.xr.glimmer.Card
import androidx.xr.glimmer.GlimmerTheme
import androidx.xr.glimmer.Icon
import androidx.xr.glimmer.Text
import androidx.xr.glimmer.TitleChip
import androidx.xr.glimmer.TitleChipDefaults
import androidx.xr.glimmer.list.GlimmerLazyColumn

@Composable
fun TitleChipSampleUsage() {
    GlimmerLazyColumn(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = Modifier.fillMaxSize().wrapContentSize(Alignment.Center),
    ) {
        item { TitleChipSample() }
        item { TitleChipWithLeadingIconSample() }
        item { TitleChipWithCardSample() }
    }
}

@Sampled
@Composable
fun TitleChipSample() {
    TitleChip { Text("Messages") }
}

@Sampled
@Composable
fun TitleChipWithLeadingIconSample() {
    TitleChip(leadingIcon = { Icon(FavoriteIcon, "Localized description") }) { Text("Messages") }
}

@Sampled
@Composable
fun TitleChipWithCardSample() {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        TitleChip { Text("Title Chip") }
        Spacer(Modifier.height(TitleChipDefaults.associatedContentSpacing))
        Card(
            title = { Text("Title") },
            subtitle = { Text("Subtitle") },
            leadingIcon = { Icon(FavoriteIcon, "Localized description") },
        ) {
            Text("Card Content")
        }
    }
}

@Preview
@Composable
private fun TitleChipPreview() {
    GlimmerTheme { TitleChipSample() }
}

@Preview
@Composable
private fun TitleChipWithLeadingIconPreview() {
    GlimmerTheme { TitleChipWithLeadingIconSample() }
}

@Preview
@Composable
private fun TitleChipWithCardPreview() {
    GlimmerTheme { TitleChipWithCardSample() }
}
```

<br />