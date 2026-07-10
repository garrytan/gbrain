---
name: android-intent-security
description: Best practices for Android Intent security. Use this skill when auditing
  component configurations in AndroidManifest.xml activities, services, receivers)
  or source code handling incoming Intents (getIntent, getParcelableExtra) to prevent
  Intent Redirection and unauthorized access.
license: Complete terms in LICENSE.txt
metadata:
  author: Google LLC
  last-updated: '2026-06-25'
  keywords:
  - recipe
  - Android
  - Security
  - Intent
  - Redirection
  - PendingIntent
  - ContentProvider
  - Service
  - Signature
  - Verification
  - sanitizer
  - Vulnerability
  - Best Practices
triggers:
  - android
  - jetpack
  - compose
---

This skill provides guidelines and patterns to secure Android components
(Activities, Services, Broadcast Receivers, Content Providers) and handle
Intents safely, preventing privilege escalation and unauthorized access.

## Glossary

- **Intent:** An asynchronous messaging object used to request an action from another app component.
- **Exported component:** A component (`android:exported="true"`) that can be launched by other apps on the device.
- **Sticky intent:** A broadcast intent that remains in the system cache after it's sent, allowing any app to retrieve its contents.
- **Signature permission:** A permission whose protection level is set to `signature`, granted only to apps signed with the same developer key.
- **onNewIntent:** An activity lifecycle callback invoked when an activity is launched with `FLAG_ACTIVITY_SINGLE_TOP` and is already running at the top of the history stack.
- **PendingIntent:** A token granted to a foreign application (for example, system services) allowing it to execute a predefined Intent with the creator's permissions.
- **Mutable PendingIntent:** A PendingIntent whose underlying Intent parameters can be modified by the receiving application.
- **ContentProvider:** A component that encapsulates data and provides it to other applications via standard query/insert interfaces.
- **IntentSanitizer:** A utility class in AndroidX Core used to build a safe, sanitized copy of an incoming Intent by filtering out unauthorized components, actions, or extras.
- **Intent redirection (forwarding):** A vulnerability where an application receives an intent from an untrusted source and uses it to launch a private, non-exported component.

## Prerequisites

- The agent **MUST** be able to describe the function and security implications of `onCreate`, `onNewIntent`, and the `singleTop` launch mode.
- The agent **MUST** be able to declare `<activity>`, `<service>`, `<receiver>`, and `<provider>` tags in `AndroidManifest.xml` and define their `android:exported` and `android:permission` attributes.
- The agent **MUST** be able to implement signature verification checks using `PackageManager`.

## Limitations

- This skill focuses on local inter-component and inter-app communication security on the Android platform.
- This skill **doesn't** cover network security, web integration, or host-to-server security.

## Setup and dependencies

- **Android SDK:** Minimum API Level 23 (Android 6.0) is required for standard hardware-backed keystore operations and component validation.
- **AndroidX Core Library:** `androidx.core:core:1.9.0` or higher is **mandatory** to leverage `IntentSanitizer`.
- **Standard API access:** Standard Android `PackageManager` APIs are required for runtime component verification.

*** ** * ** ***

## Intent security logic and decisions

### 1. Intent routing comparison

Evaluate the security features of different intent delivery methods:

| Intent Delivery Method | Scope | Recommended Use Case |
|---|---|---|
| Explicit Intent (Internal) | App Private | Launching internal activities/services |
| Implicit Intent | System Wide | Launching system camera, dialer, or sharing |
| Local Broadcasts (LocalBroadcastManager) (DEPRECATED) | App Private | Internal asynchronous event routing. **Deprecated**: Use in-app observers like Kotlin Flows/SharedFlow, LiveData, or reactive patterns instead. |
| System Broadcasts | System Wide | Receiving system events (NFC, Bluetooth) |

### 2. PendingIntent mutability flag options

Evaluate the security implications of PendingIntent mutability flags:

| Flag Name | Mutability | Recommended Use Case |
|---|---|---|
| `PendingIntent.FLAG_IMMUTABLE` | Immutable | Default for almost all PendingIntents, such as alarms and notifications |
| `PendingIntent.FLAG_MUTABLE` | Mutable | Inline notifications replies, slice actions (requires explicit target intent) |

### 3. Intent handling and redirection logic

