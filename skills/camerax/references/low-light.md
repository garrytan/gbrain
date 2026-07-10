This guide covers implementing low-light features using **Night mode
extensions** and **Low Light Boost (LLB)**.

## Choosing the right tool

| Feature | Used for | Implementation | UX impact |
|---|---|---|---|
| **Night mode** | High-quality stills | `ExtensionsManager` | Possibly requires user to hold still for several seconds. |
| **LLB, AE mode** | Real-time preview or video | `Camera2Interop`, CameraX utility | Hardware drops the frame rate to increase brightness. |
| **LLB, Play services** | Real-time preview and video | `SurfaceProcessor` | Software-based brightening; maintains a higher frame rate. |

*** ** * ** ***

## Night mode extension

CameraX Extensions provide access to the device's built-in computational
photography pipeline.

### Basic setup

To set up the extension, initialize the extension manager:


```kotlin
// Use ListenableFuture.await() extension function for coroutine support
val extensionsManager = ExtensionsManager.getInstanceAsync(context, cameraProvider).await()
if (extensionsManager.isExtensionAvailable(cameraSelector, ExtensionMode.NIGHT)) {
    val nightSelector = extensionsManager.getExtensionEnabledCameraSelector(
        cameraSelector, ExtensionMode.NIGHT
    )
    cameraProvider.bindToLifecycle(lifecycleOwner, nightSelector, imageCapture, preview)
}
```

<br />

### Comprehensive features

- **Image postview** : Display a low-resolution image immediately while the multi-frame processing occurs.

  ```kotlin
  val imageCapture = ImageCapture.Builder()
      .setPostviewEnabled(true)
      .build()
  ```
- **Extension strength** : Let users control the intensity of the night effect.

  ```kotlin
  // Set the strength of the active extension (e.g. NIGHT mode intensity)
  val extensionsManager = ExtensionsManager.getInstanceAsync(context, cameraProvider).await()
  val extensionsControl = extensionsManager.getCameraExtensionsControl(camera.cameraControl)
  extensionsControl?.setExtensionStrength(strength)
  ```
- **Capture progress** : Show a UI progress bar for long exposures.

  ```kotlin
  // Use the suspend extension function for takePicture to avoid callback boilerplate
  try {
      val result = imageCapture.takePicture(outputOptions)
      // Use result.savedUri or other fields
  } catch (e: ImageCaptureException) {
      // Handle capture failure
  }
  ```

*** ** * ** ***

## Low-light boost

LLB is designed for preview and video streams where you prefer high frame rates.

### AE mode

The built-in CameraX way to prioritize brightness. It modifies the hardware's
auto-exposure algorithm.

- **Activation** : Use `CameraControl.enableLowLightBoostAsync`.
- **Implementation** :

  ```kotlin
  // Enable Low Light Boost (LLB) natively in CameraX 1.4+
  camera.cameraControl.enableLowLightBoostAsync(true)
  ```
- **Monitoring** : Observe `CameraInfo.lowLightBoostState` to track when the hardware actively applies the enhancement.

### Google Play services LLB

It's a multi-step implementation that uses a session-based `SurfaceProcessor`.

**Dependency** : `com.google.android.gms:play-services-camera-low-light-boost`

To implement Google Play services LLB, follow these core steps:

1. **Initialize client** : `val client = LowLightBoost.getClient`.
2. **Implement `SurfaceProcessor`** :
   - **Manage session** : Call `client.createSession`.
   - **Forward required metadata** : Observe the camera's `TotalCaptureResult` stream and forward every result to the session: `session.processCaptureResult`.
   - **Provide surface** : Get the input surface from the session, `session.getCameraSurface`, and provide it to the camera's `SurfaceRequest`.
   - **Lifecycle** : Release the session, `session.release`, when the processor is closed or the `SurfaceRequest` completes.
3. **Wire using `CameraEffect`** :

   ```kotlin
   val effect = SimpleCameraEffect(
       CameraEffect.PREVIEW or CameraEffect.VIDEO_CAPTURE,
       executor,
       llbSurfaceProcessor
   ) { throw it }

   // Add to UseCaseGroup
   val useCaseGroup = UseCaseGroup.Builder()
       .addUseCase(preview)
       .addUseCase(videoCapture)
       .addEffect(effect)
       .build()
   ```
4. **Scene detection** : Use `session.setSceneDetectorCallback` to receive `boostStrength` updates for real-time UI indicators.

*** ** * ** ***

## Implementation notes

- **Thread safety** : Always handle `ExtensionsManager` and `LowLightBoostClient` initialization asynchronously.
- **FPS trade-offs**: AE mode LLB often drops the frame rate significantly to increase brightness.
- **Compatibility** : Extensions, Night Mode, possibly conflict with `ConcurrentCamera`. Always verify support before binding.