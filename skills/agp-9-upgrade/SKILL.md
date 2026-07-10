---
name: agp-9-upgrade
description: Upgrades, or migrates, an Android project to use Android Gradle Plugin
  (AGP) version 9. Do not use this skill for migrating Kotlin Multiplatform (KMP)
  projects.
license: Complete terms in LICENSE.txt
metadata:
  author: Google LLC
  last-updated: '2026-06-25'
  keywords:
  - Android Gradle Plugin 9
  - AGP 9
  - AGP Upgrade
  - AGP Migration
  - New AGP DSL
  - Migrate to built-in Kotlin
triggers:
  - android
  - jetpack
  - compose
---

## Migration guide

See the [AGP 9 migration guide](references/android/build/releases/agp-9-0-0-release-notes.md) for the major changes, many
breaking, in AGP 9 compared to AGP 8.

## Requirements

If the user requests to update or migrate to AGP 9, first check the AGP version
used in the project. If it is lower than 9, stop and ask the user to run the AGP
Upgrade Assistant in Android Studio to update to the latest stable version of
AGP, and confirm when done. The user may also request that this requirement be
skipped; if this is the case, you should update the version of AGP to the latest
stable version as part of the AGP 9 migration. See the
[AGP 9 migration guide](references/android/build/releases/agp-9-0-0-release-notes.md) for how to do this.

Each version of AGP has its own set of compatibilities with other tools, such as
Gradle, JDK, and Kotlin. The release notes for each of these versions will
include a **Compatibility** table indicating the minimum versions for these
tools.

Do not use this skill for KMP projects, as they are unsupported.

## Steps

If AGP is already at 9 or higher, then do the following:

### Step 1: Update dependencies

If KSP (`com.google.devtools.ksp`) is used in the project, ensure it is on
version 2.3.6 or higher.

If Hilt is used in the project, ensure it is on version 2.59.2 or higher.

### Step 2: Migrate to built-in Kotlin

See [the guide](references/android/build/migrate-to-built-in-kotlin.md) for detailed information.

### Step 3. Migrate to the new AGP DSL

See [the guide](references/android/build/releases/agp-9-0-0-release-notes.md) for detailed information.

See also [gradle-recipes](references/recipes.md) for examples on how to migrate old code to code
that is compatible with AGP 9 and the new DSL.

### Step 4. Migrate kapt to KSP or legacy-kapt

If KSP (`com.google.devtools.ksp`) or kapt (`org.jetbrains.kotlin.kapt`) are
used in the project, see [KSP, kapt, and legacy-kapt](references/ksp-kapt.md) for detailed migration
steps.

### Step 5. BuildConfig

If any Android module contains custom BuildConfig fields, see [BuildConfig](references/buildconfig.md)
for detailed information.

### Step 6. Update gradle.properties

After the migration, check gradle.properties. Remove the following flags:

1. android.builtInKotlin
2. android.newDsl
3. android.uniquePackageNames
4. android.enableAppCompileTimeRClass

Additionally, delete all temporary files you've created.

## Guidelines

- Never write or run python scripts.
- Only search the Gradle dependency cache when inspecting external dependencies, and only as a last resort.
- Never add `android.disallowKotlinSourceSets=false` to `gradle.properties`.
- When verifying changes, don't run the `clean` task. This is a waste of time.

## Verification

After migration, verify the following:

1. Gradle IDE sync succeeds.
2. `./gradlew help` succeeds.
3. `./gradlew build --dry-run` succeeds.

## Troubleshooting

Paparazzi v2.0.0-alpha04 and lower versions have issues with AGP 9. See
[references/paparazzi-gradle-9.md](references/paparazzi-gradle-9.md) for details.

## Contract
- Inputs: Android project context and the skill's target surface (Compose, Play, profiling, security, etc.).
- Outputs: concrete, API-accurate Android guidance and code that matches official Android docs for the skill topic.
- Failure modes: outdated AGP/API assumptions, inventing SDK APIs, or applying mobile guidance to non-Android targets.

## Output Format
1. State the target Android surface and constraints.
2. Provide the minimal correct implementation or migration steps.
3. Call out version requirements, common pitfalls, and verification.

## Anti-Patterns
- Do not invent Jetpack/Play/Compose APIs or dependency coordinates.
- Do not hardcode secrets, signing keys, or production package names from examples into real apps.
- Do not skip version/AGP compatibility checks.
- Do not treat sample emails or demo identities as real credentials.
