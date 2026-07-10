To achieve maximum utilization of R8, the codebase must be configured correctly
depending on the build script language (Kotlin DSL versus Groovy DSL).

## 1. App Modules (`com.android.application`)

The app's `build.gradle` or `build.gradle.kts` file must enable minification
and resource shrinking within the `release` build type or the apps custom build
type for release and performance testing. It MUST use the optimized default file
(`proguard-android-optimize.txt`).

**Kotlin DSL (`build.gradle.kts`):**

    buildTypes {
       getByName("release") {
           isMinifyEnabled = true
           isShrinkResources = true
           proguardFiles(
               getDefaultProguardFile("proguard-android-optimize.txt"),
               "proguard-rules.pro"
           )
       }
    }

**Groovy DSL (`build.gradle`):**

    buildTypes {
       release {
           minifyEnabled = true
           shrinkResources = true
           proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
       }
    }

## 2. `gradle.properties` Flags

**Full Mode:** R8 Full Mode enables the entire optimizations

- **AGP 8.0+** : Enabled by default. Ensure `android.enableR8.fullMode=false` is **NOT** present.
- **Pre-AGP 8.0** : Explicitly enable with `android.enableR8.fullMode=true`.

**Optimized Resource Shrinking:** If the AGP version of the project is less than
9.0 and more than 8.6, explicitly enable the new resource shrinker:

    android.r8.optimizedResourceShrinking=true