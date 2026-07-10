For the best user experience, you should optimize your app to make it as small
and fast as possible. Our app optimizer, called R8, streamlines your app by
removing unused code and resources, rewriting code to optimize runtime
performance, and more. To your users, this means:

- Faster startup time
- Reduced memory usage
- Improved rendering and runtime performance
- Fewer [ANRs](https://developer.android.com/topic/performance/anrs/keep-your-app-responsive)

> [!IMPORTANT]
> **Important:** You should always enable optimization for your app's release build; however, you probably don't want to enable it for tests or libraries. For more information about using R8 with tests, see [Test and troubleshoot the
> optimization](https://developer.android.com/topic/performance/app-optimization/test-and-troubleshoot-the-optimization). For more information about enabling R8 from libraries, see [Optimization for library authors](https://developer.android.com/topic/performance/app-optimization/library-optimization).

> [!IMPORTANT]
> **Important:** We released an agent skill that you can use to improve your app performance with R8. Try out the skill from the [Android skills repository](https://github.com/android/skills).

## R8 optimization overview

R8 uses a multi-phase process to optimize your app for size and speed. Key
operations include the following:

- **Code shrinking (also known as tree shaking)** : R8 identifies and removes
  unreachable code from your application and its library dependencies. By
  analyzing the entry points of your app (such as `Activities` or `Services`
  defined in the manifest), R8 builds a graph of referenced code and removes
  anything that remains unreferenced.

- **Logical optimizations**: R8 rewrites your code to improve execution
  efficiency and reduce overhead. Key techniques include:

  - **Method inlining**: R8 replaces a method call site with the actual body
    of the called method. This eliminates the overhead of a function call
    and lets R8 conduct further optimizations.

  - **Class merging**: R8 combines sets of classes and interfaces into a
    single class. This reduces the number of classes in the app, lowering
    memory pressure and improving startup speed.

- **Obfuscation (also known as minification)** : To reduce the size of the DEX
  file, R8 shortens the names of classes, fields, and methods (for example,
  `com.example.MyActivity` could become `a.b.a`).

Since 8.12.0 version of Android Gradle Plugin (AGP), R8 also optimizes resources
as part of its optimization phases. For more information, see [Optimized
resource shrinking](https://developer.android.com/topic/performance/app-optimization/enable-app-optimization#optimize-resource-shrinking).

## Enable optimization

To enable app optimization, set `isMinifyEnabled = true` (for code optimization)
and `isShrinkResources = true` (for resource optimization) in your [release
build's](https://developer.android.com/studio/publish/preparing#turn-off-debugging) app-level build script as shown in the following code. We recommend
that you always enable both settings. We also recommend enabling app
optimization only in the final version of your app that you test before
publishing---usually your release build---because the optimizations increase the
build time of your project and can make debugging harder due to the way it
modifies code.

### Kotlin

```kotlin
android {
    buildTypes {
        release {

            // Enables code-related app optimization.
            isMinifyEnabled = true

            // Enables resource shrinking.
            isShrinkResources = true

            proguardFiles(
                // Default file with automatically generated optimization rules.
                getDefaultProguardFile("proguard-android-optimize.txt"),

                ...
            )
            ...
        }
    }
    ...
}
```

### Groovy

```groovy
android {
    buildTypes {
        release {

            // Enables code-related app optimization.
            minifyEnabled = true

            // Enables resource shrinking.
            shrinkResources = true

            // Default file with automatically generated optimization rules.
            proguardFiles getDefaultProguardFile('proguard-android-optimize.txt')

            ...
        }
    }
}
```

## Improve R8 optimization

The performance benefits of R8 are directly correlated to how much of your
codebase R8 is able to optimize. To get the maximum benefits out of R8, follow
best practices:

- Enable R8 in [full mode](https://developer.android.com/topic/performance/app-optimization/full-mode)
- Enable [obfuscation, optimization, and shrinking](https://developer.android.com/topic/performance/app-optimization/adopt-optimizations-incrementally)
- Enable resource shrinking and [optimized resource shrinking](https://developer.android.com/topic/performance/app-optimization/enable-app-optimization#optimize-resource-shrinking)
- [Refine keep rules](https://developer.android.com/topic/performance/app-optimization/keep-rules-best-practices) to allow maximum optimization of classes, fields and methods.

To help you refine keep rules, use the [R8 Configuration Analyzer](https://developer.android.com/topic/performance/app-optimization/r8-configuration-analyzer).

The R8 Configuration Analyzer lets you do the following:

- Track and improve the overall R8 configuration quality by monitoring the metrics provided by the R8 Configuration Analyzer report.
- Find the broadest keep rules - those which prevent the most optimization
- and understand what optimization they prevent to refine them.

The R8 Configuration Analyzer is available in AGP version 9.3.0-alpha05 or from
R8 version 9.3.7-dev. For more information, see [Analyze R8 configuration](https://developer.android.com/topic/performance/app-optimization/r8-configuration-analyzer).

## Optimize resource shrinking for even smaller apps

The 8.12.0 version of Android Gradle Plugin (AGP) introduces optimized resource
shrinking, which aims to integrate resource and code optimization to create even
smaller and faster apps.

Before optimized resource shrinking, Android Asset Packaging Tool (AAPT2)
generated keep rules that effectively treating resource shrinking separately
from code, often retaining inaccessible code or resources that referenced each
other.

With optimized resource shrinking, resources are considered like a part of
program code, forming the reference graph. When a collection of code or
resources is not referenced, it is not protected by a keep rule, and can be
removed.

### Enable optimized resource shrinking

To enable the new optimized resource shrinking pipeline for AGP 8.12 or 8.13,
add the following to your project's `gradle.properties` file:

    android.r8.optimizedResourceShrinking=true

If you are using AGP 9.0.0 or a newer version, you don't need to set
`android.r8.optimizedResourceShrinking=true`. Optimized resource shrinking is
automatically applied when `isShrinkResources = true` is enabled in your build
configuration.

## Verify and configure R8 optimization settings

To enable R8 to use its [full optimization capabilities](https://developer.android.com/topic/performance/app-optimization/full-mode), remove the
following line from your project's `gradle.properties` file, if it exists:

    android.enableR8.fullMode=false # Remove this line from your codebase.

Note that enabling app optimization makes stack traces difficult to understand,
especially if R8 renames class or method names. To get stack traces that
correctly correspond to your source code, see [Recover the original stack
trace](https://developer.android.com/topic/performance/app-optimization/test-and-troubleshoot-the-optimization#recover-original-stack-trace).

If R8 is enabled, you should also [create Startup Profiles](https://developer.android.com/topic/performance/baselineprofiles/dex-layout-optimizations) for even better
startup performance.

If you enable app optimization and it causes errors, here are some strategies to
fix them:

- [Add keep rules](https://developer.android.com/topic/performance/app-optimization/add-keep-rules) to keep some code untouched.
- [Adopt optimizations incrementally](https://developer.android.com/topic/performance/app-optimization/adopt-optimizations-incrementally).
- Update your code to [use libraries that are better suited for
  optimization](https://developer.android.com/topic/performance/app-optimization/choose-libraries-wisely).

> [!CAUTION]
> **Caution:** Tools that replace or modify R8's output can negatively impact runtime performance. R8 is careful about including and testing many optimizations at the code level, in [DEX layout](https://developer.android.com/topic/performance/baselineprofiles/dex-layout-optimizations), and in correctly producing Baseline Profiles - other tools producing or modifying DEX files can break these optimizations, or otherwise regress performance.

If you are interested in optimizing your build speed, see [Configure how R8
runs](https://developer.android.com/build/r8-execution-profiles) for information on how to configure R8 based on your environment.

## AGP and R8 version behavior changes

The following table outlines the key features introduced in various versions of
the Android Gradle Plugin (AGP) and the R8 compiler.

| AGP version | Features introduced |
|---|---|
| 9.1 | **Classes repackaged by default:** R8 repackages classes (moving them to the unnamed package, at the top level) to compact DEX further, eliminating the need to specify `-repackageclasses` option. For information about how this works and how to opt out, see [global options](https://developer.android.com/topic/performance/app-optimization/global-options#global-options). |
| 9.0 | **Optimized resource shrinking:** Enabled by default (controlled using `android.r8.optimizedResourceShrinking`). [Optimized resource shrinking](https://developer.android.com/topic/performance/app-optimization/enable-app-optimization#optimize-resource-shrinking) helps integrate resource shrinking with the code optimization pipeline, leading to smaller, faster apps. By optimizing both code and resource references simultaneously, it identifies and removes resources referenced exclusively from unused code. This is a significant improvement over the previous separate optimization processes. This is especially useful for apps that share substantial resources and code across different form factor verticals, with measured improvements of over 50% in app size. The resulting size reduction leads to smaller downloads, faster installations, and a better user experience with faster startup, improved rendering, and fewer ANRs. **Library rule filtering:** Support for global options (for example, `-dontobfuscate`) in library consumer rules has been dropped, and apps will filter them out. For more information, see [Add global options](https://developer.android.com/topic/performance/app-optimization/global-options). **Kotlin null checks:** Optimized by default (controlled using `-processkotlinnullchecks`). This version also introduced significant improvements in build speed. For more information, see [Global options for additional optimization](https://developer.android.com/topic/performance/app-optimization/global-options#global-options). **Optimize specific packages:** You can use `packageScope` to optimize specific packages. This is in experimental support. For more information, see [Optimize specified packages with `packageScope`](https://developer.android.com/topic/performance/app-optimization/optimize-specified-packages). **Optimized by default:** Support for `getDefaultProguardFile("proguard-android.txt")` has been dropped, because it includes `-dontoptimize`, which should be avoided. Instead, use `"proguard-android-optimize.txt"`. If you need to globally disable optimization in your app, [add the flag manually to a proguard file](https://developer.android.com/topic/performance/app-optimization/global-options#global-options-2). |
| 8.12 | **Optimized resource shrinking:** Initial support added (controlled using `android.r8.optimizedResourceShrinking`). [Optimized resource shrinking](https://developer.android.com/topic/performance/app-optimization/enable-app-optimization#optimize-resource-shrinking) helps integrate resource shrinking with the code optimization pipeline. You must manually enable it in this version of AGP. **Logcat retracing:** Support for automatic retracing in the Android Studio [Logcat window](https://developer.android.com/studio/debug/logcat). |
| 8.6 | **Improved retracing:** Includes filename and line number retracing by default for all `minSdk` levels (previously required `minSdk` 26+ in version 8.2). Updating R8 helps ensure that stack traces from obfuscated builds are readily and clearly readable. This version improves how line numbers and source files are mapped, making it easier for tools like the Android Studio Logcat to automatically retrace crashes to the original source code. |
| 8.0 | **Full mode by default:** [R8 full mode](https://developer.android.com/topic/performance/app-optimization/full-mode) provides significantly more powerful optimization. It is enabled by default. You can opt out using `android.enableR8.fullMode=false`. |
| 7.0 | **Full mode available:** Introduced as an opt-in feature using `android.enableR8.fullMode=true`. Full mode applies more powerful optimizations by making stricter assumptions about how your code uses reflection and other dynamic features. While it reduces app size and improves performance, it might require additional keep rules to prevent necessary code from being stripped. |