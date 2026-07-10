Foldable devices introduce unique challenges for camera applications, including
dynamic layout changes, multiple display orientations, and physical device
postures, such as tabletop and book modes.

## Manage fold states and postures

| State | Posture | User interaction | Implementation goal |
|---|---|---|---|
| `FLAT` | Standard | Full screen preview | Conventional mobile phone layout. |
| `HALF_OPENED` | Tabletop | Lower half for controls | Split-screen layout, viewfinder on top, controls on bottom. |
| `HALF_OPENED` | Book | Side-by-side | Viewfinder on one panel, gallery and controls on the other. |

*** ** * ** ***

## Follow the implementation guide

### Detect posture changes

Use the Jetpack WindowManager library to observe the device's hinge state and
fold layout.


```kotlin
lifecycleScope.launch {
    lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
        windowInfoTracker.windowLayoutInfo(activity)
            .collect { layoutInfo ->
                val displayFeature = layoutInfo.displayFeatures
                    .filterIsInstance<FoldingFeature>()
                    .firstOrNull()

                updateCameraLayout(displayFeature)
            }
    }
}
```

<br />

### Handle tabletop mode

In Tabletop mode, horizontal fold, you should move the viewfinder to the top
half of the screen and the controls to the bottom half to prevent the user from
seeing a "bent" image.

- **Identify orientation:** Check `FoldingFeature.orientation`.
- **Calculate geometry:** Use `FoldingFeature.bounds` to identify the hinge's physical location on the screen.
- **Update UI:** Apply padding or constraints to move the `PreviewView` above the hinge.

### Coordinate mapping and `Viewport`

When the UI layout changes due to a fold, you **must** update the `Viewport` to
ensure that tap-to-focus and image capture coordinates remain accurate.


```kotlin
val viewport = ViewPort.Builder(Rational(viewfinder.width, viewfinder.height), display.rotation)
    .setScaleType(ViewPort.FILL_CENTER)
    .build()

val useCaseGroup = UseCaseGroup.Builder()
    .addUseCase(preview)
    .setViewPort(viewport)
    .build()
```

<br />

### Rear display mode

Some foldables allow using the rear camera with the cover display while the
device is unfolded.

- **Verification:** If available through OEM SDKs or Android 14 (API level 34) or higher, check `DeviceState.REAR_DISPLAY_STATE`.
- **Logic:** Handle preview detachment and reattachment on different display surfaces with varying aspect ratios.

*** ** * ** ***

## Foldable pitfalls

- **Hinge distortion:** Don't span the camera preview across a hinge in `HALF_OPENED` state.
- **Physical orientation:** The camera sensor's physical orientation relative to the screen often changes when you fold or unfold the device. Always rely on `CameraInfo.getSensorRotationDegrees`.
- **Latency:** Rebinding `UseCase` objects during a fold event is expensive. Use the internal scaling of `PreviewView` before performing a full `bindToLifecycle` reconfiguration.