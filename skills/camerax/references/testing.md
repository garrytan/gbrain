Automated testing for camera features is notoriously difficult because you
can't easily mock physical hardware, lighting, or motion. This guide provides
patterns for reliable, hermetic camera tests.

## Develop a testing mindset

| Challenge | Conventional approach | Camera technical approach |
|---|---|---|
| **Frameworks** | `Mockito` or `MockK` | **Fakes over mocks** |
| **Assertions** | `assertEquals`, `assertTrue` | **Google Truth, `assertThat`** |
| **Environment** | Implied environments | **Explicit `@RunWith` annotations** |
| **Async operations** | `Thread.sleep` | **Explicit `timeoutMillis` or `IdlingResource`** |

*** ** * ** ***

## Follow the implementation guide

### Fakes over mocks

**Don't use Mockito.** Relying on mocks for complex, rapidly changing interfaces
like `ImageProxy` or `CameraInfo` makes tests brittle. Instead, build "Fake"
implementations that verify state rather than behavior.


```kotlin
// Create a Fake ImageProxy for ML Testing (Fakes over Mocks)
val fakeImage = FakeImageProxy(w = 640, h = 480)

// Feed the fake buffer into your analyzer
```

<br />

### Mock camera capabilities

Use `FakeAppConfig` from `androidx.camera:camera-testing` to simulate specific
hardware constraints in tests, such as a device without a flash.


```kotlin
// Use awaitInstance() extension function for coroutine-based provider retrieval
val cameraProvider = ProcessCameraProvider.awaitInstance(context)
```

<br />

### Use Truth assertions

Use Google Truth, `assertThat`, instead of standard JUnit assertions. It
provides more readable assertion chains and useful failure messages.

### Test asynchronous lifecycles

Camera initialization is asynchronous. Use `IdlingResource` to ensure
your test waits for the `UseCase` to be bound before asserting.

To test asynchronous lifecycles, use the following pattern:

1. Wrap the `ProcessCameraProvider` initialization in a `CountDownLatch` or `IdlingResource`.
2. Assert only after the `cameraControl` instance is non-null.

*** ** * ** ***

## Testing pitfalls

- **Resource leaks** : To prevent "Camera in Use" errors, in your `@After` block, call `cameraProvider.unbindAll`.
- **The "flaky initializer"**: Camera tests often fail on CI because the "Virtual Camera" takes too long to warm up. Use a sufficient explicit timeout for the first initialization.
- **Permission blockers** : To bypass the system permission dialogs, in your Espresso tests, use `GrantPermissionRule`.
- **Resolution mismatch** : Tests on emulators often default to 640x480. Ensure your `ResolutionSelector` handles this low-res fallback correctly.