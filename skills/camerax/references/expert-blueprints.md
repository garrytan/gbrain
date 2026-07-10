Complex camera features often fail due to "Agent Stall" or timeouts when
attempted in a single turn. Use these blueprints to break tasks into manageable
phases.

## Manual controls

### Phase one: ViewModel and state

1. Define a `ManualSettings` data class.
2. Add a `MutableStateFlow<ManualSettings>` to your `CameraViewModel`.
3. Implement the Jetpack Compose UI with sliders and switches to update this flow.

### Phase two: Controller wiring

1. In `CameraController.kt`, create a new function `updateManualSettings(settings: ManualSettings)`.
2. Map these settings into the `CameraSystem` layer.

### Phase three: CameraX `Camera2Interop` wiring

1. In `CameraSession.kt`, use the `Camera2Interop.Extender` utility to access Camera2 capture request keys.
2. Apply the hardware keys:
   - `CaptureRequest.SENSOR_SENSITIVITY` to set ISO sensitivity.
   - `CaptureRequest.SENSOR_EXPOSURE_TIME` to set exposure time.
   - `CaptureRequest.LENS_FOCUS_DISTANCE` to set focus distance.
3. **Critical** : If manual exposure is active, set `CaptureRequest.CONTROL_AE_MODE` to `CameraMetadata.CONTROL_AE_MODE_OFF`. ---

## RAW and JPEG capture

### Phase one: Output configuration

1. Verify device support for RAW capture using `CameraInfo`.
2. Configure `ImageCapture.Builder` with `OUTPUT_FORMAT_RAW_JPEG` or `OUTPUT_FORMAT_RAW`.

### Phase two: Implementation

1. Provide `ImageCapture.OutputFileOptions` for the target storage locations.
2. Invoke `takePicture`. CameraX internally manages `DngCreator` to wrap RAW data with the required `CameraCharacteristics` and `CaptureResult` metadata.

*** ** * ** ***

## Apply image effects

### Phase one: Effects selection

1. Use the `androidx.media3:media3-effect` dependency.
2. Use `RgbFilter` or `HslAdjustment` for standard color grading.

### Phase two: Application

1. Configure `Composition.Builder` or `MediaItem.Builder` with the list of effects.
2. Inject the list of effects into the CameraX `Recorder` or `Preview` using the `setEffects` method.

*** ** * ** ***

## Low-light capture

For guidance on Night Mode Extensions and Low Light Boost,
[low-light.md](https://developer.android.com/agents/skills/camera/camerax/references/low-light).