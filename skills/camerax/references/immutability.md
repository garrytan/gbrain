Many Android APIs are designed with immutability in mind to prevent race
conditions in async environments. However, this often trips up developers used
to mutable builder patterns.

## Common immutable classes

The following classes use fluent APIs that **return a new instance**. You must
reassign the variable.

| Class | Methods that return a new instance | Result if not reassigned |
|---|---|---|
| `PendingRecording` | `withAudioEnabled`, `asPersistentRecording` | Audio isn't recorded. |
| `ImageCapture.Builder` | `setTargetRotation`, `setTargetResolution` | The output has the wrong orientation. |
| `Recorder.Builder` | `setQualitySelector`, `setExecutor` | The recording uses the default quality. |
| `Viewport.Builder` | `setScaleType`, `setLayoutDirection` | The viewfinder is stretched. |

## Use standard patterns

### CameraX video recording

To set up video recording, use the following code:


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

### Viewport construction

To set up the viewport, use the following code:


```kotlin
val viewport = ViewPort.Builder(Rational(width, height), displayRotation)
    .setScaleType(ViewPort.FILL_CENTER)
    .build()
```

<br />