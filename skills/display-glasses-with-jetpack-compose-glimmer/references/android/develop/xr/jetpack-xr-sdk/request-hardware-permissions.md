<br />


Applicable XR devices This guidance helps you build experiences for these types of XR devices. [Learn about XR device types →](https://developer.android.com/develop/xr/devices) ![](https://developer.android.com/static/images/develop/xr/ai-glasses-icon.svg) Audio \&  
Display Glasses [](https://developer.android.com/develop/xr/devices#audio-display) [Learn about XR device types →](https://developer.android.com/develop/xr/devices)

<br />

Just like on a phone, accessing sensitive hardware like the camera and
microphone on audio glasses and display glasses requires explicit user consent.
These are considered
**glasses-specific permissions**, and your app must request them at runtime,
even if it already has the corresponding permissions on the phone.

## Declare the permissions in your app's manifest

Before requesting permissions, you must [declare them in your app's manifest](https://developer.android.com/training/permissions/declaring)
file using the [`<uses-permission>`](https://developer.android.com/guide/topics/manifest/uses-permission-element) element. This declaration remains the
same whether the permission is for a phone or a glasses-specific feature, but
you must still explicitly request it for glasses-specific hardware or
functionality.

    <manifest ...>
        <!-- Only declare permissions that your app actually needs. In this example,
        we declare permissions for the camera. -->
        <uses-permission android:name="android.permission.CAMERA"/>
        <application ...>
            ...
        </application>
    </manifest>

## Register the permissions launcher

To request permissions for audio glasses and display glasses, first you use the
[`ActivityResultLauncher`](https://developer.android.com/reference/kotlin/androidx/activity/result/ActivityResultLauncher) with the [`ProjectedPermissionsResultContract`](https://developer.android.com/reference/kotlin/androidx/xr/projected/permissions/ProjectedPermissionsResultContract#ProjectedPermissionsResultContract())
method to register the permissions launcher.


```kotlin
// Register the permissions launcher using the ProjectedPermissionsResultContract.
private val requestPermissionLauncher: ActivityResultLauncher<List<ProjectedPermissionsRequestParams>> =
    registerForActivityResult(ProjectedPermissionsResultContract()) { results ->
        if (results[Manifest.permission.CAMERA] == true) {
            isPermissionDenied = false
            initializeGlassesFeatures()
        } else {
            // Handle permission denial.
            isPermissionDenied = true
        }
    }
```

<br />

### Key points about the code

- The code creates an [`ActivityResultLauncher`](https://developer.android.com/reference/kotlin/androidx/activity/result/ActivityResultLauncher) using the [`ProjectedPermissionsResultContract`](https://developer.android.com/reference/kotlin/androidx/xr/projected/permissions/ProjectedPermissionsResultContract#ProjectedPermissionsResultContract()) method. The callback receives a map of permission names to their granted status.
- You need to specify which permissions your app requires, such as [`Manifest.permission.CAMERA`](https://developer.android.com/reference/kotlin/android/Manifest.permission#camera) or [`Manifest.permission.RECORD_AUDIO`](https://developer.android.com/reference/kotlin/android/Manifest.permission#record_audio).

## Create the request function

Next, you'll create a function that uses your app's permissions launcher to
request the permissions from the user at runtime.


```kotlin
private fun requestHardwarePermissions() {
    val params = ProjectedPermissionsRequestParams(
        permissions = listOf(Manifest.permission.CAMERA),
        rationale = "Camera access is required to overlay digital content on your physical environment."
    )
    requestPermissionLauncher.launch(listOf(params))
}
```

<br />

### Key points about the code

- The `requestHardwarePermissions` function builds a [`ProjectedPermissionsRequestParams`](https://developer.android.com/reference/kotlin/androidx/xr/projected/permissions/ProjectedPermissionsRequestParams) object. This object bundles the list of permissions your app needs and the user-facing rationale. Make the rationale clear and concise to explain why your app needs these permissions.
- Calling `launch` on the launcher triggers the [permission request user
  flow](https://developer.android.com/develop/xr/jetpack-xr-sdk/request-hardware-permissions#permissions-user-flow).
- Your app should handle both granted and denied results gracefully in the launcher's callback.

## Create the permissions check function

Next, you'll create a function that can check whether the user has granted
permissions to your app.


```kotlin
private fun hasCameraPermission(): Boolean {
    return ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED
}
```

<br />

## Add the permission request logic

And lastly, create the logic that uses these functions to check for and request
the permissions at runtime.


```kotlin
if (hasCameraPermission()) {
    initializeGlassesFeatures()
} else {
    requestHardwarePermissions()
}
```

<br />

### Key points about the code

- If the user has already granted your app the required permissions, the `initializeGlassesFeatures` function is called to initialize your app's experience. This function is defined as [part of your app's activity for AI
  glasses](https://developer.android.com/develop/xr/jetpack-xr-sdk/glasses/first-activity#create-activity).

## Understand the permission request user flow

When you launch a permission request using the
[`ProjectedPermissionsResultContract`](https://developer.android.com/reference/kotlin/androidx/xr/projected/permissions/ProjectedPermissionsResultContract#ProjectedPermissionsResultContract()) method, the system initiates a
coordinated user flow across both the glasses and the phone.

<br />

> [!IMPORTANT]
> **Important:** You should call the `ProjectedPermissionsResultContract` method from an [`Activity`](https://developer.android.com/reference/kotlin/android/app/Activity) displayed on the glasses. Don't use the standard Android permission APIs (such as [`requestPermissions`](https://developer.android.com/reference/kotlin/androidx/core/app/ActivityCompat#requestPermissions(android.app.Activity,%20java.lang.String%5B%5D,%20int)) with [`ActivityResultLauncher<String>`](https://developer.android.com/reference/kotlin/androidx/activity/result/ActivityResultLauncher)) in code running on the glasses. Doing so attempts to launch a non-interactable permission dialog on the glasses, breaking the user flow.
>
> <br />
>
> If your app already has an `Activity` displayed on the phone, you should use
> [`Activity#requestPermissions(permissions, requestCode, deviceId)`](https://developer.android.com/reference/kotlin/android/app/Activity#requestpermissions_1), where
> the `deviceId` comes from calling the [`getDeviceId`](https://developer.android.com/reference/kotlin/android/content/Context#getdeviceid) method on the
> [`Context`](https://developer.android.com/reference/kotlin/android/content/Context) returned by calling
> [`ProjectedContext.createProjectedDeviceContext`](https://developer.android.com/reference/kotlin/androidx/xr/projected/ProjectedContext#createProjectedDeviceContext(android.content.Context)).
>
> <br />
>
<br />

During the permissions user flow, here is what your app and the user can expect:

1. **On the glasses** : An activity appears on the **projected device
   (glasses)**, instructing the user to look at their phone to continue.

   <br />

   > [!WARNING]
   > **Preview:** Currently, the instructions and rationale provided by the system are not audible to the user. To provide an audible rationale to the user, we recommend using [Text to Speech
   > (TTS)](https://developer.android.com/develop/xr/jetpack-xr-sdk/tts). For example:
   >
   > <br />
   >
   >     tts?.speak("Please review the permission request on your host device",
   >     TextToSpeech.QUEUE_ADD,
   >     null,
   >     "permission_request")
   >
   > <br />
   >
   <br />

2. **On the phone** : Concurrently, an activity launches on the **host device
   (phone)**. This screen displays the rationale string you provided and gives
   the user the option to proceed or cancel.

3. **On the phone** : If the user accepts the rationale, a modified Android
   system permission dialog appears on the phone telling the user that they are
   granting the permission **for the glasses** (not the phone), and the user
   can formally grant or deny the permission.

4. **Receiving the result** : After the user makes their final choice, the
   activities on both the phone and glasses are dismissed. Your
   [`ActivityResultLauncher`](https://developer.android.com/reference/kotlin/androidx/activity/result/ActivityResultLauncher) callback is then invoked with a map containing
   the granted status for each requested permission.