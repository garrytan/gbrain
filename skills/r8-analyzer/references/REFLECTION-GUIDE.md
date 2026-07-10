A categorized summary of the keep rule examples, including the code patterns to
look for (imports/usage) and the corresponding suggested rules.

### 1. Reflection: Classes Loaded by Name

**Scenario:** A library or app loads a class dynamically using a string name

- **Look for:**
  `Class.forName("...")`,
  `getDeclaredConstructor().newInstance()`, or interfaces used for dynamic loading.

- **Example Code:**
  `kotlin
  val taskClass = Class.forName(className)
  val task = taskClass.getDeclaredConstructor().newInstance() as StartupTask`

- **Suggested Keep Rule:**
  \`\`\`proguard

  -keep class \* implements com.example.library.StartupTask {
  (); } \`\`\`

### 2. Reflection: Classes Passed using `::class.java`

**Scenario:** An app passes a class reference directly to a library function.

- **Look for:** `::class.java` (Kotlin) or `.class` (Java) passed as an argument.
- **Example Code:**
  `kotlin
  fun <T> register(clazz: Class<T>) { }
  // Usage:
  register(MyService::class.java)`

- **Suggested Keep Rule:**
  \`\`\`proguard

  # Keep the class itself (R8 usually handles this, but explicit rules ensure stability)

  -keep class com.example.app.MyService {
  (); } \`\`\`

### 3. Annotation-Based Reflection (Methods/Classes)

**Scenario:** Using custom annotations to mark methods or classes for reflective
execution.

**Look for:** Custom `@interface` definitions and `getDeclaredMethods()`
filtered by annotation.
**Example Code:**
`kotlin
annotation class ReflectiveExecutor
// Logic: find methods annotated with @ReflectiveExecutor and invoke them`

- **Suggested Keep Rule:** \`\`\`proguard # Keep the annotation itself -keep @interface com.example.library.ReflectiveExecutor

# Keep members of any class annotated with this specific annotation
-keepclassmembers class \* {
@com.example.library.ReflectiveExecutor \*;
}
\`\`\`

### 4. Optional Dependencies (Soft Dependencies)

**Scenario:** A core library checks if an optional module is present in the
classpath.

- **Look for:** `try-catch` blocks around `Class.forName()` used to toggle features.
- **Example Code:** \`\`\`kotlin private const val VIDEO_TRACKER_CLASS = "com.example.analytics.video.VideoEventTracker"

try {
Class.forName(VIDEO_TRACKER_CLASS).getDeclaredConstructor().newInstance()
} catch (e: ClassNotFoundException) { /\* skip feature \*/ }
\`\`\`

- **Suggested Keep Rule:** `proguard
  # Preserve the optional class so the check doesn't fail due to shrinking
  -keep class com.example.analytics.video.VideoEventTracker {
  <init>();
  }`

### 5. Accessing Private Members

**Scenario:** Using reflection to access internal fields or methods not exposed
with public APIs.

- **Look for:** `getDeclaredField("...")` or `getDeclaredMethod("...")` followed by `isAccessible = true`.
- **Example Code:**
  `kotlin
  val secretField = instance::class.java.getDeclaredField("secretMessage")
  secretField.isAccessible = true`

- **Suggested Keep Rule:**
  \`\`\`proguard

  # Specifically keep the private field/method by name and type

  -keepclassmembers class com.example.LibraryClass {
  private java.lang.String secretMessage;
  }
  \`\`\`

### 6. Parcelable (Manual Implementation)

**Scenario:** Implementing `Parcelable` without using the `@Parcelize`
annotation.

- **Look for:** `implements Parcelable` and a static `CREATOR` field.
- **Example Code:**
  `kotlin
  class MyData : Parcelable {
  // Manual implementation with CREATOR field
  }`

- **Suggested Keep Rule:**
  *(Note: If using `import kotlinx.parcelize.Parcelize`, R8/ProGuard rules are
  generated automatically. If manual, use the following:)*
  `proguard
  -keepclassmembers class * implements android.os.Parcelable {
  static android.os.Parcelable$Creator CREATOR;
  }`

### 7. Enums and Obfuscation

**Scenario:** App uses `Enum.valueOf("STRING_NAME")` indirectly (e.g.,using JSON
deserialization) and the enum names get obfuscated.

- **Look for:** Unnecessary generic Enum keep rules in ProGuard files.
- **Example Code:**
  \`\`\`proguard

  # Unnecessary rule

  -keepclassmembers enum \* { \*; }
  \`\`\`
- **Suggested Keep Rule:**
  \*(Note: The default `proguard-android-optimize.txt` already contains the optimal
  rules for Enums (keeping `values()` and `valueOf(String)`). Any additional
  manual rules for Enums are redundant.) # No manual rule needed. Use default
  proguard-android-optimize.txt.