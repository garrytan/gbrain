This document outlines common "bad" or redundant keep rules for standard Android
development and popular libraries. Modern toolchains and libraries include their
own consumer keep rules embedded in their AAR/JAR files, making many manual
configurations unnecessary or even harmful to code optimization.

*** ** * ** ***

## Case: Global Keep Rules

**Common Mistakes:**
`proguard
-dontshrink
-dontobfuscate
-dontoptimize`

**The Fix:** These keep rules completely disable the core optimizations of R8
for the entire codebase. They must be removed from the codebase.

*** ** * ** ***

## Case: Android Components

Keep rules required for Android components like Activity, Fragment, ViewModel,
Views, Services or Broadcast receivers are redundant. AAPT2 and R8 contain the
logic to automatically keep components declared in the `AndroidManifest.xml` or
referenced in XML layout files.

**Common Mistakes:**
`proguard
-keep public class * extends android.app.Activity
-keep public class * extends android.app.Service
-keep public class * extends android.view.View
-keepclassmembers class * extends android.app.Fragment { public void *(android.view.View); }`

**The Fix:** Delete these manual rules. AAPT2 handles this automatically.

*** ** * ** ***

## Case: Official Android and Kotlin Libraries

Keep rules targeting official library packages like AndroidX, Kotlin, and
Kotlinx are redundant as they are bundled within the libraries themselves.
Manual rules are often broader than what is strictly needed.

**Common Mistakes:**
`proguard
-keep class androidx.** { *; }
-keep class kotlinx.** { *; }
-keep class kotlin.** { *; }`

**The Fix:** Delete these manual rules. Rely on the consumer keep rules packaged
within these dependencies.

*** ** * ** ***

## Case: Gson

### Overly Broad Data Model Rules

The most common mistake is keeping entire packages of data models (POJOs/DTOs),
keeping data models at all for deserialization is unnecessary.

    -keep class com.example.app.models.** { *; }
    -keep class com.example.app.package.models.* { *; }

### Redundant Interface \& Adapter Rules

These rules added for TypeAdapter are unnecessary and are already covered by
the library, and prevent R8 from effectively shrinking and optimizing custom
adapters. R8 can determine if the adapter implementation are used. Keeping them
globally prevents the removal of unused adapter implementations.

    -keep class * extends com.google.gson.TypeAdapter
    -keep class * implements com.google.gson.TypeAdapterFactory
    -keep class * implements com.google.gson.JsonSerializer
    -keep class * implements com.google.gson.JsonDeserializer

### Unnecessary TypeToken Rules

There is no need to handle generic type erasure, Gson's own rules handle the
necessary `TypeToken` preservation.

    -keep class com.google.gson.reflect.TypeToken { *; }
    -keep class * extends com.google.gson.reflect.TypeToken
    -keep,allowobfuscation,allowshrinking class com.google.gson.reflect.TypeToken

### Internal and Example Packages

Keeping internal library logic prevents the compiler from stripping away dead
code within the library.

    -keep class com.google.gson.internal.** { *; }
    -keep class com.google.gson.internal.reflect.** { *; }
    -keep class com.google.gson.internal.UnsafeAllocator { *; }
    -keep class com.google.gson.stream.** { *; }

- **Keeps Unused Code:** Prevents R8 from removing models that are never actually used in the code.
- **Prevents Method Stripping:** Keeps all getters, setters, `toString()`, `equals()`, and `hashCode()` methods, even if they are never called.
- **Blocks Obfuscation:** Prevents the class names from being obfuscated, which is unnecessary for Gson if you use `@SerializedName`.

**The Fix:**

