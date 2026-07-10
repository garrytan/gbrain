Camera operations are among the most power-intensive tasks on mobile devices.
Without proactive management, the system throttle hardware, drop frames, or
force-close the camera app.

## The thermal management strategy

| Priority | Strategy | Implementation |
|---|---|---|
| **1. Inform** | Use case hints | Provide `StreamUseCase` to allow the OS to optimize hardware. |
| **2. Monitor** | Thermal state listener | Observe `PowerManager.addThermalStatusListener`. |
| **3. Act** | Graceful degradation | Dynamically reduce FPS, resolution, or disable demanding effects such as HDR. |

*** ** * ** ***

## Follow the implementation guide

### Stream use case optimization

Android 13 (API level 33) introduced `StreamUseCase`. This is the **single most
effective** way to tell the hardware how to balance quality versus power.


```kotlin
// In CameraX: Set the hint on your Use Case
val preview = Preview.Builder()
    .setTargetName("Preview")
    .apply {
        Camera2Interop.Extender(this).setStreamUseCase(
            CameraMetadata.SCALER_AVAILABLE_STREAM_USE_CASES_VIDEO_CALL.toLong()
        )
    }
    .build()
```

<br />

Review the following key use cases for stream optimization:

- `PREVIEW`: This option is the default and provides a balanced configuration.
- `STILL_CAPTURE`: This option provides high-quality capture for short bursts.
- `VIDEO_RECORD`: This option maintains sustained power and is optimized for encoding.
- `VIDEO_CALL`: This option minimizes power consumption for long-duration sessions.

### Monitor thermal status

Don't wait for a crash. Monitor the `PowerManager` status and react before
`THERMAL_STATUS_CRITICAL`.


```kotlin
val powerManager = context.getSystemService(Context.POWER_SERVICE) as PowerManager
powerManager.addThermalStatusListener { status ->
    when (status) {
        PowerManager.THERMAL_STATUS_MODERATE -> {
            // Signal to UI: "Device is warming up"
        }
        PowerManager.THERMAL_STATUS_SEVERE -> {
            // ACTION: Reduce Frame Rate from 60fps to 30fps
            // ACTION: Disable HDR or High-Quality Post-processing
        }
        PowerManager.THERMAL_STATUS_CRITICAL -> {
            // ACTION: Close the camera session to prevent hardware damage
        }
    }
}
```

<br />

### Graceful degradation tiers

| Tier | Action | User impact |
|---|---|---|
| **Mild** | Stop background analysis using ML Kit | Minimal |
| **Moderate** | Cap frame rate to 30 FPS | Noticeable but smooth |
| **Severe** | Drop resolution from 1080p to 720p | Significant visual change |
| **Critical** | Shut down the session | App unusable in safe mode |

*** ** * ** ***

## Thermal pitfalls

- **The "double work" bug**: Don't run two high-resolution streams---such as a preview and a video capture stream---at different aspect ratios unless necessary. This forces the image signal processor (ISP) to perform double the scaling work, which generates excessive heat.
- **Surface overload** : Don't use multi-step `SurfaceProcessor` or `Media3Effect` chains during `THERMAL_STATUS_SEVERE`.
- **Flash heat** : Flash or torch usage generates high thermal load. Proactively disable the flash if thermal status is `SEVERE`.