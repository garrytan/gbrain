When creating a Glimmer Button component, refer to the following implementation
samples in `ButtonSamples.kt`:


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
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.wrapContentSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.xr.glimmer.Button
import androidx.xr.glimmer.ButtonSize
import androidx.xr.glimmer.GlimmerTheme
import androidx.xr.glimmer.Icon
import androidx.xr.glimmer.Text
import androidx.xr.glimmer.list.GlimmerLazyColumn

@Composable
fun ButtonSampleUsage() {
    GlimmerLazyColumn(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = Modifier.fillMaxSize().wrapContentSize(Alignment.Center),
    ) {
        item { ButtonSample() }
        item { ButtonWithLeadingIconSample() }
        item { ButtonWithTrailingIconSample() }
        item { ButtonWithLeadingAndTrailingIconSample() }
        item { LargeButtonSample() }
        item { LargeButtonWithLeadingIconSample() }
        item { LargeButtonWithTrailingIconSample() }
        item { LargeButtonWithLeadingAndTrailingIconSample() }
    }
}

@Sampled
@Composable
fun ButtonSample() {
    Button(onClick = {}) { Text("Send") }
}

@Sampled
@Composable
fun ButtonWithLeadingIconSample() {
    Button(onClick = {}, leadingIcon = { Icon(FavoriteIcon, "Localized description") }) {
        Text("Send")
    }
}

@Composable
private fun ButtonWithTrailingIconSample() {
    Button(onClick = {}, trailingIcon = { Icon(FavoriteIcon, "Localized description") }) {
        Text("Send")
    }
}

@Composable
private fun ButtonWithLeadingAndTrailingIconSample() {
    Button(
        onClick = {},
        leadingIcon = { Icon(FavoriteIcon, "Localized description") },
        trailingIcon = { Icon(FavoriteIcon, "Localized description") },
    ) {
        Text("Send")
    }
}

@Sampled
@Composable
fun LargeButtonSample() {
    Button(onClick = {}, buttonSize = ButtonSize.Large) { Text("Send") }
}

@Composable
private fun LargeButtonWithLeadingIconSample() {
    Button(
        onClick = {},
        buttonSize = ButtonSize.Large,
        leadingIcon = { Icon(FavoriteIcon, "Localized description") },
    ) {
        Text("Send")
    }
}

@Composable
private fun LargeButtonWithTrailingIconSample() {
    Button(
        onClick = {},
        buttonSize = ButtonSize.Large,
        trailingIcon = { Icon(FavoriteIcon, "Localized description") },
    ) {
        Text("Send")
    }
}

@Composable
private fun LargeButtonWithLeadingAndTrailingIconSample() {
    Button(
        onClick = {},
        buttonSize = ButtonSize.Large,
        leadingIcon = { Icon(FavoriteIcon, "Localized description") },
        trailingIcon = { Icon(FavoriteIcon, "Localized description") },
    ) {
        Text("Send")
    }
}

@Preview
@Composable
private fun ButtonPreview() {
    GlimmerTheme { ButtonSample() }
}

@Preview
@Composable
private fun ButtonWithLeadingIconPreview() {
    GlimmerTheme { ButtonWithLeadingIconSample() }
}

@Preview
@Composable
private fun ButtonWithTrailingIconPreview() {
    GlimmerTheme { ButtonWithTrailingIconSample() }
}

@Preview
@Composable
private fun ButtonWithLeadingAndTrailingIconPreview() {
    GlimmerTheme { ButtonWithLeadingAndTrailingIconSample() }
}

@Preview
@Composable
private fun LargeButtonPreview() {
    GlimmerTheme { LargeButtonSample() }
}

@Preview
@Composable
private fun LargeButtonWithLeadingIconPreview() {
    GlimmerTheme { LargeButtonWithLeadingIconSample() }
}

@Preview
@Composable
private fun LargeButtonWithTrailingIconPreview() {
    GlimmerTheme { LargeButtonWithTrailingIconSample() }
}

@Preview
@Composable
private fun LargeButtonWithLeadingAndTrailingIconPreview() {
    GlimmerTheme { LargeButtonWithLeadingAndTrailingIconSample() }
}
```

<br />