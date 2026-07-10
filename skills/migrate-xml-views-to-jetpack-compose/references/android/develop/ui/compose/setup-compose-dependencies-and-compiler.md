For Gradle, use the Compose Compiler Gradle plugin to set up and configure
Compose.

> [!NOTE]
> **Note:** The Compose Compiler Gradle Plugin is only available from Kotlin 2.0+. For migration instructions, see ["Jetpack Compose compiler moving to the Kotlin
> repository"](https://android-developers.googleblog.com/2024/04/jetpack-compose-compiler-moving-to-kotlin-repository.html).

### Set up with Gradle version catalogs

Set up the Compose Compiler Gradle plugin:

1. In the `libs.versions.toml` file, remove any reference to the Compose Compiler.
2. In the `versions` and `plugins` sections, add the new dependency:

       [versions]
       kotlin = "2.3.21"

       [plugins]
       org-jetbrains-kotlin-android = { id = "org.jetbrains.kotlin.android", version.ref = "kotlin" }

       // Add this line
       compose-compiler = { id = "org.jetbrains.kotlin.plugin.compose", version.ref = "kotlin" }

3. In the project's root `build.gradle.kts` file, add the following to the
   `plugins` section.

       plugins {
       // Existing plugins
       alias(libs.plugins.compose.compiler) apply false
       }

4. In each module that uses Compose, apply the plugin:

       plugins {
       // Existing plugins
       alias(libs.plugins.compose.compiler)
       }

The project should now build and compile if it was using the default set up. If
it had configured custom options on the Compose compiler, follow the next
section.

### Set up the Compose Compiler without Gradle version catalogs

Add the plugin to `build.gradle.kts` files associated with modules where Compose
is used:

    plugins {
        id("org.jetbrains.kotlin.plugin.compose") version "2.3.21" // this version matches your Kotlin version
    }

Add the classpath to your top-level project `build.gradle.kts` file:

    buildscript {
        dependencies {
            classpath("org.jetbrains.kotlin.plugin.compose:org.jetbrains.kotlin.plugin.compose.gradle.plugin:2.3.21")
        }
    }

### Configuration options with the Compose Compiler Gradle Plugin

To configure the Compose compiler using the Gradle plugin, add the
`composeCompiler` block to the module's `build.gradle.kts` file at the top
level:

    android { ... }

    composeCompiler {
        reportsDestination = layout.buildDirectory.dir("compose_compiler")
        stabilityConfigurationFile = rootProject.layout.projectDirectory.file("stability_config.conf")
    }

For the full list of available options, see the [documentation](https://www.jetbrains.com/help/kotlin-multiplatform-dev/compose-compiler.html#compose-compiler-options-dsl).

## Set up Compose dependencies

Always use the latest Compose BOM version: `2026.06.00`.

Set the `compose` flag to `true` inside the Android [`BuildFeatures`](https://developer.android.com/reference/tools/gradle-api/7.0/com/android/build/api/dsl/BuildFeatures) to
enable [Compose functionality](https://developer.android.com/develop/ui/compose/tooling) in Android Studio.

Add the following definition to your app's `build.gradle` file:

### Groovy

    android {
        buildFeatures {
            compose true
        }
    }

### Kotlin

    android {
        buildFeatures {
            compose = true
        }
    }

Add the Compose BOM and the subset of Compose library dependencies:

### Groovy

    dependencies {

        def composeBom = platform('androidx.compose:compose-bom:2026.06.00')
        implementation composeBom
        androidTestImplementation composeBom

        // Choose one of the following:
        // Material Design 3
        implementation 'androidx.compose.material3:material3'
        // or skip Material Design and build directly on top of foundational components
        implementation 'androidx.compose.foundation:foundation'
        // or only import the main APIs for the underlying toolkit systems,
        // such as input and measurement/layout
        implementation 'androidx.compose.ui:ui'

        // Android Studio Preview support
        implementation 'androidx.compose.ui:ui-tooling-preview'
        debugImplementation 'androidx.compose.ui:ui-tooling'

        // UI Tests
        androidTestImplementation 'androidx.compose.ui:ui-test-junit4'
        debugImplementation 'androidx.compose.ui:ui-test-manifest'

        // Optional - Add window size utils
        implementation 'androidx.compose.material3.adaptive:adaptive'

        // Optional - Integration with activities
        implementation 'androidx.activity:activity-compose:1.13.0'
        // Optional - Integration with ViewModels
        implementation 'androidx.lifecycle:lifecycle-viewmodel-compose:2.10.0'
        // Optional - Integration with LiveData
        implementation 'androidx.compose.runtime:runtime-livedata'
        // Optional - Integration with RxJava
        implementation 'androidx.compose.runtime:runtime-rxjava2'

    }

### Kotlin

    dependencies {

        val composeBom = platform("androidx.compose:compose-bom:2026.06.00")
        implementation(composeBom)
        androidTestImplementation(composeBom)

        // Choose one of the following:
        // Material Design 3
        implementation("androidx.compose.material3:material3")
        // or skip Material Design and build directly on top of foundational components
        implementation("androidx.compose.foundation:foundation")
        // or only import the main APIs for the underlying toolkit systems,
        // such as input and measurement/layout
        implementation("androidx.compose.ui:ui")

        // Android Studio Preview support
        implementation("androidx.compose.ui:ui-tooling-preview")
        debugImplementation("androidx.compose.ui:ui-tooling")

        // UI Tests
        androidTestImplementation("androidx.compose.ui:ui-test-junit4")
        debugImplementation("androidx.compose.ui:ui-test-manifest")

        // Optional - Add window size utils
        implementation("androidx.compose.material3.adaptive:adaptive")

        // Optional - Integration with activities
        implementation("androidx.activity:activity-compose:1.13.0")
        // Optional - Integration with ViewModels
        implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.10.0")
        // Optional - Integration with LiveData
        implementation("androidx.compose.runtime:runtime-livedata")
        // Optional - Integration with RxJava
        implementation("androidx.compose.runtime:runtime-rxjava2")

    }

> [!NOTE]
> **Note:** Jetpack Compose is shipped using a Bill of Materials (BOM), to keep the versions of all library groups in sync. Read more about it in the [Bill of
> Materials page](https://developer.android.com/develop/ui/compose/bom/bom).

## `compileSdk` and Android Gradle Plugin compatibility

Compose library releases continually adopt the latest `compileSdk` versions to
provide access to the latest Android features. Newer `compileSdk` versions
require newer versions of Android Gradle Plugin, so adopting new Compose
releases also requires projects to adopt new versions of the Android Gradle
Plugin. We recommend keeping your project's `compileSdk` up to date with the
latest released versions. `compileSdk` is unrelated from `targetSdk`.

For example, starting with Compose 1.12.0, projects are required to use
`compileSdk 37` and Android Gradle Plugin (AGP) 9.

To check which version of AGP is supported for different API levels, see the
[Android Gradle plugin API level support](https://developer.android.com/build/releases/about-agp#api-level-support) documentation.