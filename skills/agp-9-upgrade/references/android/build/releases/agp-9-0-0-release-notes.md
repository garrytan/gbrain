<br />

Android Gradle plugin 9.0 is a major release that brings API and behavior
changes.

To update to Android Gradle plugin 9.0.1, use the
[Android Gradle plugin Upgrade Assistant](https://developer.android.com/build/agp-upgrade-assistant). The AGP upgrade assistant helps
preserve existing behaviors when upgrading your project whenever appropriate, so
you can upgrade your project to use AGP 9.0 even if you're not ready to
adopt all the new defaults in AGP 9.0.

There are also two agent skills available to make the upgrade process easier.
For a non-KMP app, try the [AGP 9 upgrade skill](https://github.com/android/skills/tree/main/build/agp/agp-9-upgrade) from the
Android skills repository. For a KMP app, try the [AGP 9 upgrade
skill](https://github.com/Kotlin/kotlin-agent-skills/tree/main/skills/kotlin-tooling-agp9-migration) from JetBrains. For more information about using skills
in Android Studio, see [Extend Agent Mode with skills](https://developer.android.com/studio/gemini/skills).

## Compatibility

The maximum API level that Android Gradle plugin 9.0 supports is API level 36.1.
Here is other compatibility info:


|   | Minimum version | Default version | Notes |
|---:|:---:|:---:|:---:|
| Gradle | 9.1.0 | 9.1.0 | To learn more, see [updating Gradle](https://developer.android.com/build/releases/gradle-plugin?buildsystem=ndk-build#updating-gradle). |
| SDK Build Tools | 36.0.0 | 36.0.0 | [Install](https://developer.android.com/studio/intro/update#sdk-manager) or [configure](https://developer.android.com/tools/releases/build-tools) SDK Build Tools. |
| NDK | N/A | 28.2.13676358 | [Install](https://developer.android.com/studio/projects/install-ndk#specific-version) or [configure](https://developer.android.com/studio/projects/install-ndk#apply-specific-version) a different version of the NDK. |
| JDK | 17 | 17 | To learn more, see [setting the JDK version](https://developer.android.com/studio/intro/studio-config#jdk). |

<br />

## The `android` DSL classes now only implement the new public interfaces

Over the last several years, we have introduced
[new interfaces](https://developer.android.com/reference/tools/gradle-api) for our DSL and API in order to
better control which APIs are public. AGP versions
7.x and 8.x still used the old DSL types (for example `BaseExtension`) which
also implemented the new public interfaces, in order to maintain compatibility
as work progressed on the interfaces.

AGP 9.0 uses our new DSL interfaces exclusively,
and the implementations have changed to new types that are fully hidden. This
also removes access to the old, deprecated variant API.

To update to AGP 9.0, you might need to do the following:

- **Ensure your project is compatible with [built-in
  Kotlin](https://developer.android.com/build/releases/agp-9-0-0-release-notes#android-gradle-plugin-built-in-kotlin):** The `org.jetbrains.kotlin.android` plugin is not compatible with the new DSL.
- **Switch KMP projects to the
  [Android Gradle Library Plugin for KMP](https://developer.android.com/kotlin/multiplatform/plugin):**
  Using the `org.jetbrains.kotlin.multiplatform` plugin in the same Gradle
  subproject as the `com.android.library` and `com.android.application` plugins
  is not compatible with the new DSL.

  > [!NOTE]
  > **Note:** The new KMP integration does not support using KMP and the Android Application plugin in the same Gradle subproject. To migrate, extract your Android app to a separate subproject.

- **Update your build files:**
  While the change of interfaces is meant to keep
  the DSL as similar as possible, there might be
  [some small changes](https://developer.android.com/build/releases/agp-9-0-0-release-notes#android-gradle-plugin-changed-dsl).

- **Update your custom build logic to reference the new DSL and API:**
  Replace any references to the internal DSL with the public DSL interfaces.
  In most cases this will be a one-to-one replacement.
  Replace any use of the `applicationVariants` and similar APIs with the new
  [`androidComponents` API](https://developer.android.com/build/extend-agp#variant-api-artifacts-tasks).
  This might be more complex, as the `androidComponents` API
  is designed to be more stable to keep plugins compatible longer. Check our
  [Gradle Recipes](https://github.com/android/gradle-recipes/tree/agp-9.0)
  for examples.

- **Update third-party plugins:**
  Some third-party plugins might still depend on interfaces or APIs that are
  no longer exposed. Migrate to versions of those plugins which are compatible
  with AGP 9.0.

The switch to the new DSL interfaces prevents plugins and Gradle build scripts
using various deprecated APIs, including:

| Deprecated API in the `android` block | Function | Replacement |
|---|---|---|
| `applicationVariants`, `libraryVariants`, `testVariants`, and `unitTestVariants` | Extension points for plugins to add new functionality to AGP. | Replace this with the [`androidComponents.onVariants`](https://developer.android.com/reference/tools/gradle-api/9.0/com/android/build/api/variant/AndroidComponentsExtension#onVariants(com.android.build.api.variant.VariantSelector,kotlin.Function1)) API, for example: ```kotlin androidComponents { onVariants() { variant -> variant.signingConfig .enableV1Signing.set(false) } } ``` There might not be a direct replacement for all previous APIs. [File an issue](https://developer.android.com/studio/report-bugs) if there is a use case that is not covered by the new variant APIs. |
| `variantFilter` | Allows selected variants to be disabled. | Replace this with the [`androidComponents.beforeVariants`](https://developer.android.com/reference/tools/gradle-api/9.0/com/android/build/api/variant/AndroidComponentsExtension#beforeVariants(com.android.build.api.variant.VariantSelector,kotlin.Function1))) API, for example: ```kotlin androidComponents { beforeVariants( selector() .withBuildType("debug") .withFlavor("color", "blue") ) { variantBuilder -> variantBuilder.enable = false } } ``` |
| `deviceProvider` and `testServer` | Registration of custom test environments for running tests against Android devices and emulators. | Switch to [Gradle-managed devices](https://developer.android.com/studio/test/gradle-managed-devices). |
| `sdkDirectory`, `ndkDirectory`, `bootClasspath`, `adbExecutable`, and `adbExe` | Using various components of the Android SDK for custom tasks. | Switch to [`androidComponents.sdkComponents`](https://developer.android.com/reference/tools/gradle-api/9.0/com/android/build/api/dsl/SdkComponents). |
| `registerArtifactType`, `registerBuildTypeSourceProvider`, `registerProductFlavorSourceProvider`, `registerJavaArtifact`, `registerMultiFlavorSourceProvider`, and `wrapJavaSourceSet` | Obsolete functionality mostly related to the handling of generated sources in Android Studio, which stopped working in AGP 7.2.0. | There is no direct replacement for these APIs. |
| `dexOptions` | Obsolete settings related to the `dx` tool, which has been replaced by [`d8`](https://developer.android.com/tools/d8). None of the settings have had any effect since Android Gradle plugin 7.0. | There is no direct replacement. |
| `generatePureSplits` | Generate configuration splits for instant apps. | The ability to ship configuration splits is now built in to Android app bundles. |
| `aidlPackagedList` | AIDL files to package in the AAR to expose it as API for libraries and apps that depend on this library. | This is still exposed on [`LibraryExtension`](https://developer.android.com/reference/tools/gradle-api/9.0/com/android/build/api/dsl/LibraryExtension) but not on the other extension types. |

If you update to AGP 9.0 and see the following error message, it means that
your project is still referencing some of the old types:

    java.lang.ClassCastException: class com.android.build.gradle.internal.dsl.ApplicationExtensionImpl$AgpDecorated_Decorated
    cannot be cast to class com.android.build.gradle.BaseExtension

If you are blocked by incompatible third-party plugins, you can opt out and
get back the old implementations for the DSL, as well as the old variant API.
While doing this, the new interfaces are also available, and you can still
update your own build logic to the new API. To opt out, include this line in
your `gradle.properties` file:

    android.newDsl=false

The previous classes are marked as deprecated in AGP 9.0. This means projects
that opt out of the `newDsl` flag will see deprecation warnings, including on
the `android` block itself.

> [!CAUTION]
> **Caution:** The ability to opt-out will be removed in AGP 10.0 (mid-2026).

You can also start upgrading to the new APIs before upgrading to AGP 9.0. The
new interfaces have been present for many AGP versions and so you can have a mix
of new and old. The [AGP API reference docs](https://developer.android.com/reference/tools/gradle-api) show the API
surface for each AGP version, and when each class, method and field was
added.

We're reaching out to the authors of commonly used plugins to help them adapt
and release plugins that are fully compatible with the new modes, and will
continue to enhance the AGP Upgrade Assistant in Android Studio to guide you
through the migration.

If you find that the new DSL or Variant API are missing capabilities or
features, please file an [issue](https://issuetracker.google.com/issues/new?component=192708&template=840533) as soon as possible.

## Built-in Kotlin

Android Gradle plugin 9.0 introduces built-in Kotlin support and enables it
by default. That means you no longer have to apply the
`org.jetbrains.kotlin.android` (or `kotlin-android`) plugin in your build files
to compile Kotlin source files.
This simplifies the Kotlin integration with AGP, avoids the use of
deprecated APIs, and improves performance in some cases.

Therefore, when you upgrade your project to AGP 9.0, you need to also
[migrate to built-in Kotlin](https://developer.android.com/build/migrate-to-built-in-kotlin) or [opt out](https://developer.android.com/build/migrate-to-built-in-kotlin#opt-out-of-built-in-kotlin).

You can also [selectively disable built-in Kotlin support](https://developer.android.com/build/migrate-to-built-in-kotlin#selectively-disable) for Gradle
subprojects that don't have Kotlin sources.

## Runtime dependency on Kotlin Gradle plugin

To provide [built-in Kotlin](https://developer.android.com/build/migrate-to-built-in-kotlin) support, Android Gradle plugin 9.0 now has a
runtime dependency on Kotlin Gradle plugin (KGP) 2.2.10.
That means you no longer have to declare a KGP version, and if you use a KGP
version lower than 2.2.10, Gradle will automatically upgrade your KGP version to
2.2.10.
Likewise, if you use a KSP version lower than 2.2.10-2.0.2, AGP will upgrade it
to 2.2.10-2.0.2 to match the KGP version.

### Upgrade to a higher KGP version

To use a higher version of KGP or KSP, add the following to your top-level build
file:

    buildscript {
        dependencies {
            // For KGP
            classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:KGP_VERSION")

            // For KSP
            classpath("com.google.devtools.ksp:symbol-processing-gradle-plugin:KSP_VERSION")
        }
    }

### Downgrade to a lower KGP version

You can only downgrade the KGP version if you've
[opted out of built-in Kotlin](https://developer.android.com/build/migrate-to-built-in-kotlin#opt-out-of-built-in-kotlin).
This is because AGP 9.0 enables built-in Kotlin by default, and built-in Kotlin
requires KGP 2.2.10 or higher.

To use a lower version of KGP or KSP, declare that version in your top-level
build file using a [strict version](https://docs.gradle.org/current/userguide/dependency_versions.html#sec:strict-version) declaration:

    buildscript {
        dependencies {
            // For KGP
            classpath("org.jetbrains.kotlin:kotlin-gradle-plugin") {
                version { strictly("KGP_VERSION") }
            }

            // For KSP
            classpath("com.google.devtools.ksp:symbol-processing-gradle-plugin") {
                version { strictly("KSP_VERSION") }
            }
        }
    }

Note that the minimum KGP version you can downgrade to is 2.0.0.

> [!CAUTION]
> **Caution:** When you downgrade the KGP version, your project might not be compatible with future minor releases of AGP 9, and it might not work with test fixtures.

## IDE support for test fixtures

AGP 9.0 brings full Android Studio IDE support for
[test fixtures](https://developer.android.com/reference/tools/gradle-api/9.0/com/android/build/api/dsl/TestFixtures).

## Fused Library Plugin

The Fused Library Plugin (Preview) lets you publish multiple
libraries as a single Android Library AAR. This can make it easier for your
users to depend on your published artifacts.

For information about getting started, see
[Publish multiple Android libraries as one with Fused Library](https://developer.android.com/build/publish-library/fused-library).

## Behavior changes

Android Gradle plugin 9.0 has the following new behaviors:

| Behavior | Recommendation |
|---|---|
| Android Gradle plugin 9.0 uses NDK version `r28c` by default. | Consider specifying the NDK version you want to use explicitly. |
| Android Gradle plugin 9.0 by default requires consumers of a library to use the same or higher compile SDK version. | Use the same or higher compile SDK when consuming a library. If this is not possible, or you want to give consumers of a library you publish more time to switch, set [`AarMetadata.minCompileSdk`](https://developer.android.com/reference/tools/gradle-api/9.0/com/android/build/api/dsl/AarMetadata#minCompileSdk()) explicitly. |

AGP 9.0 includes updates to the following Gradle properties' defaults.
This gives you the choice to preserve the AGP 8.13 behavior when upgrading:

| Property | Function | Change from AGP 8.13 to AGP 9.0 | Recommendation |
|---|---|---|---|
| `android.newDsl` | Use the new DSL interfaces, without exposing the legacy implementations of the `android` block. This also means the legacy variant API, such as `android.applicationVariants` is no longer accessible. | `false` → `true` | You can opt out by setting `android.newDsl=false`. Once all plugins and build logic your project uses are compatible, remove the opt out. |
| `android.builtInKotlin` | Enables [built-in Kotlin](https://developer.android.com/build/releases/agp-9-0-0-release-notes#android-gradle-plugin-built-in-kotlin) | `false` → `true` | [Migrate to built-in Kotlin](https://developer.android.com/build/migrate-to-built-in-kotlin) if you can or [opt out](https://developer.android.com/build/migrate-to-built-in-kotlin#opt-out-of-built-in-kotlin). |
| `android.uniquePackageNames` | Enforces that each library has a distinct package name. | `false` → `true` | Specify unique package names for all libraries within your project. If that is not possible, you can disable this flag while you migrate. |
| `android.useAndroidx` | Use [`androidx`](https://developer.android.com/jetpack/androidx) dependencies by default. | `false` → `true` | Adopt [`androidx`](https://developer.android.com/jetpack/androidx/migrate) dependencies. |
| `android.default.androidx.test.runner` | Run on-device tests with the [`androidx.test.runner.AndroidJUnitRunner`](https://developer.android.com/training/testing/instrumented-tests/androidx-test-libraries/runner) class by default, replacing the default of the deprecated [`InstrumentationTestRunner`](https://developer.android.com/reference/android/test/InstrumentationTestRunner) for ``` android { defaultConfig { testInstrumentationRunner = "..." } } ``` | `false` → `true` | Adopt [`AndroidJUnitRunner`](https://developer.android.com/training/testing/instrumented-tests/androidx-test-libraries/runner), or specify your custom `testInstrumentationRunner` explicitly. |
| `android.dependency.useConstraints` | Controls the use of dependency constraints between configurations. The default in AGP 9.0 is `false` which only uses constraints in application device tests (AndroidTest). Setting this to `true` will revert back to the 8.13 behavior. | `true` → `false` | Don't use dependency constraints everywhere unless you need them. Accepting the new default of this flag also enables optimizations in the project import process which should reduce the import time for builds with many Android library subprojects. |
| `android.enableAppCompileTimeRClass` | Compile code in applications against a non-final R class, bringing application compilation in line with library compilation. This improves incrementality and paves the way for future performance optimizations to the resource processing flow. | `false` → `true` | Many projects can just adopt the new behavior with no source changes. If the R class fields are used anywhere that requires a constant, such as switch cases, refactor to use chained if statements. |
| `android.sdk.defaultTargetSdkToCompileSdkIfUnset` | Uses the compile SDK version as the default value for the target SDK version in apps and tests. Before this change, the target SDK version would default to the min SDK version. | `false` → `true` | Specify the target SDK version explicitly for apps and tests. |
| `android.onlyEnableUnitTestForTheTestedBuildType` | Only creates unit test components for the tested build type. In the default project this results in a single unit test for debug, where the previous behavor was to have unit tests run for debug or release. | `false` → `true` | If your project doesn't require tests to run for both debug and release, no change is required. |
| `android.proguard.failOnMissingFiles` | Fails the build with an error if any of the keep files specified in the AGP DSL don't exist on disk. Before this change typos in filenames would result in files being silently ignored. | `false` → `true` | Remove any invalid proguard files declarations |
| `android.r8.optimizedResourceShrinking` | Allows R8 to keep fewer Android resources by considering classes and Android resources together. | `false` → `true` | If your project's keep rules are already complete, no change is required. |
| `android.r8.strictFullModeForKeepRules` | Allows R8 to keep less by not implicitly keeping the default constructor when a class is kept. That is, `-keep class A` no longer implies `-keep class A { <init>(); }` | `false` → `true` | If your project's keep rules are already complete, no change is required. <br /> Replace `-keep class A` with `-keep class A { <init>(); }` in your project's keep rules for any cases where you need the default constructor to be kept. |
| `android.defaults.buildfeatures.resvalues` | Enables [`resValues`](https://developer.android.com/reference/tools/gradle-api/9.0/com/android/build/api/variant/HasAndroidResources#resValues()) in all subprojects | `true` → `false` | Enable `resValues` in only the subprojects that need it by setting the following in those projects' Gradle build files: ``` android { buildFeatures { resValues = true } } ``` |
| `android.defaults.buildfeatures.shaders` | Enables [shader compilation](https://developer.android.com/ndk/guides/graphics/shader-compilers) in all subprojects | `true` → `false` | Enable shader compilation in only the subprojects that contain shaders to be compiled by setting the following in those projects' Gradle build files: ``` android { buildFeatures { shaders = true } } ``` |
| `android.r8.proguardAndroidTxt.disallowed` | In AGP 9.0, `getDefaultProguardFile()` will only support `proguard-android-optimize.txt` rather than `proguard-android.txt`. This is to prevent accidental usage of the `­dontoptimize` flag, which is included in `proguard-android.txt`. | `false` → `true` | You can explicitly specify `­dontoptimize` in a custom proguardFile if you want to avoid optimization, alongside using `proguard-android-optimize.txt`. Make sure to remove the `­dontoptimize` flag from this file if possible, as it reduces R8 optimization benefits. If not, opt out by setting `android.r8.globalOptionsInConsumerRules.disallowed=false`. |
| `android.r8.globalOptionsInConsumerRules.disallowed` | From AGP 9.0, Android library and feature module publishing will fail if consumer keep files contain problematic Proguard configurations. Consumer keep files that include global options like `­dontoptimize` or `­dontobfuscate` should only be used in application modules, and can reduce optimization benefits for library users. Android App module compilation will silently ignore any such global options if embedded in a pre-compiled dependency (JAR or AAR). You can see when this occurs by checking configuration.txt (typically in a path like `<app_module>/build/outputs/mapping/<build_variant>/configuration.txt`) for comments like: `# REMOVED CONSUMER RULE: ­dontoptimize` | `false` → `true` | Published libraries should remove any incompatible rules. Internal libraries should move any incompatible but required rules to a proguardFile in an app module instead. Opt out by setting `android.r8.globalOptionsInConsumerRules.disallowed=false`. Once all your consumer keep files are compatible, remove the opt out. |
| `android.sourceset.disallowProvider` | Disallow passing providers for generated sources using the [`AndroidSourceSet`](https://developer.android.com/reference/tools/gradle-api/9.0/com/android/build/api/dsl/AndroidSourceSet) DSL. | `false` → `true` | Use the [`Sources`](https://developer.android.com/reference/tools/gradle-api/9.0/com/android/build/api/variant/Sources) API on `androidComponents` to register generated sources. |
| `android.custom.shader.path.required` | Requires the shader compiler path to be explicitly set in `local.properties` if shader compilation is enabled. | `false` → `true` | Add `glslc.dir=/path/to/shader-tools` to your project's `local.properties`. |

## Removed features

Android Gradle plugin 9.0 removes the following functionality:

- **Embedded Wear OS app support**  
  AGP 9.0 removes support for embedding Wear OS apps, which is no longer supported in Play. This includes removing the `wearApp` configurations and the [`AndroidSourceSet.wearAppConfigurationName`](https://developer.android.com/reference/tools/gradle-api/8.13/com/android/build/api/dsl/AndroidSourceSet#wearAppConfigurationName()) DSL. See [Distribute to Wear OS](https://developer.android.com/distribute/best-practices/launch/distribute-wear) for how to publish your app to Wear OS.
- **`androidDependencies` and `sourceSets` report task**
- **Density split APK support**   
  AGP 9.0 removes support for creating split APKs based on screen density. The functionality and the related APIs have been removed. To split APKs based on screen density using AGP 9.0 or higher, use [app bundles](https://developer.android.com/guide/app-bundle).

## Changed DSL

Android Gradle plugin 9.0 has the following breaking DSL changes:

- The parameterization of [`CommonExtension`](https://developer.android.com/reference/tools/gradle-api/9.0/com/android/build/api/dsl/CommonExtension) has been removed.

  In itself, this is only a source-level breaking change to help
  avoid future source-level breaking changes, but it also means that
  the block methods need to move from [`CommonExtension`](https://developer.android.com/reference/tools/gradle-api/9.0/com/android/build/api/dsl/CommonExtension) to
  [`ApplicationExtension`](https://developer.android.com/reference/tools/gradle-api/9.0/com/android/build/api/dsl/ApplicationExtension), [`LibraryExtension`](https://developer.android.com/reference/tools/gradle-api/9.0/com/android/build/api/dsl/LibraryExtension),
  [`DynamicFeatureExtension`](https://developer.android.com/reference/tools/gradle-api/9.0/com/android/build/api/dsl/DynamicFeatureExtension) and [`TestExtension`](https://developer.android.com/reference/tools/gradle-api/9.0/com/android/build/api/dsl/TestExtension).

  When upgrading your project to AGP 9.0, refactor Gradle plugin code
  which uses those parameters or the block methods. For example the following
  plugin is updated to remove the type parameter and not rely on the
  removed block methods:

  **AGP 8.13**

      val commonExtension: CommonExtension<*, *, *, *, *, *> =
              extensions.getByType(CommonExtension::class)
      commonExtension.apply {
          defaultConfig {
              minSdk {
                  version = release(28)
              }
          }
      }

  **AGP 9.0**

      val commonExtension: CommonExtension =
              extensions.getByType(CommonExtension::class)
      commonExtension.apply {
          defaultConfig.apply {
              minSdk {
                  version = release(28)
              }
          }
      }

  For plugins which target a range of AGP versions, using the getter directly
  is binary compatible with AGP versions lower than 9.0.

## Removed DSL

Android Gradle plugin 9.0 removes:

- [`AndroidSourceSet.jni`](https://developer.android.com/reference/tools/gradle-api/8.13/com/android/build/api/dsl/AndroidSourceSet#jni(kotlin.Function1)), because it was not functional.

- [`AndroidSourceSet.wearAppConfigurationName`](https://developer.android.com/reference/tools/gradle-api/8.13/com/android/build/api/dsl/AndroidSourceSet#wearAppConfigurationName()), as it relates to the
  removed embedded Wear OS app support.

- [`BuildType.isRenderscriptDebuggable`](https://developer.android.com/reference/tools/gradle-api/8.13/com/android/build/api/dsl/BuildType#isRenderscriptDebuggable()), because it was not functional.

- [`DependencyVariantSelection`](https://developer.android.com/reference/tools/gradle-api/8.13/com/android/build/api/dsl/DependencyVariantSelection). It is replaced By
  [`DependencySelection`](https://developer.android.com/reference/tools/gradle-api/9.0/com/android/build/api/dsl/DependencySelection), which is exposed as
  [`kotlin.android.localDependencySelection`](https://developer.android.com/reference/tools/gradle-api/9.0/com/android/build/api/dsl/KotlinMultiplatformAndroidLibraryExtension#localDependencySelection(kotlin.Function1))

- [`Installation.installOptions(String)`](https://developer.android.com/reference/tools/gradle-api/8.13/com/android/build/api/dsl/Installation#installOptions(kotlin.String)). It is replaced by the
  mutable property of [`Installation.installOptions`](https://developer.android.com/reference/tools/gradle-api/9.0/com/android/build/api/dsl/Installation#installOptions()).

- The experimental, but never stabilized [`PostProcessing`](https://developer.android.com/reference/tools/gradle-api/8.13/com/android/build/api/dsl/PostProcessing) block.

- [`ProductFlavor.setDimension`](https://developer.android.com/reference/tools/gradle-api/8.13/com/android/build/api/dsl/ProductFlavor#setDimension(kotlin.String)), which is replaced by the
  [`dimension`](https://developer.android.com/reference/tools/gradle-api/9.0/com/android/build/api/dsl/ProductFlavor#dimension()) property

- `LanguageSplitOptions`, which was only useful for
  [Google Play Instant](https://developer.android.com/topic/google-play-instant), which is deprecated.

- [`DensitySplit`](https://developer.android.com/reference/tools/gradle-api/8.13/com/android/build/api/dsl/DensitySplit), because the feature is no longer supported.
  Replacement is to use [App Bundles](https://developer.android.com/guide/app-bundle).

## Removed APIs

Android Gradle plugin 9.0 removes:

- [`AndroidComponentsExtension.finalizeDSl`](https://developer.android.com/reference/tools/gradle-api/8.13/com/android/build/api/variant/AndroidComponentsExtension#finalizeDSl(org.gradle.api.Action)). It is replaced by
  [`finalizeDsl`](https://developer.android.com/reference/tools/gradle-api/9.0/com/android/build/api/variant/DslLifecycle#finalizeDsl(kotlin.Function1))

- [`Component.transformClassesWith`](https://developer.android.com/reference/tools/gradle-api/8.13/com/android/build/api/variant/Component#transformClassesWith(java.lang.Class,com.android.build.api.instrumentation.InstrumentationScope,kotlin.Function1)). It is replaced by
  [`Instrumentation.transformClassesWith`](https://developer.android.com/reference/tools/gradle-api/9.0/com/android/build/api/variant/Instrumentation#transformClassesWith(java.lang.Class,com.android.build.api.instrumentation.InstrumentationScope,kotlin.Function1))

- [`Component.setAsmFramesComputationMode`](https://developer.android.com/reference/tools/gradle-api/8.13/com/android/build/api/variant/Component#setAsmFramesComputationMode(com.android.build.api.instrumentation.FramesComputationMode)). It is replaced by
  [`Instrumentation.setAsmFramesComputationMode`](https://developer.android.com/reference/tools/gradle-api/8.13/com/android/build/api/variant/Instrumentation#setAsmFramesComputationMode(com.android.build.api.instrumentation.FramesComputationMode))

- [`ComponentBuilder.enabled`](https://developer.android.com/reference/tools/gradle-api/8.13/com/android/build/api/variant/ComponentBuilder#enabled()). It is replaced by
  [`ComponentBuilder.enable`](https://developer.android.com/reference/tools/gradle-api/9.0/com/android/build/api/variant/ComponentBuilder#enable()).

- [`DependenciesInfoBuilder.includedInApk`](https://developer.android.com/reference/tools/gradle-api/8.13/com/android/build/api/variant/DependenciesInfoBuilder#includedInApk()). Is is replaced by
  [`includeInApk`](https://developer.android.com/reference/tools/gradle-api/9.0/com/android/build/api/variant/DependenciesInfoBuilder#includeInApk())

- [`DependenciesInfoBuilder.includedInBundle`](https://developer.android.com/reference/tools/gradle-api/8.13/com/android/build/api/variant/DependenciesInfoBuilder#includedInBundle()). Is is replaced by
  [`includeInBundle`](https://developer.android.com/reference/tools/gradle-api/9.0/com/android/build/api/variant/DependenciesInfoBuilder#includeInBundle())

- [`GeneratesApk.targetSdkVersion`](https://developer.android.com/reference/tools/gradle-api/8.13/com/android/build/api/variant/GeneratesApk#targetSdkVersion()). Is is replaced by [`targetSdk`](https://developer.android.com/reference/tools/gradle-api/9.0/com/android/build/api/variant/GeneratesApk#targetSdk())

- [`Variant.minSdkVersion`](https://developer.android.com/reference/tools/gradle-api/8.13/com/android/build/api/variant/Variant#minSdkVersion()). Is is replaced by [`minSdk`](https://developer.android.com/reference/tools/gradle-api/9.0/com/android/build/api/variant/Variant#minSdk())

- [`Variant.maxSdkVersion`](https://developer.android.com/reference/tools/gradle-api/8.13/com/android/build/api/variant/Variant#maxSdkVersion()). Is is replaced by [`maxSdk`](https://developer.android.com/reference/tools/gradle-api/9.0/com/android/build/api/variant/Variant#maxSdk())

- [`Variant.targetSdkVersion`](https://developer.android.com/reference/tools/gradle-api/8.13/com/android/build/api/variant/Variant#targetSdkVersion()). Is is replaced by [`targetSdk`](https://developer.android.com/reference/tools/gradle-api/9.0/com/android/build/api/variant/Variant#targetSdk())

- [`Variant.unitTest`](https://developer.android.com/reference/tools/gradle-api/8.13/com/android/build/api/variant/Variant#unitTest()), as it was not applicable to the
  [`com.android.test`](https://developer.android.com/reference/tools/gradle-api/9.0/com/android/build/gradle/TestPlugin) plugin.
  `unitTest` is available on [`VariantBuilder`](https://developer.android.com/reference/tools/gradle-api/9.0/com/android/build/api/variant/VariantBuilder) subtypes extending
  [`HasUnitTest`](https://developer.android.com/reference/tools/gradle-api/9.0/com/android/build/api/variant/HasUnitTest).

- [`VariantBuilder.targetSdk`](https://developer.android.com/reference/tools/gradle-api/8.13/com/android/build/api/variant/VariantBuilder#targetSdk()) and [`targetSdkPreview`](https://developer.android.com/reference/tools/gradle-api/8.13/com/android/build/api/variant/VariantBuilder#targetSdkPreview()),
  as they were not meaningful in libraries. Use
  [`GeneratesApkBuilder.targetSdk`](https://developer.android.com/reference/tools/gradle-api/9.0/com/android/build/api/variant/GeneratesApkBuilder#targetSdk()) or
  [`GeneratesApkBuilder.targetSdkPreview`](https://developer.android.com/reference/tools/gradle-api/9.0/com/android/build/api/variant/GeneratesApkBuilder#targetSdkPreview())
  instead.

- [`VariantBuilder.enableUnitTest`](https://developer.android.com/reference/tools/gradle-api/8.13/com/android/build/api/variant/VariantBuilder#enableUnitTest()), as it was not applicable to the
  [`com.android.test`](https://developer.android.com/reference/tools/gradle-api/9.0/com/android/build/gradle/TestPlugin) plugin.
  `enableUnitTest` is available on [`VariantBuilder`](https://developer.android.com/reference/tools/gradle-api/9.0/com/android/build/api/variant/VariantBuilder) subtypes extending
  [`HasUnitTestBuilder`](https://developer.android.com/reference/tools/gradle-api/9.0/com/android/build/api/variant/HasUnitTestBuilder).

- [`VariantBuilder.unitTestEnabled`](https://developer.android.com/reference/tools/gradle-api/8.13/com/android/build/api/variant/VariantBuilder#unitTestEnabled()) is removed in favor of the more
  consistently
  named [`enableUnitTest`](https://developer.android.com/reference/tools/gradle-api/9.0/com/android/build/api/variant/HasUnitTestBuilder#enableUnitTest()) on the [`VariantBuilder`](https://developer.android.com/reference/tools/gradle-api/9.0/com/android/build/api/variant/VariantBuilder) subtypes
  extending [`HasUnitTestBuilder`](https://developer.android.com/reference/tools/gradle-api/9.0/com/android/build/api/variant/HasUnitTestBuilder).

- [`VariantOutput.enable`](https://developer.android.com/reference/tools/gradle-api/8.13/com/android/build/api/variant/VariantOutput#enable()). Is is replaced by [`enabled`](https://developer.android.com/reference/tools/gradle-api/9.0/com/android/build/api/variant/VariantOutput#enabled())

- The deprecated and disabled `FeaturePlugin` and `FeatureExtension`.

- The deprecated and disabled `BaseExtension.registerTransform` APIs, which
  only remained to allow compiling against the latest AGP version while
  targeting running on AGP 4.2 or lower.

## Removed Gradle properties

The following Gradle properties were initially added as ways to globally
disable features that were enabled by default.

These features have been disabled by default since AGP 8.0 or lower. Enable
these features in only the sub-projects that use them for a more efficient
build.

| Property | Function | Replacement |
|---|---|---|
| `android.defaults.buildfeatures.aidl` | Enables [AIDL compilation](https://source.android.com/docs/core/architecture/aidl) in all subprojects | Enable AIDL compilation in only the subprojects where there are AIDL sources by setting the following property in those projects' Gradle build files: ``` android { buildFeatures { aidl = true } } ``` in the Gradle build file of each subproject containing AIDL sources |
| `android.defaults.buildfeatures.renderscript` | Enables [RenderScript compilation](https://source.android.com/docs/core/architecture/vndk/renderscript) in all subprojects | Enable renderscript compilation in only the subprojects where there are renderscript sources by setting the following property in those projects' Gradle build files: ``` android { buildFeatures { renderScript = true } } ``` |

## Enforced Gradle properties

AGP 9.0 throws an error if you set the following Gradle properties.

The [Android Gradle plugin Upgrade Assistant](https://developer.android.com/build/agp-upgrade-assistant) won't upgrade projects to
AGP 9.0 that use these properties.

| Property | Function |
|---|---|
| `android.r8.integratedResourceShrinking` | Resource shrinking is now always run as part of R8, the previous implementation has been removed. |
| `android.enableNewResourceShrinker.preciseShrinking` | Resource shrinking now always uses precise resource shrinking, which enables more to be removed. |

## R8 changes

The following R8 changes are included in AGP 9.0.0.

### New configuration option `-processkotlinnullchecks`

We've added the new R8 option `-processkotlinnullchecks` to configure R8 for
processing Kotlin null checks. The option takes a mandatory argument that must
be one of the following three values: `keep`, `remove_message` and `remove`.
The option processes the following null checks added by the Kotlin
compiler:

    class kotlin.jvm.internal.Intrinsics {
      void checkNotNull(java.lang.Object);
      void checkNotNull(java.lang.Object, java.lang.String);
      void checkExpressionValueIsNotNull(
          java.lang.Object, java.lang.String);
      void checkNotNullExpressionValue(
          java.lang.Object, java.lang.String);
      void checkReturnedValueIsNotNull(
          java.lang.Object, java.lang.String);
      void checkReturnedValueIsNotNull(
          java.lang.Object, java.lang.String, java.lang.String);
      void checkFieldIsNotNull(java.lang.Object, java.lang.String);
      void checkFieldIsNotNull(
          java.lang.Object, java.lang.String, java.lang.String);
      void checkParameterIsNotNull(java.lang.Object, java.lang.String);
      void checkNotNullParameter(java.lang.Object, java.lang.String);
    }

The option values, ordered from the weakest to the strongest, have the
following effect:

- `keep` doesn't change the checks.
- `remove_message` rewrites each check method call to a call to `getClass()` on the first argument of the call (effectively keeping the null check, but without any message).
- `remove` completely removes the checks.

By default R8
uses `remove_message`. Any specification of `-processkotlinnullchecks`
will override that. If specified multiple times the strongest value is
used.

### Stop propagating keep info to companion methods

When keep rules match interface methods that are subject to desugaring,
R8 previously internally transferred the *disallow optimization* and *disallow
shrinking* bits to the synthesized companion methods.

Starting with AGP 9.0, keep rules no longer apply to
companion methods. This is consistent with the fact that keep rules are
not applicable to other compiler synthesized fields/methods/classes.

By transferring the *disallow optimization* and *disallow shrinking* bits to
the companion methods, the following use case was previously supported:

1. Compile a library with `default`/`static`/`private` interface methods to DEX with `minSdk` \< 24 and rules that keep the interface methods.
2. Compile an app with the library on classpath and `-applymapping`.
3. Merge the app and the library.

Note that this only works with `-applymapping` since the `disallow
obfuscation` bit is not transferred to the companion methods---that is, the
companion classes generated from step 1 would have obfuscated method
names.

Going forward this use case is no longer supported for `minSdk` \<
24. The workaround is to do the following:

1. Desugar the library with `default`/`static`/`private` interface methods to class files with `minSdk` \< 24.
2. Compile the desugared artifact using R8 and rules that keep the interface methods on the companion classes.
3. Compile the app with the library on classpath.
4. Merge the app and the desugared artifact.

Another side effect of this is that it is no longer possible to keep the
inner class and enclosing method attributes for anonymous and local classes
inside interface companion methods.

### Change the default emitted source file to `r8-map-id-<MAP_ID>`

This change is in AGP starting from 8.12.0.

The default emitted source file attribute for a class changes from
`SourceFile` to `r8-map-id-<MAP_ID>` when retracing is required (that is,
when either obfuscation or optimization is enabled).

Given an obfuscated stack trace, the new source file attribute makes it
possible to extract the ID of the mapping file that is required for
retracing, which can be used to support
[automated retracing of stack traces in Logcat](https://developer.android.com/studio/preview/features#logcat-retrace).

If a custom source file attribute is used (`-renamesourcefileattribute`)
this custom source file attribute continues to take precedence.

In ProGuard compatibility mode (when `gradle.properties` contains
`android.enableR8.fullMode=false`), emitting a source file attribute of
`r8-map-id-<MAP_ID>` only takes effect if the `SourceFile`
attribute is *not* kept. Apps that use ProGuard compatibility mode and want
to include the mapping file ID in their stack traces should remove
`-keepattributes SourceFile` (or migrate to R8 full mode).

The map ID used in `r8-map-id-<MAP_ID>` is the full map hash, and not a 7
character prefix of the map hash which was previously used.

### Enable use of minimized synthetic names in L8 desugaring

The name of synthetic classes generated by D8 normally contains the substring
`$$ExternalSynthetic` that tells you that this is a synthetic generated by D8.
Moreover, the name of the synthetic also encodes the synthetic kind (for
example, `Backport`, `Lambda`). This has a negative impact on the resulting DEX
size, since the class names take up more space in the string pool.

AGP 9.0 configures L8 (core library desugaring) so that the DEX
file containing all `j$` classes uses a new shortened class name format
for synthetic classes. The new class name uses a numeric ID (for example, `$1`).

### Remove support for `-addconfigurationdebugging`

AGP 9.0 removes support for `-addconfigurationdebugging`. The compiler now
reports a warning if the flag is used.

### Remove support for generating L8 rules from D8/R8

This change is only relevant for developers using the D8/R8 command line or
APIs directly.

R8 9.0 removes support for generating keep rules for L8 from D8 and R8.
You should instead use `TraceReferences` for this purpose.

More specifically, the methods
`D8Command.builder.setDesugaredLibraryKeepRuleConsumer` and
`R8Command.Builder.setDesugaredLibraryKeepRuleConsumer` are removed, and the
support for `--desugared-lib-pg-conf-output` is removed from the command line
options of D8 and R8.

## Fixed issues

### Android Gradle plugin 9.0.0

| Fixed Issues ||
|---|---|
| **Android Gradle Plugin** | |---| | [Issue #171293712](https://issuetracker.google.com/issues/171293712) Feature Request: Inject ideal AGP version as a property | | [Issue #443976533](https://issuetracker.google.com/issues/443976533) Stabilize SingleArtifact.VERSION_CONTROL_INFO_FILE | | [Issue #223643506](https://issuetracker.google.com/issues/223643506) androidTest connectedCheck logcat output is broken | | [Issue #386221070](https://issuetracker.google.com/issues/386221070) Built-in Kotlin support in AGP should not synchronize with the Kotlin sourcesets | | [Issue #460094802](https://issuetracker.google.com/issues/460094802) missingDimensionStrategy prefers a flavor maching its own name even from an unrelated dimension | | [Issue #386221070](https://issuetracker.google.com/issues/386221070) Built-in Kotlin support in AGP should not synchronize with the Kotlin sourcesets | | [Issue #471410336](https://issuetracker.google.com/issues/471410336) AGP 9.0.0-rc01 doesn't resolve Kotlin libraries via kotlin() function | | [Issue #450851465](https://issuetracker.google.com/issues/450851465) Built-in-kotlin does not publish kotlin-stdlib dependency constraint in maven pom | | [Issue #420592288](https://issuetracker.google.com/issues/420592288) Add a test case for divergence between compileSdk and targetSdk | | [Issue #449153004](https://issuetracker.google.com/issues/449153004) empty resConfigs value leads to obscure aapt error | | [Issue #447375921](https://issuetracker.google.com/issues/447375921) Pure Java project have dependency on kotlin stdlib. | | [Issue #368600704](https://issuetracker.google.com/issues/368600704) Remove deprecated KotlinMultiplatformAndroidCompilationBuilder properties in AGP 9.0 | | [Issue #445209309](https://issuetracker.google.com/issues/445209309) \`com.android.tools.build:gradle:9.0.0-alpha05\` should have an api dependency on KGP and gradle-api | | [Issue #452645779](https://issuetracker.google.com/issues/452645779) Rename com.android.experimental.built-in-kotlin Gradle plugin | | [Issue #446220448](https://issuetracker.google.com/issues/446220448) AGP9: \`variant.sources.kotlin!!.addGeneratedSourceDirectory()\` is not working | | [Issue #448450771](https://issuetracker.google.com/issues/448450771) Aar metadata checks on compile Sdk uses the old DSL | | [Issue #441523448](https://issuetracker.google.com/issues/441523448) Remove deprecated \`com.android.build.api.dsl.ManagedDevices.devices\` property | | [Issue #386221070](https://issuetracker.google.com/issues/386221070) Built-in Kotlin support in AGP should not synchronize with the Kotlin sourcesets | | [Issue #433758231](https://issuetracker.google.com/issues/433758231) Fail android library publishing if consumer keep file contains -dontobfuscate | | [Issue #241955408](https://issuetracker.google.com/issues/241955408) No Options to Print Mapping for Optimized Resources | | [Issue #436595826](https://issuetracker.google.com/issues/436595826) Make it an error to call finalizeDsl after this phase has been passed | | [Issue #457089670](https://issuetracker.google.com/issues/457089670) AGP initializes jetifier config even when jetifier is disabled | | [Issue #452246814](https://issuetracker.google.com/issues/452246814) built in kotlin does not add kotlinStdlib as a compile time dependency when \`kotlin.stdlib.default.dependency\` is true to module and pom files | | [Issue #442250902](https://issuetracker.google.com/issues/442250902) New optimizaation DSL does not create configuration.txt by default | | [Issue #443587266](https://issuetracker.google.com/issues/443587266) AGP 8.13.0 fails to verify nav graph in a module | | [Issue #444260628](https://issuetracker.google.com/issues/444260628) AGP uses deprecated Gradle API: multi-string notation | | [Issue #347732357](https://issuetracker.google.com/issues/347732357) Warn users trying to use legacy multidex library with minSdkVersion \>=21 | | [Issue #333831734](https://issuetracker.google.com/issues/333831734) A build fails if there are code generation tasks | | [Issue #446123111](https://issuetracker.google.com/issues/446123111) With \`android.builtInKotlin=false\` and \`android.newDsl=false\` and \`android.enableLegacyVariantApi=false\`, using \`kotlin-android\` plugin will fail with "API 'applicationVariants' is obsolete" | | [Issue #443037365](https://issuetracker.google.com/issues/443037365) Built-in Kotlin fails to resolve unversioned kotlin-stdlib when kotlin.stdlib.default.dependency=false | | [Issue #445967244](https://issuetracker.google.com/issues/445967244) DexData opens a file without closing, preventing cleanup | | [Issue #368609737](https://issuetracker.google.com/issues/368609737) AndroidSourceDirectorySet should stop extending PatternFilterable in AGP 9.0 | | [Issue #389707041](https://issuetracker.google.com/issues/389707041) Test Fixture Error in test only modules | | [Issue #353249347](https://issuetracker.google.com/issues/353249347) Incorrect error when using context receivers in test fixtures | | [Issue #351046197](https://issuetracker.google.com/issues/351046197) Incorrect IDE errors for Kotlin code in testFixtures | | [Issue #446889652](https://issuetracker.google.com/issues/446889652) \`legacy-kapt\` plugin skips annotation processing unlike \`kotlin-kapt\` | | [Issue #446492061](https://issuetracker.google.com/issues/446492061) compileSdkSpec.minorApiLevel is not working with SettingsExtension | | [Issue #429253579](https://issuetracker.google.com/issues/429253579) \[fused lib - public\] Generated fused library does not include sources | | [Issue #149770867](https://issuetracker.google.com/issues/149770867) extractNativeLibs and useEmbeddedDex should not be coming from the manifest | | [Issue #449114518](https://issuetracker.google.com/issues/449114518) Warnings from R8 in AGP 9.0.0-alpha09 | | [Issue #368426598](https://issuetracker.google.com/issues/368426598) Remove deprecated AndroidSourceSet.jni in AGP 9.0 | | [Issue #368484483](https://issuetracker.google.com/issues/368484483) Remove Installation.installOptions() in AGP 9.0 | | [Issue #368482484](https://issuetracker.google.com/issues/368482484) Remove BuildType.isRenderscriptDebuggable in AGP 9.0. | | [Issue #428646179](https://issuetracker.google.com/issues/428646179) Remove android.defaults.buildfeatures.renderscript | | [Issue #436887358](https://issuetracker.google.com/issues/436887358) \`com.android.kotlin.multiplatform.library\` crashes with Gradle Managed Devices | | [Issue #428645763](https://issuetracker.google.com/issues/428645763) Remove \`android.defaults.buildfeatures.aidl\` defaults gradle.properties flags | | [Issue #294183018](https://issuetracker.google.com/issues/294183018) Fail build when proguard file does not exist | | [Issue #254305041](https://issuetracker.google.com/issues/254305041) remove buildconfig defaults gradle.properties flags | | [Issue #280674230](https://issuetracker.google.com/issues/280674230) Change the app's targetSdk default value to be based on compileSdk instead of minSdk | | [Issue #436878535](https://issuetracker.google.com/issues/436878535) When \`isIncludeAndroidResources\` is enabled, \`process{Variant}UnitTestManifest\` fails to merge tools:overrideLibrary usages in AGP 8.12.0 | | [Issue #411739086](https://issuetracker.google.com/issues/411739086) AGP causing deprecation warnings in Gradle for JVM test tasks | | [Issue #235457021](https://issuetracker.google.com/issues/235457021) DependencyReportTask is incompatible with the configuration cache | | [Issue #369246556](https://issuetracker.google.com/issues/369246556) Switch default source/target Java version from Java 8 to Java 11 in AGP 9.0 | | [Issue #258855275](https://issuetracker.google.com/issues/258855275) Flip android.useAndroidX default to true | | [Issue #442763200](https://issuetracker.google.com/issues/442763200) Better exception when applying kapt plugin with built-in Kotlin. | | [Issue #441679226](https://issuetracker.google.com/issues/441679226) android.proguard.failOnMissingFiles is not working for consumerProguardFiles | | [Issue #443051391](https://issuetracker.google.com/issues/443051391) Update Kotlin Gradle plugin dependency to 2.2.10 | | [Issue #429981132](https://issuetracker.google.com/issues/429981132) Create KotlinJvmAndroidCompilation using KGP API | | [Issue #442869731](https://issuetracker.google.com/issues/442869731) Kotlin explicit API mode applied to test sources | |
| **Lint** | |---| | [Issue #430991549](https://issuetracker.google.com/issues/430991549) AGP 8.11.0: lintAnalyzeRelease task crashes when applying .gradle.kts files with apply(from = "...") | | [Issue #441536820](https://issuetracker.google.com/issues/441536820) Lint ChecksSdkIntAtLeast Check does not check if the annotated value is correct | | [Issue #446696613](https://issuetracker.google.com/issues/446696613) Built-in Kotlin does not add .kotlin_module to META-INF | | [Issue #449031505](https://issuetracker.google.com/issues/449031505) Lint classpath contains duplicate classes at different versions | | [Issue #448148350](https://issuetracker.google.com/issues/448148350) Overriding private resources workaround not working (tools:override = "true") | | [Issue #405676712](https://issuetracker.google.com/issues/405676712) Bug: removal of unused resources doesn't also remove the translations of them, and doesn't ask about it either | | [Issue #440415636](https://issuetracker.google.com/issues/440415636) Lint throwing warning "Could not clean up K2 caches" | | [Issue #440415636](https://issuetracker.google.com/issues/440415636) Lint throwing warning "Could not clean up K2 caches" | |
| **Lint Integration** | |---| | [Issue #460068798](https://issuetracker.google.com/issues/460068798) AndroidLintAnalysisTask cache misses across different JDK vendors or minor versions due to systemPropertyInputs.javaVersion differences | | [Issue #444447002](https://issuetracker.google.com/issues/444447002) Lint automatically uses latest installed SDK despite compileSdk, doesn't register as task input and breaks caching | |
| **Shrinker (R8)** | |---| | [Issue #454927488](https://issuetracker.google.com/issues/454927488) R8 optimized resource shrinking silently fails if using final resource IDs | |

<br />