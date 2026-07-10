Developing camera features for XR devices, headsets, and AR glasses requires a
shift from 2D pixel-pushing to 3D spatial awareness.

## Understand the XR development mindset

| Concept | Mobile focus | **XR focus** |
|---|---|---|
| **Input** | Raw camera stream | **Spatial tracking (visual-inertial odometry (VIO) or simultaneous localization and mapping (SLAM))** |
| **Output** | Screen viewfinder | **Stereo passthrough and occlusion** |
| **Constraint** | Battery life | **Motion-to-photon latency (less than 20 ms)** |

*** ** * ** ***

## Follow the implementation guide

### API selection

On XR devices, standard `CameraX` implementations are often restricted or
insufficient. Always use spatial software development kits (SDKs):

- **ARCore**: Use ARCore for plane detection, depth sensing, and motion tracking.
- **OpenXR**: Use OpenXR as the cross-platform standard for VR and AR rendering and input.
- **OEM SDKs**: Use manufacturer-specific libraries for hardware-accelerated passthrough.

### Handle spatial passthrough

Unlike a 2D viewport, XR passthrough is often system-managed.

**\[Key requirement\] Frame synchronization**: Synchronize your application's
frame clock with the headset's head-mounted display (HMD) pose.

```kotlin
// Example: Querying the spatial pose for the current camera frame
val headPose = xrSession.getHeadPose(frameTime)
val projectionMatrix = headPose.getProjectionMatrix(eyeIndex)
```

<br />

### Manage depth and occlusion

Digital content must respect real-world depth to ensure accurate occlusion.

- **Depth map** : Access raw depth data using `ARCore` or `SurfaceProcessor` to create an occlusion mask.
- **Hardware buffers** : Use `HardwareBuffer` to share camera frames directly with the GPU without CPU-side copies to minimize latency.

*** ** * ** ***

## XR pitfalls

- **The nausea limit**: Any processing that delays the viewfinder by more than 20 ms causes user sickness. Don't perform image processing on the main thread.
- **Privacy restrictions** : Some XR devices return a black frame if you attempt to record the "Passthrough" layer. Check `Session.isRecordingSupported`.
- **Field of view (FOV)**: The camera FOV possibly doesn't match the display FOV. Use the SDK's projection matrixes instead of calculating aspect ratios manually.
- **Front buffer rendering** : If the device supports it, use `FrontBufferRenderer` for real-time overlays to bypass standard double-buffering latency.