When migrating to built-in Kotlin, it is important to consider usage of `kapt`
and the `org.jetbrains.kotlin.kapt` (also known as the `kotlin("kapt")`) plugin.
The goal is to migrate as many `kapt` usages to `ksp` as possible.

Follow these steps when migrating `kapt`:

## 1. Remove all references to the `org.jetbrains.kotlin.kapt` plugin

The `org.jetbrains.kotlin.kapt` (also known as `kotlin("kapt")`) plugin is
incompatible with built-in Kotlin. Remove it when migrating to built-in Kotlin.

## 2. Check each usage of `kapt`

Check each usage of `kapt` to see if it is compatible with `ksp`. To check if a
dependency is compatible with `ksp`, inspect the dependency's jar. For it to be
compatible with `ksp`, the jar must have a file,
`services/com.google.devtools.ksp.processing.SymbolProcessorProvider`. If it
does not, it is **incompatible** with `ksp`.

For example, the `androidx.room:room-compiler` library is compatible with KSP
since version 2.3.0-beta02. We can verify this by finding the jar file in the
Gradle caches directory, which is typically located at
`~/.gradle/caches/modules-2/files-2.1/` on Linux and Mac. In this specific case,
the `androidx.room:room-compiler` dependency is located at
`~/.gradle/caches/modules-2/files-2.1/androidx.room/room-compiler/`.

More generally, you can find a dependency by looking in
`~/.gradle/caches/modules-2/files-2.1/group-name/artifact-name/`.

## 3. Migrate to KSP where possible

For each usage of `kapt` that is compatible with `ksp`, use `ksp`. The prior
step explains how to check compatibility.

## 4. Apply legacy-kapt

If a Gradle module has `kapt` dependencies that cannot be migrated to `ksp`
because they are incompatible (see step 2), then leave that dependency alone and
apply the `com.android.legacy-kapt` plugin.