IF (the component receives a nested Intent as an extra) {
IF (AndroidX Core 1.9.0+ and higher is available) {
MUST construct an `IntentSanitizer` to explicitly allowlist components, actions, data, and extras.
MUST call `sanitizeByThrowing()` or `sanitizeByFiltering()` before launching.
} ELSE {
MUST verify that the nested Intent's target package matches the current application package.
MUST verify that the target component of the nested Intent is publicly exported.
}
NEVER launch the nested Intent directly without validation.
} ELSE IF (the component handles broadcasts) {
MUST rely on the system's Protected Broadcast mechanism for system events (which guarantees the sender is the system framework).
MUST protect custom receivers with signature-level permissions or use `RECEIVER_NOT_EXPORTED` for dynamic receivers to restrict the sender.
}

### 4. PendingIntent security logic

IF (a PendingIntent is created for delivery to another application) {
MUST use `PendingIntent.FLAG_IMMUTABLE` by default.
IF (the PendingIntent must be mutable) {
MUST set the explicit target component or package name on the base `Intent`.
NEVER create an implicit, mutable `PendingIntent`.
}
}

### 5. ContentProvider security logic

IF (the ContentProvider is only for internal app use) {
MUST set `android:exported="false"`.
} ELSE {
MUST protect it with `android:readPermission` and `android:writePermission`.
MUST set `android:grantUriPermissions="false"` unless temporary URL access is strictly required.
}

### 6. Service caller verification logic

IF (an exported service communicates with trusted sister/partner apps) {
MUST retrieve the calling UID using `Binder.getCallingUid()` and resolve it to package names using `PackageManager.getPackagesForUid()`.
MUST verify that the calling package signature fingerprint matches your trusted certificate hash.
}

*** ** * ** ***

## Code and configuration patterns

### 1. Safe intent redirection (manual verification)

Validate the target of a nested intent before launching it when modern
sanitization libraries are unavailable.

- **Expected Inputs:**
  - An incoming `Intent` containing a nested `Intent` extra named `EXTRA_NESTED_INTENT`.
- **Expected Outputs:**
  - Launches the target component if safe; throws `SecurityException` if validation fails.


```kotlin
fun safeIntentRedirectionManual() {
    val nestedIntent = IntentCompat.getParcelableExtra(intent, "EXTRA_NESTED_INTENT", Intent::class.java)
    if (nestedIntent != null) {
        // 1. Check for URI permission grants to prevent URI permission bypass
        val hasUriPermissionGrants = (
            nestedIntent.flags and (
                Intent.FLAG_GRANT_READ_URI_PERMISSION or
                    Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                    Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or
                    Intent.FLAG_GRANT_PREFIX_URI_PERMISSION
                )
            ) != 0
        if (hasUriPermissionGrants) {
            throw SecurityException("Nested intent contains forbidden URI permission grant flags!")
        }

        val pm = packageManager
        val target = nestedIntent.resolveActivity(pm)
        if (target != null) {
            // 2. Verify target is within the same package
            if (target.packageName != packageName) {
                throw SecurityException("Cross-app intent redirection is forbidden!")
            }
            try {
                // 3. Verify target activity is exported
                val info = pm.getActivityInfo(target, 0)
                if (!info.exported) {
                    throw SecurityException("Target activity is private: ${target.className}")
                }
                // 4. Explicitly set the component to prevent intent interception
                nestedIntent.component = target
                // Safe to launch
                startActivity(nestedIntent)
            } catch (e: PackageManager.NameNotFoundException) {
                Log.e("Security", "Failed to resolve target activity", e)
            }
        }
    }
}
```

<br />

### 2. Safe intent redirection using IntentSanitizer

Filter or reject dynamic intents using AndroidX `IntentSanitizer` (AndroidX Core
1.9.0+).

- **Expected Inputs:**
  - An untrusted incoming `Intent`.
- **Expected Outputs:**
  - `Intent`: A sanitized copy containing only allowlisted components, categories, and actions. Throws `SecurityException` on violations if using `sanitizeByThrowing()`.


