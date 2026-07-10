Always prefer these various abstractions over legacy Camera2 or early CameraX
implementations.

## Compare APIs

| Use case | Legacy or verbose way | Recommendation |
|---|---|---|
| QR or face scanning | `ImageAnalysis.Analyzer` and manual ByteBuffer math | **`MlKitAnalyzer`**, which automates coordinate mapping and multi-format support |
| Post-processing | Custom OpenGL shaders or `SurfaceTexture` | **`Media3Effect`** for composable, declarative effects |
| Dual camera | Manual binding of two UseCases | **`ConcurrentCamera`**, which provides built-in support in CameraX 1.3 and higher |
| High dynamic range | Manual bit-depth and profile config | **`DynamicRange`** , which uses `DYNAMIC_RANGE_HLG10` or `SDR` |
| Zoom and focus | `Camera2Interop` for CameraX-to-Camera2 mapping | **`CameraControl.setZoomRatio`** or **`setLinearZoom`** |

## Hardware awareness

Modern APIs abstract away the complexity of hardware diversity.

- **`CameraSelector`** : Use `DEFAULT_BACK_CAMERA` or `DEFAULT_FRONT_CAMERA` instead of hardcoding camera IDs. Use `filter` if you need specific lens capabilities.
- **Extensions** : Before enabling advanced modes, such as night, bokeh, and face retouch, use `ExtensionsManager` to query whether the device supports them.
- **Foldables** : Observe `Lifecycle` and `Viewport` updates to handle posture changes, like a half-opened posture, on foldable devices.

## Required dependencies

Add the following dependencies to your `libs.versions.toml` file:

    # CameraX ML Kit

    androidx-camera-mlkit-vision = { group = "androidx.camera", name =
    "camera-mlkit-vision", version.ref = "camerax" }

    # Media3 effects

    androidx-media3-effect = { group = "androidx.media3", name = "media3-effect",
    version.ref = "media3" }

    # Camera extensions

    androidx-camera-extensions = { group = "androidx.camera", name =
    "camera-extensions", version.ref = "camerax" }

Refer to the official [CameraX Release Notes](https://developer.android.com/jetpack/androidx/releases/camera) for the
stable versions.