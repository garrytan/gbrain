Android Gradle plugin 9.0 introduces built-in Kotlin support and enables it
by default. That means you no longer have to apply the
`org.jetbrains.kotlin.android` (or `kotlin-android`) plugin in your build files
to compile Kotlin source files.
With built-in Kotlin, your build files are simpler and you can avoid
compatibility issues between AGP and the `kotlin-android` plugin.

> [!NOTE]
> **Note:** Built-in Kotlin replaces the `kotlin-android` plugin only. If you are writing a Kotlin Multiplatform (KMP) library module, you still need to apply the `org.jetbrains.kotlin.multiplatform` plugin and the [`com.android.kotlin.multiplatform.library`](https://developer.android.com/kotlin/multiplatform/plugin) plugin. Also, using the `org.jetbrains.kotlin.multiplatform` plugin together with the `com.android.library` or `com.android.application` plugin is no longer allowed when built-in Kotlin is enabled.

## Enable built-in Kotlin

You need AGP 9.0 or higher to have built-in Kotlin support.
AGP 9.0 already enables built-in Kotlin for all your modules where you apply
AGP, so you don't need to do anything to enable it. However, if you previously
[opted out of built-in Kotlin](https://developer.android.com/build/migrate-to-built-in-kotlin#opt-out-of-built-in-kotlin) by setting `android.builtInKotlin=false`
in the `gradle.properties` file, you need to remove that setting or set it to
`true`.

> [!NOTE]
> **Note:** You can also enable built-in Kotlin for [one module at a time](https://developer.android.com/build/migrate-to-built-in-kotlin#module-by-module-migration).

Built-in Kotlin requires some changes to your project, so after you
have built-in Kotlin enabled, follow the next steps to migrate your project.

## Migration steps

After you upgrade your project from an older AGP version to AGP 9.0 or after
you manually [enable built-in Kotlin](https://developer.android.com/build/migrate-to-built-in-kotlin#enable-built-in-kotlin), you might see the following error
message:

    Failed to apply plugin 'org.jetbrains.kotlin.android'.
    > Cannot add extension with name 'kotlin', as there is an extension already registered with that name.

...or

    Failed to apply plugin 'com.jetbrains.kotlin.android'
    > The 'org.jetbrains.kotlin.android' plugin is no longer required for Kotlin support since AGP 9.0.

This error occurs because built-in Kotlin requires some changes to your project.
To resolve this error, follow these steps:

> [!NOTE]
> **Note:** If you're not yet ready to migrate your project, you can also [opt out of built-in Kotlin](https://developer.android.com/build/migrate-to-built-in-kotlin#opt-out-of-built-in-kotlin).

1. [Remove the `kotlin-android` plugin](https://developer.android.com/build/migrate-to-built-in-kotlin#migration-steps-remove-kotlin-android-plugin)
2. [Migrate the `kotlin-kapt` plugin if necessary](https://developer.android.com/build/migrate-to-built-in-kotlin#migration-steps-migrate-kotlin-kapt-plugin)
3. [Migrate the `android.kotlinOptions{}` DSL if necessary](https://developer.android.com/build/migrate-to-built-in-kotlin#migration-steps-migrate-kotlin-options)
4. [Migrate the `kotlin.sourceSets{}` DSL if necessary](https://developer.android.com/build/migrate-to-built-in-kotlin#migration-steps-migrate-kotlin-source-sets)

### 1. Remove the `kotlin-android` plugin

Remove the `org.jetbrains.kotlin.android` (or `kotlin-android`) plugin from
the module-level build files where you apply it.
The exact code to remove depends on
whether you use [version catalogs](https://docs.gradle.org/current/userguide/version_catalogs.html) to declare plugins.

### With version catalogs

### Kotlin

```kotlin
// Module-level build file
plugins {
    alias(libs.plugins.kotlin.android)
}
```

### Groovy

```groovy
// Module-level build file
plugins {
    alias(libs.plugins.kotlin.android)
}
```

### No version catalogs

### Kotlin

```kotlin
// Module-level build file
plugins {
    id("org.jetbrains.kotlin.android")
}
```

### Groovy

```groovy
// Module-level build file
plugins {
    id 'org.jetbrains.kotlin.android'
}
```

Then, remove the plugin from your top-level build file:

### With version catalogs

### Kotlin

```kotlin
// Top-level build file
plugins {
    alias(libs.plugins.kotlin.android) apply false
}
```

### Groovy

```groovy
// Top-level build file
plugins {
    alias(libs.plugins.kotlin.android) apply false
}
```

### No version catalogs

### Kotlin

```kotlin
// Top-level build file
plugins {
    id("org.jetbrains.kotlin.android") version "KOTLIN_VERSION" apply false
}
```

### Groovy

```groovy
// Top-level build file
plugins {
    id 'org.jetbrains.kotlin.android' version 'KOTLIN_VERSION' apply false
}
```

If you use version catalogs, also remove the plugin definition from the
version catalog TOML file (usually `gradle/libs.versions.toml`):

```toml
[plugins]
kotlin-android = { id = "org.jetbrains.kotlin.android", version.ref = "KOTLIN_VERSION" }
```

### 2. Migrate the `kotlin-kapt` plugin if necessary

The `org.jetbrains.kotlin.kapt` (or `kotlin-kapt`) plugin is incompatible with
built-in Kotlin. If you use `kapt`, we recommend that you
[migrate your project to KSP](https://developer.android.com/build/migrate-to-ksp).

If you can't migrate to KSP yet, replace the `kotlin-kapt` plugin with the
`com.android.legacy-kapt` plugin, using the same version as your Android Gradle
plugin.

For example, with version catalogs, update your version catalog TOML
file as follows:

```toml
[plugins]
android-application = { id = "com.android.application", version.ref = "AGP_VERSION" }

# Add the following plugin definition
legacy-kapt = { id = "com.android.legacy-kapt", version.ref = "AGP_VERSION" }

# Remove the following plugin definition
kotlin-kapt = { id = "org.jetbrains.kotlin.kapt", version.ref = "KOTLIN_VERSION" }
```

Then, update your build files:

### Kotlin

```kotlin
// Top-level build file
plugins {
    alias(libs.plugins.legacy.kapt) apply false
    alias(libs.plugins.kotlin.kapt) apply false
}
```

### Groovy

```groovy
// Top-level build file
plugins {
    alias(libs.plugins.legacy.kapt) apply false
    alias(libs.plugins.kotlin.kapt) apply false
}
```

### Kotlin

```kotlin
// Module-level build file
plugins {
    alias(libs.plugins.legacy.kapt)
    alias(libs.plugins.kotlin.kapt)
}
```

### Groovy

```groovy
// Module-level build file
plugins {
    alias(libs.plugins.legacy.kapt)
    alias(libs.plugins.kotlin.kapt)
}
```

> [!NOTE]
> **Note:** If you declare the `kotlin-kapt` plugin in the `plugins{}` block as `kotlin("kapt") version "<KOTLIN_VERSION>"`, then remove that line instead.

### 3. Migrate the `android.kotlinOptions{}` DSL if necessary

If you use the `android.kotlinOptions{}` DSL, you need to
migrate it to the [`kotlin.compilerOptions{}`](https://kotlinlang.org/docs/gradle-compiler-options.html#migrate-from-kotlinoptions-to-compileroptions) DSL.

For example, update this code:

### Kotlin

```kotlin
android {
    kotlinOptions {
        languageVersion = "2.0"
        jvmTarget = "11"
    }
}
```

### Groovy

```groovy
android {
    kotlinOptions {
        languageVersion = "2.0"
        jvmTarget = "11"
    }
}
```

...to the new DSL:

### Kotlin

```kotlin
kotlin {
    compilerOptions {
        languageVersion = org.jetbrains.kotlin.gradle.dsl.KotlinVersion.KOTLIN_2_0
        // Optional: Set jvmTarget
        // jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_11
    }
}
```

### Groovy

```groovy
kotlin {
    compilerOptions {
        languageVersion = org.jetbrains.kotlin.gradle.dsl.KotlinVersion.KOTLIN_2_0
        // Optional: Set jvmTarget
        // jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_11
    }
}
```

> [!NOTE]
> **Note:** With built-in Kotlin, you don't need to set `kotlin.compilerOptions.jvmTarget` because its value defaults to `android.compileOptions.targetCompatibility`.

### 4. Migrate the `kotlin.sourceSets{}` DSL if necessary

When you use the `kotlin-android` plugin, AGP lets you add additional Kotlin
source directories using either the [`android.sourceSets{}`](https://developer.android.com/reference/tools/gradle-api/9.0/com/android/build/api/dsl/AndroidSourceSet) DSL or the
[`kotlin.sourceSets{}`](https://kotlinlang.org/api/kotlin-gradle-plugin/kotlin-gradle-plugin-api/org.jetbrains.kotlin.gradle.plugin/-kotlin-source-set/) DSL.
With the `android.sourceSets{}` DSL, you can add the directories to either the
`AndroidSourceSet.kotlin` set or the `AndroidSourceSet.java` set.

With built-in Kotlin, the only supported option is to add the directories to the
`AndroidSourceSet.kotlin` set using the `android.sourceSets{}` DSL.
If you use unsupported options, migrate them as follows:

### Kotlin

```kotlin
# Adding Kotlin source directories to kotlin.sourceSets is not supported
kotlin.sourceSets.named("main") {
    kotlin.srcDir("additionalSourceDirectory/kotlin")
}

# Adding Kotlin source directories to AndroidSourceSet.java is also not supported
android.sourceSets.named("main") {
    java.directories += "additionalSourceDirectory/kotlin"
}

# Add Kotlin source directories to AndroidSourceSet.kotlin
android.sourceSets.named("main") {
    kotlin.directories += "additionalSourceDirectory/kotlin"
}
```

### Groovy

```groovy
# Adding Kotlin source directories to kotlin.sourceSets is not supported
kotlin.sourceSets.named("main") {
    kotlin.srcDir("additionalSourceDirectory/kotlin")
}

# Adding Kotlin source directories to AndroidSourceSet.java is also not supported
android.sourceSets.named("main") {
    java.directories.add("additionalSourceDirectory/kotlin")
}

# Add Kotlin source directories to AndroidSourceSet.kotlin
android.sourceSets.named("main") {
    kotlin.directories.add("additionalSourceDirectory/kotlin")
}
```

If you want to add a Kotlin source directory to a specific variant or if the
directory is generated by a task, you can use the
[`addStaticSourceDirectory`](https://developer.android.com/reference/tools/gradle-api/9.0/com/android/build/api/variant/SourceDirectories#addStaticSourceDirectory(kotlin.String)) or [`addGeneratedSourceDirectory`](https://developer.android.com/reference/tools/gradle-api/9.0/com/android/build/api/variant/SourceDirectories#addGeneratedSourceDirectory(org.gradle.api.tasks.TaskProvider,kotlin.Function1)) methods
in the [variant API](https://developer.android.com/build/extend-agp#variant-api-artifacts-tasks):

### Kotlin

```kotlin
androidComponents.onVariants { variant ->
    variant.sources.kotlin!!.addStaticSourceDirectory("additionalSourceDirectory/kotlin")
    variant.sources.kotlin!!.addGeneratedSourceDirectory(TASK_PROVIDER, TASK_OUTPUT)
}
```

### Groovy

```groovy
androidComponents.onVariants { variant ->
    variant.sources.kotlin!!.addStaticSourceDirectory("additionalSourceDirectory/kotlin")
    variant.sources.kotlin!!.addGeneratedSourceDirectory(TASK_PROVIDER, TASK_OUTPUT)
}
```

## Report issues

If you encounter issues after completing the previous steps,
review the known issues in [issue #438678642](https://issuetracker.google.com/438678642) and give us
feedback if needed.

## Opt out of built-in Kotlin

If you are unable to migrate your project to use built-in Kotlin, set
`android.builtInKotlin=false` in the `gradle.properties` file to temporarily
disable it.
When you do that, the build shows a warning reminding you to migrate to built-in
Kotlin as you won't be able to disable built-in Kotlin in AGP 10.0.

> [!NOTE]
> **Note:** You also need to set `android.newDsl=false` to opt out of the [new DSL](https://developer.android.com/r/tools/new-dsl) because the `kotlin-android` plugin is not compatible with it.

Once you're ready to migrate your project, [enable built-in Kotlin](https://developer.android.com/build/migrate-to-built-in-kotlin#enable-built-in-kotlin)
and follow the [migration steps](https://developer.android.com/build/migrate-to-built-in-kotlin#migration-steps).

## Module-by-module migration

The `android.builtInKotlin` Gradle property lets you enable or disable built-in
Kotlin for all your modules where you apply AGP.

If migrating all your modules at once is challenging, you can migrate one module
at a time:

1. Set `android.builtInKotlin=false` in the `gradle.properties` file to
   disable built-in Kotlin for all modules.

2. Apply the `com.android.built-in-kotlin` plugin to the module
   you want to enable built-in Kotlin, using the same version as your
   Android Gradle plugin.

3. Follow the previous [migration steps](https://developer.android.com/build/migrate-to-built-in-kotlin#migration-steps) to migrate this module to
   built-in Kotlin.

4. Once you've migrated all your modules, remove the
   `android.builtInKotlin=false` setting in `gradle.properties`
   and the `com.android.built-in-kotlin` plugin in your build files.

## Option to selectively disable built-in Kotlin

Android Gradle plugin 9.0 enables built-in Kotlin for all modules where it is
applied.
We recommend disabling built-in Kotlin selectively for modules that don't have
Kotlin sources in large projects.
This removes both the Kotlin compilation task, which has a small build
performance cost, and the automatic dependency on the Kotlin standard library.

To disable built-in Kotlin for a module,
set `enableKotlin = false` in that module's build file:

### Kotlin

```kotlin
android {
    enableKotlin = false
}
```

### Groovy

```groovy
android {
    enableKotlin = false
}
```