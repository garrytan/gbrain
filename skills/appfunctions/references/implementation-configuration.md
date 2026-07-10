Specialized instructions for generating Kotlin implementations of AppFunctions,
handling system-wide configuration, and managing build dependencies.

## Instructions

### Step 1: Gradle Dependencies \& KSP

Add the following to `build.gradle.kts`. App Functions requires the KSP (Kotlin
Symbol Processing) plugin.

1. **Version Check**: Use the latest library versions from maven.google.com.


```kotlin
implementation(libs.androidx.appfunctions)
implementation(libs.androidx.appfunctions.service)
ksp(libs.androidx.appfunctions.compiler)
```

<br />


```kotlin
ksp {
    arg("appfunctions:aggregateAppFunctions", "true")
}
```

<br />

### Step 2: App Metadata XML Setup

Describe the app's capabilities to the LLM by defining
`res/xml/app_metadata.xml`.

    <AppFunctionAppMetadata xmlns:appfn="http://schemas.android.com/apk/androidx.appfunctions"
        appfn:description="This app manages personal notes.
        Operational Patterns:
        - Use 'listNotes' to find the correct 'noteId' before calling 'editNote'.
        Constraints:
        - Note editing is only possible for existing IDs returned by the system."
        appfn:displayDescription="@string/user_visible_description" />

Reference this in `AndroidManifest.xml` within the `<application>` tag:

    <manifest>
        <application>
            <property android:name="android.app.appfunctions.app_metadata"
                      android:resource="@xml/app_metadata" />
        </application>
    </manifest>

### Step 3: Function Implementation

When generating Kotlin code for AppFunctions, you MUST adhere to these rules:

1. **Annotations** :
   - Annotate the function with `@AppFunction(isDescribedByKDoc = true)`.
   - Annotate associated data classes with `@AppFunctionSerializable(isDescribedByKDoc = true)`.
2. **Parameter Strategy** :
   - **First Parameter** : MUST be `androidx.appfunctions.AppFunctionContext`.
   - **Specificity**: Keep parameters specific. State objects need to be unambiguous.
   - **Optionality**: If a parameter is not essential, make it optional with a reasonable default value.
3. **Execution \& Threading** :
   - Use `suspend` functions.
   - Switch to the relevant Coroutine Dispatcher (e.g., `withContext(Dispatchers.IO)`) because AppFunction implementations run on the Android UI thread by default.
4. **Supported Types** :
   - **Primitives** : `Int`, `Long`, `Float`, `Double`, `Boolean`.
   - **Arrays** : `IntArray`, `LongArray`, `FloatArray`, `DoubleArray`, `BooleanArray`.
   - **Native Types** : `String`, `PendingIntent`, `Uri`, `LocalTime`, `LocalDate`, `LocalDateTime`, `Instant`. (Prefer `LocalDateTime` or `Instant` for date/time).
   - **Custom Objects** : Classes annotated with `@AppFunctionSerializable`.
   - **Collections** : `List` of any supported non-primitive type.
5. **Default Values** :
   - Use defaults that align with the type's "empty" state (e.g., `0` for `Int`, `null` for nullable, `emptyList()` for `List`).
6. **Error Handling** :
   - Throw subclasses of `androidx.appfunctions.AppFunctionException` to report errors to callers.
7. **Security** :
   - Don't expose highly sensitive user data (passwords, financial details).
   - Don't expose irreversible destructive actions without confirmation steps.

### Step 4: (Optional) System Configuration for Dependency Injection

Only required for dependency injection configuration. Implement
`AppFunctionConfiguration.Provider` in the `Application` class to provide
instances of classes containing `@AppFunction` methods.

**Example Hilt Integration:**


```kotlin
@HiltAndroidApp
class AppFunctionApplication : Application(), AppFunctionConfiguration.Provider {
    @Inject lateinit var noteFunctions: NoteFunctions

    override val appFunctionConfiguration: AppFunctionConfiguration =
        AppFunctionConfiguration.Builder()
            .addEnclosingClassFactory(NoteFunctions::class.java) { noteFunctions }
            .build()
}
```

<br />

## Critical Constraints

### Parameter Ordering

**CRITICAL** : The very first parameter of an `@AppFunction` method MUST be
`androidx.appfunctions.AppFunctionContext`.

### KSP Compliance for Serializables

**CRITICAL** : For `@AppFunctionSerializable` data classes, KSP **only** extracts
documentation if it is written as **inline KDoc** directly for each property
definition. NEVER use class-level `@param` or `@property` tags.

### Package Integrity

Configuration APIs and the `@AppFunction` annotation are located in
`androidx.appfunctions.service`.

## Examples

### Example: Serializable with Inline KDoc


```kotlin
/**
 * A note.
 */
@AppFunctionSerializable(isDescribedByKDoc = true)
data class Note(
    /** The note's identifier */
    val id: Int,
    /** The note's title */
    val title: String,
    /** The note's content */
    val content: String
)
```

<br />

### Example: Implementation Detail


```kotlin
/**
 * A note app's [AppFunction]s.
 */
class NoteFunctions @Inject constructor(
    private val noteRepository: NoteRepository
) {
    /**
     * List all available notes in the app.
     *
     * @param appFunctionContext The execution context.
     * @return A list of [Note] objects, or null if no notes exist.
     */
    @AppFunction(isDescribedByKDoc = true)
    suspend fun listNotes(appFunctionContext: AppFunctionContext): List<Note>? {
        return noteRepository.appNotes.ifEmpty { null }?.toList()
    }

    /**
     * Create a new note with a title and body content.
     *
     * @param appFunctionContext The execution context.
     * @param title The title of the note.
     * @param content The body content of the note.
     * @return The created [Note] object including its generated ID.
     */
    @AppFunction(isDescribedByKDoc = true)
    suspend fun createNote(
        appFunctionContext: AppFunctionContext,
        title: String,
        content: String
    ): Note {
        return noteRepository.createNote(title, content)
    }

    /**
     * Update the title or content of an existing note.
     * Required workflow: Call [listNotes] first to obtain valid note IDs.
     *
     * @param appFunctionContext The execution context.
     * @param noteId The unique identifier of the note to edit.
     * @param title The new title. If null, the existing title is preserved.
     * @param content The new content. If null, the existing content is preserved.
     * @return The updated [Note], or null if the [noteId] was not found.
     */
    @AppFunction(isDescribedByKDoc = true)
    suspend fun editNote(
        appFunctionContext: AppFunctionContext,
        noteId: Int,
        title: String?,
        content: String?,
    ): Note? {
        return noteRepository.updateNote(noteId, title, content)
    }
}
```

<br />

## Troubleshooting

### Error: "AppFunction unavailable" or "Metadata missing"

**Cause**: The AppSearch indexing failed to extract the schema correctly.

**Solution**:

1. Verify `@AppFunctionSerializable` classes use inline KDoc comments, NOT class-level `@param` tags.
2. Check that the `assets/app_function_v2.xml` file exists in the APK.
3. Confirm the `ksp("androidx.appfunctions:appfunctions-compiler")` dependency is correctly applied.
4. Ensure the `ksp` argument `appfunctions:aggregateAppFunctions` is set to `"true"`.