1. Use `@SerializedName` on every field in your data classes uses so that the field is retained after R8 optimization
2. Modern Gson (**v2.11.0+** ) bundles its own rules ([View Gson's embedded
   ProGuard
   rules](https://github.com/google/gson/blob/main/gson/src/main/resources/META-INF/proguard/gson.pro)). The bundled keep rules retains the `@SerializedName` annotated fields. If you are on an older version, move towards Gson version 2.11 because it has the necessary keep rules and delete the keep rules that target the classes used for gson serialization and deserialization

*** ** * ** ***

## Case: Retrofit

Retrofit has shipped with its own consumer keep rules from 2.9.0 and higher, so
any keep rules for the library or classes depending on Retrofit is detrimental
to the optimization process.

### Blanket Library Preservation

This is the most harmful Retrofit rule as it disables any shrinking for the
entire library.

    -keep class retrofit2.** { *; }
    -keep class retrofit2.api.** { *; }
    -keep class com.package.example.retrofit.api.** { *; }

### Manual Annotation Keeps

Retrofit's consumer rules automatically keep the interfaces annotated with
`@GET`, `@POST`, `@DELETE`, `@PUT`, `@HEAD`, `@OPTIONS`, `@PATCH`, making these
manual rules obsolete.

`-keepclasseswithmembers class * { @retrofit2.http.* <methods>; }`

### Redundant Network Response and Adapter Rules

Network responses and third-party adapter wrappers (like RxJava) are often
overly preserved by developers out of caution.

    -keep,allowobfuscation,allowshrinking class retrofit2.Response
    -keep class retrofit2.adapter.rxjava2.Result { *; }

Fix: Verify you are using Retrofit 2.9.0 and higher. Retrofit from 2.9.0 bundles
rules that detect its own HTTP annotations (@GET, @POST) ([View Retrofit's
embedded ProGuard
rules](https://github.com/square/retrofit/blob/master/retrofit/src/main/resources/META-INF/proguard/retrofit2.pro)).
It will automatically keep the method signatures it needs to work.

*** ** * ** ***

## Case: Kotlin Coroutines

Kotlin Coroutines comes heavily optimized out of the box with embedded R8 rules
(`kotlinx-coroutines-core` includes its own rules).

### Blanket Coroutine Library Rules

Keeping everything under `kotlinx.coroutines` is extremely detrimental to app
size, as coroutines contain a vast amount of internal APIs that aren't used.

`-keepclassmembers class kotlinx.coroutines.** { *; }`

### Redundant Internal Continuations

These low-level coroutine elements are preserved safely by the library's own
consumer rules. Manually adding these prevents R8 from performing internal
optimizations (such as removing unused continuations or inlining).

    -keepclassmembers class kotlin.coroutines.SafeContinuation { *; }
    -keep,allowobfuscation,allowshrinking class kotlin.coroutines.Continuation

### Dispatcher and Exception Handler Rules

Sometimes developers notice crashes related to Missing Classes on old Android
versions and add these rules, but if you are using an up-to-date version of
Coroutines, these are handled automatically or are not an issue.

    -keepnames class kotlinx.coroutines.internal.MainDispatcherFactory {}
    -keepnames class kotlinx.coroutines.CoroutineExceptionHandler {}
    -keepnames class kotlinx.coroutines.android.AndroidExceptionPreHandler {}
    -keepnames class kotlinx.coroutines.android.AndroidDispatcherFactory {}

**Fix** Remove any broad `kotlinx` keep rules. Coroutines (**v1.7.0+** ) bundle
the necessary keep rules ([View Coroutines' embedded ProGuard
rules](https://github.com/Kotlin/kotlinx.coroutines/blob/master/kotlinx-coroutines-core/jvm/resources/META-INF/proguard/coroutines.pro)).

*** ** * ** ***

## Case: Parcelable

**Common Mistakes:** Legacy projects often contain `-keep class * implements
android.os.Parcelable { public static final android.os.Parcelable$Creator *; }`.

**The Fix:**

1. Add the `kotlin-parcelize` plugin.
2. **Use `@Parcelize`:** Replace manual `writeToParcel` logic with the `@Parcelize` annotation.
3. **Delete All Parcelable Rules:** The plugin automatically generates the required rules.
4. The default proguard file `proguard-android-optimize.txt` contains the keep rules for keeping all the parcelable classes
5. **Ideal Rule:** **None.** Delete all manual Parcelable keeps.

*** ** * ** ***

## Case: Room Database

**Common Mistakes:** Keeping DAO interfaces or the generated `_Impl` classes
manually.

    -keep class * extends androidx.room.RoomDatabase
    -keep class *_*Impl { *; }

**The Fix:** Room generates its own ProGuard rules for the code it creates.
Manual rules are redundant and prevent R8 from optimizing the database access
layers.

- **Ideal Rule:** **None.** Delete all manual Room or DAO keeps.

*** ** * ** ***

## Summary

If you have updated your libraries to the versions mentioned, your
`proguard-rules.pro` must not contain any keep rules for the libraries
mentioned here.