```kotlin
fun safeIntentRedirectionSanitizer() {
    val untrustedIntent = IntentCompat.getParcelableExtra(intent, "EXTRA_NESTED_INTENT", Intent::class.java)
    if (untrustedIntent != null) {
        // Define the strict boundaries for allowed redirection target
        val sanitizer = IntentSanitizer.Builder()
            .allowComponent(ComponentName("com.example.app", "com.example.app.SafeTargetActivity")) // Explicitly allowed target
            .allowAction(Intent.ACTION_VIEW) // Explicitly allowed actions
            .allowDataWithAuthority("com.example.app.provider") // Allowed URI authority
            .allowType("text/plain") // Allowed mime type
            .allowExtra("user_display_name", String::class.java) // Safe type-enforced extras
            // Note: URI permission flags are NOT allowed, so the sanitizer will automatically strip or throw on them
            .build()

        try {
            // Option A: Throws SecurityException if the intent violates policies
            val safeIntent = sanitizer.sanitizeByThrowing(untrustedIntent)
            startActivity(safeIntent)
        } catch (e: SecurityException) {
            Log.e("SECURITY_ALERT", "Attempted launch of non-allowlisted intent blocked", e)
        }

        // Option B: Silently filter and launch only the authorized parts (no exception thrown)
        // val filteredIntent = sanitizer.sanitizeByFiltering(untrustedIntent)
        // startActivity(filteredIntent)
    }
}
```

<br />

### 3. Custom signature permission protection

Declare a custom signature-level permission in the manifest to secure family app
communication.

- **Expected Inputs:** Manifest configuration.
- **Expected Outputs:** An activity that can only be launched by apps signed with the same developer certificate.


```xml
<permission
    android:name="com.example.snippets.permission.INTERNAL_COMMUNICATION"
    android:protectionLevel="signature" />
```

<br />


```xml
<activity
    android:name=".intents.InternalSharingActivity"
    android:exported="true"
    android:permission="com.example.snippets.permission.INTERNAL_COMMUNICATION">
    <intent-filter>
        <action android:name="com.example.snippets.ACTION_SHARE" />
        <category android:name="android.intent.category.DEFAULT" />
    </intent-filter>
</activity>
```

<br />

### 4. Safe onNewIntent lifecycle verification (warm boot protection)

Ensure that activities reusing dynamic intents (for example, in background
launch paths) apply the same strict security filters inside `onNewIntent`.

- **Expected Inputs:**
  - `newIntent` (`Intent`): The newly delivered intent.
- **Expected Outputs:**
  - Executes processing logic only if the new intent passes security validation.


```kotlin
override fun onNewIntent(newIntent: Intent) {
    super.onNewIntent(newIntent)

    // Set the intent to ensure intent returns the new one
    intent = newIntent

    // Validate the intent payload
    if (validateIntent(newIntent)) {
        processIntentPayload(newIntent)
    } else {
        Log.w("SECURITY_ALERT", "Received invalid or insecure intent during warm boot")
    }
}

private fun validateIntent(intent: Intent): Boolean {
    return intent.hasExtra("VALID_PAYLOAD_MARKER")
}
```

<br />

### 5. Secure PendingIntent creation

Enforce immutability unless mutability is explicitly required.

- **Expected Inputs (Immutable):** An intent target.
- **Expected Outputs (Immutable):** A `PendingIntent` that cannot be altered by the receiver.
- **Expected Inputs (Mutable):** An intent with an explicit component set.
- **Expected Outputs (Mutable):** A mutable `PendingIntent` locked to a specific receiver component to prevent hijacking.


```kotlin
fun createPendingIntents(context: Context) {
    // 1. Secure Immutable PendingIntent (Default)
    val intent = Intent(context, TargetActivity::class.java)
    val pendingIntent = PendingIntent.getActivity(
        context,
        0,
        intent,
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    )

    // 2. Secure Mutable PendingIntent (e.g., Notification Direct Reply)
    val mutableIntent = Intent().apply {
        // MUST set explicit target component to prevent redirection hijacking
        component = ComponentName(context, ReplyReceiver::class.java)
    }
    val mutablePendingIntent = PendingIntent.getBroadcast(
        context,
        0,
        mutableIntent,
        PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    )
}
```

<br />

### 6. Secure ContentProvider configuration and queries

Expose a ContentProvider securely and parameterize queries to prevent SQL
injection.

- **Expected Inputs:**
  - `uri` (`Uri`): The query URI.
  - `projection` (`String[]`): Columns to retrieve.
  - `selection` (`String`): Query criteria.
  - `selectionArgs` (`String[]`): Values mapping to selection placeholders (`?`).
