One of the benefits of using dependency injection frameworks like Hilt is that
it makes testing your code easier.

## Unit tests

Hilt isn't necessary for unit tests, since when testing a class that uses
constructor injection, you don't need to use Hilt to instantiate that class.
Instead, you can directly call a class constructor by passing in fake or mock
dependencies, just as you would if the constructor weren't annotated:

```kotlin
@ActivityScoped
class AnalyticsAdapter @Inject constructor(
  private val service: AnalyticsService
) { ... }

class AnalyticsAdapterTest {

  @Test
  fun `Happy path`() {
    // You don't need Hilt to create an instance of AnalyticsAdapter.
    // You can pass a fake or mock AnalyticsService.
    val adapter = AnalyticsAdapter(fakeAnalyticsService)
    assertEquals(...)
  }
}
```

The same applies to ViewModel classes obtained by calling `hiltViewModel()` in
your composables. In unit tests, construct the ViewModel directly with fakes.
For information on how state flows from a ViewModel into composables, see
[State and Jetpack Compose](https://developer.android.com/develop/ui/compose/state) and [Where to hoist state](https://developer.android.com/develop/ui/compose/state-hoisting).

## End-to-end tests

For integration tests, Hilt injects dependencies as it would in your production
code. Testing with Hilt requires no maintenance because Hilt automatically
generates a new set of components for each test.

### Adding testing dependencies

To use Hilt in your tests, include the `hilt-android-testing` dependency in your
project:

```kotlin
dependencies {
    // For Robolectric tests.
    testImplementation("com.google.dagger:hilt-android-testing:2.57.1")
    kspTest("com.google.dagger:hilt-android-compiler:2.57.1")

    // For instrumented tests.
    androidTestImplementation("com.google.dagger:hilt-android-testing:2.57.1")
    kspAndroidTest("com.google.dagger:hilt-android-compiler:2.57.1")

    // Compose UI test rule.
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    debugImplementation("androidx.compose.ui:ui-test-manifest")

}
```

> [!NOTE]
> **Note:** If you use [Jetpack integrations](https://developer.android.com/training/dependency-injection/hilt-jetpack) (like `hilt-navigation-compose` to obtain a ViewModel through `hiltViewModel()`), you must also add their annotation processors to your test dependencies.

### UI test setup

You must annotate any UI test that uses Hilt with `@HiltAndroidTest`. This
annotation is responsible for generating the Hilt components for each test.

Also, you need to add the `HiltAndroidRule` to the test class. It manages the
components' state and is used to perform injection on your test:

```kotlin
@HiltAndroidTest
class SettingsScreenTest {

    @get:Rule(order = 0)
    val hiltRule = HiltAndroidRule(this)

    @get:Rule(order = 1)
    val composeRule = createAndroidComposeRule<HiltTestActivity>()

    // Compose UI tests here.
}
```

> [!NOTE]
> **Note:** If you have other rules in your test, see [Multiple TestRule objects in
> your instrumented test](https://developer.android.com/training/dependency-injection/hilt-testing#multiple-testrules).

Next, your test needs to know about the `Application` class that Hilt
automatically generates for you.

To let Hilt inject dependencies, you must create an empty activity named
`HiltTestActivity` in your `androidTest` source set and annotate it with
`@AndroidEntryPoint`. `createAndroidComposeRule` then uses this activity as the
host for your composable content.

#### Test application

You must execute instrumented tests that use Hilt in an `Application` object
that supports Hilt. The library provides `HiltTestApplication` for use in tests.
If your tests need a different base application, see [Custom application for
tests](https://developer.android.com/training/dependency-injection/hilt-testing#custom-application).

You must set your test application to run in your [instrumented
tests](https://developer.android.com/training/testing/ui-testing) or [Robolectric
tests](http://robolectric.org/). The following instructions aren't
specific to Hilt, but are general guidelines on how to specify a custom
application to run in tests.

##### Set the test application in instrumented tests

To use the Hilt test application in [instrumented
tests](https://developer.android.com/training/testing/ui-testing), you need to configure a new test runner.
This makes Hilt work for all of the instrumented tests in your project. Perform
the following steps:

1. Create a custom class that extends [`AndroidJUnitRunner`](https://developer.android.com/reference/kotlin/androidx/test/runner/AndroidJUnitRunner) in the `androidTest` folder.
2. Override the `newApplication` function and pass in the name of the generated Hilt test application.

```kotlin
// A custom runner to set up the instrumented application class for tests.
class CustomTestRunner : AndroidJUnitRunner() {

    override fun newApplication(cl: ClassLoader?, name: String?, context: Context?): Application {
        return super.newApplication(cl, HiltTestApplication::class.java.name, context)
    }
}
```

Next, configure this test runner in your Gradle file as described in the
[instrumented unit test
guide](https://developer.android.com/training/testing/unit-testing/instrumented-unit-tests#setup). Make sure
you use the full classpath:

```kotlin
android {
    defaultConfig {
        // Replace com.example.android.dagger with your class path.
        testInstrumentationRunner = "com.example.android.dagger.CustomTestRunner"
    }
}
```

##### Set the test application in Robolectric tests

If you use Robolectric to test your UI layer, you can specify which application
to use in the `robolectric.properties` file:

`application = dagger.hilt.android.testing.HiltTestApplication`

Alternatively, you can configure the application on each test individually by
using Robolectric's `@Config` annotation:

```kotlin
@HiltAndroidTest
@Config(application = HiltTestApplication::class)
class SettingsScreenTest {

  @get:Rule
  var hiltRule = HiltAndroidRule(this)

  // Robolectric tests here.
}
```

### Testing features

Once Hilt is ready to use in your tests, you can use several features to
customize the testing process.

#### Inject types in tests

To inject types into a test, use `@Inject` for field injection. To tell Hilt to
populate the `@Inject` fields, call `hiltRule.inject()`.

See the following example of an instrumented test:

```kotlin
@HiltAndroidTest
class SettingsScreenTest {

    @get:Rule(order = 0)
    val hiltRule = HiltAndroidRule(this)

    @get:Rule(order = 1)
    val composeRule = createAndroidComposeRule<HiltTestActivity>()

    @Inject
    lateinit var analyticsAdapter: AnalyticsAdapter

    @Before
    fun init() {
        hiltRule.inject()
    }

    @Test
    fun settingsScreen_showsTitle() {
        composeRule.setContent {
            SettingsScreen()
        }
        composeRule.onNodeWithText("Settings").assertIsDisplayed()
        // analyticsRepository is available here.
    }
}
```

#### Replace a binding

If you need to inject a fake or mock instance of a dependency, you need to tell
Hilt not to use the binding that it used in production code and to use a
different one instead. To replace a binding, you need to replace the module that
contains the binding with a test module that contains the bindings that you want
to use in the test.

For example, suppose your production code declares a binding for
`AnalyticsService` as follows:

```kotlin
@Module
@InstallIn(SingletonComponent::class)
abstract class AnalyticsModule {

  @Singleton
  @Binds
  abstract fun bindAnalyticsService(
    analyticsServiceImpl: AnalyticsServiceImpl
  ): AnalyticsService
}
```

To replace the `AnalyticsService` binding in tests, create a new Hilt module in
the `test` or `androidTest` folder with the fake dependency and annotate it
with `@TestInstallIn`. All the tests in that folder are injected with the fake
dependency instead.

```kotlin
@Module
@TestInstallIn(
    components = [SingletonComponent::class],
    replaces = [AnalyticsModule::class]
)
abstract class FakeAnalyticsModule {

  @Singleton
  @Binds
  abstract fun bindAnalyticsService(
    fakeAnalyticsService: FakeAnalyticsService
  ): AnalyticsService
}
```

Because composables typically consume these dependencies indirectly through a
ViewModel obtained with `hiltViewModel()`, replacing the binding in Hilt is
enough. The composable under test picks up the fake automatically.

#### Replace a binding in a single test

To replace a binding in a single test instead of all tests, uninstall a Hilt
module from a test using the `@UninstallModules` annotation and create a new
test module inside the test.

Following the `AnalyticsService` example from the previous version, begin by
telling Hilt to ignore the production module by using the `@UninstallModules`
annotation in the test class:

```kotlin
@UninstallModules(AnalyticsModule::class)
@HiltAndroidTest
class SettingsScreenTest { ... }
```

Next, you must replace the binding. Create a new module within the test class
that defines the test binding:

```kotlin
@UninstallModules(AnalyticsModule::class)
@HiltAndroidTest
class SettingsScreenTest {

  @Module
  @InstallIn(SingletonComponent::class)
  abstract class TestModule {

    @Singleton
    @Binds
    abstract fun bindAnalyticsService(
      fakeAnalyticsService: FakeAnalyticsService
    ): AnalyticsService
  }

  // ...
}
```

This only replaces the binding for a single test class. If you want to replace
the binding for all test classes, use the `@TestInstallIn` annotation from the
section above. Alternatively, you can put the test binding in the `test` module
for Robolectric tests, or in the `androidTest` module for instrumented tests.
The recommendation is to use `@TestInstallIn` whenever possible.

> [!WARNING]
> **Warning:** You cannot uninstall modules that are not annotated with `@InstallIn`. Attempting to do so causes a compilation error.

> [!WARNING]
> **Warning:** `@UninstallModules` can only uninstall `@InstallIn` modules, not `@TestInstallIn` modules. Attempting to do so causes a compilation error.

> [!NOTE]
> **Note:** As Hilt creates new components for tests that use `@UninstallModules`, it can significantly impact unit test build times. Use it when necessary and prefer using `@TestInstallIn` when the bindings need to be replaced in all test classes.

#### Binding new values

Use the `@BindValue` annotation to easily bind fields in your test into the Hilt
dependency graph. Annotate a field with `@BindValue` and it will be bound under
the declared field type with any qualifiers that are present for that field.

In the `AnalyticsService` example, you can replace `AnalyticsService` with a
fake by using `@BindValue`:

```kotlin
@UninstallModules(AnalyticsModule::class)
@HiltAndroidTest
class SettingsScreenTest {

  @BindValue @JvmField
  val analyticsService: AnalyticsService = FakeAnalyticsService()

  ...
}
```

This simplifies both replacing a binding and referencing a binding in your test
by allowing you to do both at the same time.

`@BindValue` works with qualifiers and other testing annotations. For example,
if you use testing libraries such as
[Mockito](https://site.mockito.org/), you could use it in a
Robolectric test as follows:

```kotlin
...
class SettingsScreenTest {
  ...

  @BindValue @ExampleQualifier @Mock
  lateinit var qualifiedVariable: ExampleCustomType

  // Robolectric tests here
}
```

If you need to add a [multibinding](https://dagger.dev/dev-guide/multibindings),
you can use the `@BindValueIntoSet` and `@BindValueIntoMap` annotations in place
of `@BindValue`. `@BindValueIntoMap` requires you to also annotate the field
with a map key annotation.

## Special cases

Hilt also provides features to support nonstandard use cases.

### Custom application for tests

If you cannot use `HiltTestApplication` because your test application needs to
extend another application, annotate a new class or interface with
`@CustomTestApplication`, passing in the value of the base class you want the
generated Hilt application to extend.

`@CustomTestApplication` will generate an `Application` class ready for testing
with Hilt that extends the application you passed as a parameter.

```kotlin
@CustomTestApplication(BaseApplication::class)
interface HiltTestApplication
```

In the example, Hilt generates an `Application` named
`HiltTestApplication_Application` that extends the `BaseApplication` class. In
general, the name of the generated application is the name of the annotated
class appended with `_Application`. You must set the generated Hilt test
application to run in your [instrumented tests](https://developer.android.com/training/testing/ui-testing) or
[Robolectric tests](http://robolectric.org/) as described in [Test
application](https://developer.android.com/training/dependency-injection/hilt-testing#test-application).

> [!NOTE]
> **Note:** Because `HiltTestApplication_Application` is code that Hilt generates at runtime, the IDE might highlight it in red until you run your tests.

### Multiple TestRule objects in your instrumented test

Compose UI tests already combine `HiltAndroidRule` with a Compose test rule
such as `createAndroidComposeRule`. If you have additional `TestRule` objects,
make sure `HiltAndroidRule` runs first. Declare the execution order with the
`order` attribute on `@Rule`:

```kotlin
@HiltAndroidTest
class SettingsScreenTest {

  @get:Rule(order = 0)
  var hiltRule = HiltAndroidRule(this)

  @get:Rule(order = 1)
  val composeRule = createAndroidComposeRule<HiltTestActivity>()

  @get:Rule(order = 2)
  val otherRule = SomeOtherRule()

  // UI tests here.
}
```

Alternatively, you can wrap the rules with `RuleChain`, placing
`HiltAndroidRule` as the outer rule.

```kotlin
@HiltAndroidTest
class SettingsScreenTest {

  @get:Rule
  var rule = RuleChain.outerRule(HiltAndroidRule(this)).
        around(SettingsScreenTestRule(...))

  // UI tests here.
}
```

### Use an entry point before the singleton component is available

The `@EarlyEntryPoint` annotation provides an escape hatch when a Hilt entry
point needs to be created before the singleton component is available in a
Hilt test.

More information about `@EarlyEntryPoint` in the
[Hilt documentation](https://dagger.dev/hilt/early-entry-point).

## Additional resources

To learn more about testing, see the following additional resources:

### Documentation

- [Test your Compose layout](https://developer.android.com/develop/ui/compose/testing)
- [Testing cheatsheet](https://developer.android.com/develop/ui/compose/testing/testing-cheatsheet)

### Views content

- [Hilt testing guide (Views)](https://developer.android.com/topic/architecture/views/dependency-injection/hilt-testing-views)