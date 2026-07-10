---
name: camerax
description: Provide technical guidance for Android camera development with CameraX.
  Use when implementing camera features, handling asynchronous recording lifecycles,
  wiring low-level hardware interop using CameraX, or integrating ML Kit or Media3
  effects.
license: Complete terms in LICENSE.txt
metadata:
  author: Google LLC
  last-updated: '2026-07-02'
  keywords:
  - recipe
  - Android
  - Camera
  - Camera1
  - Camera2
  - CameraX
  - migration
  - Compose
  - guide
  - dependencies
  - PreviewView
  - CameraXViewfinder
  - ImageCapture
  - VideoCapture
  - ImageAnalysis.
triggers:
  - android
  - jetpack
  - compose
---

This skill provides procedural guidance and standard patterns for building
camera applications on Android, with a focus on CameraX, including its
`Camera2Interop` utilities, and Media3 integrations.

## Core workflows

### Handling immutable API patterns

Various Android camera and media APIs, especially CameraX `VideoCapture`, use a
**fluent, immutable builder-like pattern** where methods return a new instance.
Failing to reassign these results in settings, such as audio, being ignored.

**Pattern: Reassignment is required**


```kotlin
// WRONG
run {
  val pending = recorder.prepareRecording(context, opts)
  pending.withAudioEnabled() // This returns a new instance which is ignored
  val active = pending.start(exec, listener)
}

// CORRECT
run {
  val pending = recorder.prepareRecording(context, opts)
      .withAudioEnabled() // Chaining works
  val active = pending.start(exec, listener)
}

// ALSO CORRECT
run {
  var pending = recorder.prepareRecording(context, opts)
  pending = pending.withAudioEnabled() // Reassignment
  val active = pending.start(exec, listener)
}
```

<br />

See [immutability](references/immutability.md) for a list of affected classes.

### Comprehensive feature blueprinting

For multi-step features that involve multiple files and hardware-level wiring,
follow the [Structural Blueprinting](references/expert-blueprints.md) approach to avoid
system timeouts. Such complex features include:

- **Manual controls** : Break down into the `ViewModel` state, the controller layer, and the `Camera2Interop` wiring in the session.
- **RAW capture**: Separate JPEG and RAW output configurations into discrete build steps.
- **Custom effects** : Prefer `Media3Effect` or `SurfaceProcessor` over manual OpenGL pipelines unless absolute performance is required.
- **Low-light** : See [low-light](references/low-light.md) for Night Mode and LLB guidance.
- **Foldables** : See [foldables](references/foldables.md) for handling dynamic postures and hinge states.
- **XR, AR, and VR** : See [xr](references/xr.md) for spatial tracking, passthrough synchronization, and latency guardrails.
- **Thermals and power** : See [thermals](references/thermals.md) for managing `StreamUseCase` optimizations and `PowerManager` thermal states.
- **Testing and mocking** : See [testing](references/testing.md) for using `FakeCameraConfig`, handling asynchronous lifecycles, and validating analysis pipelines.
- **ML Kit spatial analysis** : See [mlkit-spatial](references/mlkit-spatial.md) for coordinate mapping, rotation logic, and mirrored lens handling.
- **Wear OS camera remote** : See [wear-os](references/wear-os.md) for circular UI constraints, Data Layer API syncing, and remote trigger logic.

See [expert-blueprints](references/expert-blueprints.md) for step-by-step guides.

### API discovery

Always use higher-level abstractions instead of low-level manual wiring:

- **Analysis** : Use `MlKitAnalyzer` instead of manual `ImageAnalysis.Analyzer`.
- **Filters and effects** : Use `Media3Effect` for standard post-processing.
- **Multi-camera** : Use `ConcurrentCamera` APIs for dual-stream setups.

See [modern-apis](references/modern-apis.md) for current recommendations.

### Code quality and architectural rules

Adhere to the following Android ecosystem standard patterns when building your
camera implementations:

- **Testing, fakes over mocks** : Avoid mocking libraries like `Mockito`, especially for multi-step CameraX interfaces like `ImageProxy`. Build "Fakes" to verify state rather than unreliable implementation details.
- **Google Truth assertions** : Use `assertThat` over standard `JUnit` assertions like `assertEquals` for improved readability.
- **Explicit test runners** : Always define an explicit `@RunWith` for test classes to ensure the CI environment executes them correctly.
- **Semantic UI merging** : When building custom camera controls in Compose, such as a button with an `Icon` and `Text`, use `semantics {
  mergeDescendants = true }` to ensure screen readers announce them as a single, coherent unit.

## Hardware and device diversity

Camera apps run on a wide variety of hardware, from mobile phones and
foldables to tablets, laptops, and even smart appliances. Have consideration
for the specific hardware the app is running on.

- **Form factors**: Account for screen size and orientation changes on foldables and tablets.
- **Multi-camera arrays**: Some devices have a rear-facing camera and a front-facing camera. Other devices have multiple rear-facing cameras, such as wide-angle and telephoto lenses.
- **Feature parity**: Features like flash or auto-focus behave differently across hardware. For example, CameraX handles both physical flash, back, and screen-based flash, front, and both must be considered when implementing flash functionality.

## Common pitfalls

- **Asynchronous lifecycles** : Check `isRecording` state before attempting to stop or pause. Handle `VideoRecordEvent.Start` for UI state updates, not just the initial call.
- **Thread safety**: Camera callbacks often run on background executors. Dispatch UI updates on the main thread.
- **Permission handling** : Check `CAMERA` permission; check for `RECORD_AUDIO` specifically when enabling audio in `VideoCapture`.

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