- **Expected Outputs:**
  - `Cursor`: Filtered query results, strictly bound to projection maps.


```xml
<provider
    android:name=".intents.SecureDataProvider"
    android:authorities="com.example.snippets.provider"
    android:exported="true"
    android:readPermission="com.example.snippets.permission.READ_DATA"
    android:writePermission="com.example.snippets.permission.WRITE_DATA"
    android:grantUriPermissions="false" />
```

<br />


```kotlin
override fun query(
    uri: Uri,
    projection: Array<String>?,
    selection: String?,
    selectionArgs: Array<String>?,
    sortOrder: String?
): Cursor? {
    val queryBuilder = SQLiteQueryBuilder()
    queryBuilder.tables = tableName
    // Strict projection map to prevent querying unauthorized columns
    queryBuilder.projectionMap = mapOf(
        "_id" to "_id",
        "display_name" to "display_name"
    )
    // Enable strict validation (always available since minSdk is 36)
    queryBuilder.setStrict(true)
    queryBuilder.setStrictColumns(true)
    queryBuilder.setStrictGrammar(true)

    // MUST parameterize selection criteria; NEVER append selection strings directly
    val db = dbHelper.readableDatabase
    return queryBuilder.query(db, projection, selection, selectionArgs, null, null, sortOrder)
}
```

<br />

### 7. Service caller signature verification

Verify the calling application's signature before binding to a service.

- **Expected Inputs:**
  - `intent` (`Intent`): The binding request intent.
- **Expected Outputs:**
  - `IBinder`: Local binder instance if caller signature matches trusted partner; throws `SecurityException` otherwise.


```kotlin
class SecureBoundService : Service() {
    companion object {
        // Expected SHA-256 hash of the trusted app's signing certificate (Base64 encoded)
        private const val TRUSTED_PARTNER_SHA256 = "A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7R8S9T0U1V="
    }

    override fun onBind(intent: Intent): IBinder {
        // Return the binder. Do NOT perform signature verification in onBind() because
        // the binder connection is cached by Android, which can bypass checks on subsequent binds.
        return LocalBinder()
    }

    private fun enforceTrustedCaller() {
        val callingUid = Binder.getCallingUid()
        // Allow calls from the same application
        if (callingUid == Process.myUid()) {
            return
        }
        val pm = packageManager
        val packages = pm.getPackagesForUid(callingUid)

        if (packages.isNullOrEmpty() || !verifySignature(pm, packages[0])) {
            throw SecurityException("Access Denied: Caller signature is untrusted.")
        }
    }

    private fun verifySignature(pm: PackageManager, packageName: String): Boolean {
        try {
            val trustedSha256Raw = Base64.decode(TRUSTED_PARTNER_SHA256, Base64.DEFAULT)
            // API 28+ handles rotated certificates and avoids manual hashing.
            // Since minSdk is 36, this is always available.
            return pm.hasSigningCertificate(packageName, trustedSha256Raw, PackageManager.CERT_INPUT_SHA256)
        } catch (e: Exception) {
            Log.e("SECURITY_ERROR", "Verification failed for package: $packageName", e)
        }
        return false
    }

    inner class LocalBinder : Binder() {
        fun doSecureWork() {
            // Verify caller identity on every transaction method call
            enforceTrustedCaller()
            // Safe to proceed with sensitive operations
        }
    }
}
```

<br />

*** ** * ** ***

## Error handling

Handle component binding, database queries, and intent redirection failures
securely to avoid exposing internal structures.


```kotlin
fun safeErrorHandling(callingPackage: String?) {
    try {
        val payload = intent.getStringExtra("DATA_EXTRA") ?: throw IllegalArgumentException("Payload parameter missing.")
        // Create a specific target intent using the validated payload
        val targetIntent = Intent(this, TargetActivity::class.java).apply {
            putExtra("SECURE_PAYLOAD", payload)
        }
        startActivity(targetIntent)
    } catch (e: SecurityException) {
        // MUST log security violations for audit, but NEVER expose exception details to the user.
        Log.e("SECURITY_ERROR", "Unauthorized component transition blocked. Calling Package: ${callingPackage ?: "Unknown"}", e)
        // MUST provide generic user feedback.
        showFeedbackToUser("Process request failed: Access Denied.")
    } catch (e: IllegalArgumentException) {
        Log.w("INTEGRITY_WARNING", "Missing intent parameter", e)
    }
}
```

<br />

    // Secure handling of ContentProvider queries on the client side:
    try {
        val cursor = contentResolver.query(providerUri, projection, selection, selectionArgs, null)
    } catch (e: SQLiteException) {
        Log.e("PROVIDER_ERROR", "ContentProvider database query failed", e)
        // Secure handling: prevent raw query syntax details from leaking to UI
    }

*** ** * ** ***

## Reporting guidelines

When this skill is executed to apply security hardening updates to a codebase,
the agent **MUST** generate a structured "Best Practices and Security Alignment
Update" report for the developer. The report **must** be written to the session
artifact folder (or printed in the final response) and include:

1. **Security alignment area:** The category of improvement applied (for example, Safe Intent Redirection, Secure PendingIntent Configuration, ContentProvider Data Guarding).
2. **Impact and priority:** The potential safety risk addressed by the update (for example, Component Hijacking Prevention, Private Data Isolation).
3. **Scope of changes:** A list of all modified classes, XML files, and dependencies.
4. **Implementation summary:** Concrete details of the solution (for example, "Updated nested intent parsing to use the `IntentSanitizer` API with a strict component allowlist").
5. **Code diff:** Standard unified diffs showing the exact modifications.

### Best practices and security alignment update template

Use the following markdown template when reporting changes to developers:

    ### Best practices and security alignment update: [Security Alignment Area]

    *   **Improvement Description:** [Brief description of the hardening update and why it's recommended]
    *   **Priority Level:** [High / Medium / Low]
    *   **Alignment Action:** [Summary of updates, for example, converted to FLAG_IMMUTABLE]

    #### Files modified
    *   `[Relative path to File 1]`
    *   `[Relative path to File 2]`

    #### Implementation diff
    ```diff
    // Insert Unified Diff here

#### Testing and verification

1. \[Step 1 to verify the component behaves correctly, for example, run component unit test\]
2. \[Step 2 to verify regression safety\] \`\`\`

*** ** * ** ***

## Antipatterns

- **NEVER** launch a nested `Intent` received from an untrusted source without verifying its target package and exported status.
- **NEVER** use sticky broadcasts (`sendStickyBroadcast`).
- **NEVER** assume an exported component is safe because it runs in a background thread or performs internal checks.
- **NEVER** expose sensitive functionalities (like SSO authentication or payment processors) to components without signature-level permission restrictions.
- **NEVER** process incoming intents in `onNewIntent` without applying the same security controls as `onCreate`.
- **NEVER** create a mutable `PendingIntent` without setting an explicit target component in the base `Intent`.
- **NEVER** use dynamic string concatenation to construct selection blocks inside a `ContentProvider` query.
- **NEVER** use `Binder.getCallingUid` inside a `BroadcastReceiver.onReceive` to identify the sender of a broadcast, as it returns the receiver's own UID, not the sender's.

## Best Practices

- **MUST** explicitly set `android:exported="false"` for all components that don't need external communication.
- **MUST** protect all exported components with custom permissions utilizing `android:protectionLevel="signature"` when communicating between family apps.
- **MUST** validate all incoming intent extras and handle missing parameters gracefully to prevent crashes.
- **MUST** rely on the system's **Protected Broadcast** mechanism for system events (for example, boot completed, package changes), as the system prevents untrusted apps from spoofing these actions.
- **MUST** protect custom broadcasts with signature-level permissions or use `RECEIVER_NOT_EXPORTED` for dynamic receivers to restrict the sender identity.
- **MUST** call `setIntent(newIntent)` inside `onNewIntent()` before processing payloads to keep active references updated.
- **MUST** use `PendingIntent.FLAG_IMMUTABLE` by default when constructing `PendingIntent` instances.
- **MUST** protect exported `ContentProviders` with `readPermission` and `writePermission`.
- **MUST** enforce parameterized selection structures in `ContentProvider` query/update methods.
- **MUST** verify the package signature fingerprint of binding applications at runtime inside exported services.
- **MUST** use `androidx.core.content.IntentSanitizer` to sanitize incoming dynamic intents before redirection, if AndroidX Core 1.9.0+ is imported in the project.

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
