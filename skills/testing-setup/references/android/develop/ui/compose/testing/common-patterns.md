[Video](https://www.youtube.com/watch?v=Y9GWnwi9D0I)

You can test your Compose app with well-established approaches and patterns.

### Test in isolation

[`ComposeTestRule`](https://developer.android.com/reference/kotlin/androidx/compose/ui/test/junit4/ComposeTestRule) lets you start an activity displaying any composable:
your full application, a single screen, or a small element. It's also a good
practice to check that your composables are correctly encapsulated and they work
independently, allowing for easier and more focused UI testing.

This doesn't mean you should *only* create unit UI tests. UI tests scoping
larger parts of your UI are also very important.

### Access the activity and resources after setting your own content

Oftentimes you need to set the content under test using
`composeTestRule.setContent` and you also need to access activity resources, for
example to assert that a displayed text matches a string resource. However, you
can't call `setContent` on a rule created with `createAndroidComposeRule()` if
the activity already calls it.

A common pattern to achieve this is to create an `AndroidComposeTestRule` using
an empty activity such as [`ComponentActivity`](https://developer.android.com/reference/androidx/activity/ComponentActivity).

    class MyComposeTest {

        @get:Rule
        val composeTestRule = createAndroidComposeRule<ComponentActivity>()

        @Test
        fun myTest() {
            // Start the app
            composeTestRule.setContent {
                MyAppTheme {
                    MainScreen(uiState = exampleUiState, /*...*/)
                }
            }
            val continueLabel = composeTestRule.activity.getString(R.string.next)
            composeTestRule.onNodeWithText(continueLabel).performClick()
        }
    }

Note that `ComponentActivity` needs to be added to your app's
`AndroidManifest.xml` file. Enable that by adding this dependency to your
module:

    debugImplementation("androidx.compose.ui:ui-test-manifest:$compose_version")

### Custom semantics properties

You can create custom [semantics](https://developer.android.com/develop/ui/compose/testing/semantics) properties to expose information to tests.
To do this, define a new `SemanticsPropertyKey` and make it available using the
`SemanticsPropertyReceiver`.

    // Creates a semantics property of type Long.
    val PickedDateKey = SemanticsPropertyKey<Long>("PickedDate")
    var SemanticsPropertyReceiver.pickedDate by PickedDateKey

Now use that property in the `semantics` modifier:

    val datePickerValue by remember { mutableStateOf(0L) }
    MyCustomDatePicker(
        modifier = Modifier.semantics { pickedDate = datePickerValue }
    )

From tests, use `SemanticsMatcher.expectValue` to assert the value of the
property:

    composeTestRule
        .onNode(SemanticsMatcher.expectValue(PickedDateKey, 1445378400)) // 2015-10-21
        .assertExists()

> [!WARNING]
> **Warning:** You should only use custom Semantics properties when it's hard to match a specific item using the given finders and matchers. Using custom Semantics properties to expose visual properties such as colors, font size or rounded corner radius is not recommended, as it can pollute production code and wrong implementations can lead to bugs that are hard to find.

### Verify state restoration

Verify that the state of your Compose elements is correctly restored when the
activity or process is recreated. Perform such checks without relying on
activity recreation with the [`StateRestorationTester`](https://developer.android.com/reference/kotlin/androidx/compose/ui/test/junit4/StateRestorationTester) class.

This class lets you simulate the recreation of a composable. It's especially
useful to verify the implementation of [`rememberSaveable`](https://developer.android.com/reference/kotlin/androidx/compose/runtime/saveable/rememberSaveable.composable#rememberSaveable(kotlin.Array,androidx.compose.runtime.saveable.Saver,kotlin.String,kotlin.Function0)).


    class MyStateRestorationTests {

        @get:Rule
        val composeTestRule = createComposeRule()

        @Test
        fun onRecreation_stateIsRestored() {
            val restorationTester = StateRestorationTester(composeTestRule)

            restorationTester.setContent { MainScreen() }

            // TODO: Run actions that modify the state

            // Trigger a recreation
            restorationTester.emulateSavedInstanceStateRestore()

            // TODO: Verify that state has been correctly restored.
        }
    }

### Test different device configurations

Android apps need to adapt to many changing conditions: window sizes, locales,
font sizes, dark and light themes, and more. Most of these conditions are
derived from device-level values controlled by the user and exposed with the
current [`Configuration`](https://developer.android.com/reference/android/content/res/Configuration) instance. Testing different configurations
directly in a test is difficult since the test must configure device-level
properties.

[`DeviceConfigurationOverride`](https://developer.android.com/reference/kotlin/androidx/compose/ui/test/DeviceConfigurationOverride) is a test-only API that lets you simulate
different device configurations in a localized way for the `@Composable` content
under test.

The companion object of `DeviceConfigurationOverride` has the following
extension functions, which override device-level configuration properties:

- [`DeviceConfigurationOverride.DarkMode()`](https://developer.android.com/reference/kotlin/androidx/compose/ui/test/DeviceConfigurationOverride.Companion#(androidx.compose.ui.test.DeviceConfigurationOverride.Companion).DarkMode(kotlin.Boolean)): Overrides the system to dark theme or light theme.
- [`DeviceConfigurationOverride.FontScale()`](https://developer.android.com/reference/kotlin/androidx/compose/ui/test/DeviceConfigurationOverride.Companion#(androidx.compose.ui.test.DeviceConfigurationOverride.Companion).FontScale(kotlin.Float)): Overrides the [system font
  scale](https://developer.android.com/training/multiscreen/screendensities#TaskUseDP).
- [`DeviceConfigurationOverride.FontWeightAdjustment()`](https://developer.android.com/reference/kotlin/androidx/compose/ui/test/DeviceConfigurationOverride.Companion#(androidx.compose.ui.test.DeviceConfigurationOverride.Companion).FontWeightAdjustment(kotlin.Int)): Overrides the system font weight adjustment.
- [`DeviceConfigurationOverride.ForcedSize()`](https://developer.android.com/reference/kotlin/androidx/compose/ui/test/DeviceConfigurationOverride.Companion#(androidx.compose.ui.test.DeviceConfigurationOverride.Companion).ForcedSize(androidx.compose.ui.unit.DpSize)): Forces a specific amount of space regardless of device size.
- [`DeviceConfigurationOverride.LayoutDirection()`](https://developer.android.com/reference/kotlin/androidx/compose/ui/test/DeviceConfigurationOverride.Companion#(androidx.compose.ui.test.DeviceConfigurationOverride.Companion).LayoutDirection(androidx.compose.ui.unit.LayoutDirection)): Overrides the [layout
  direction](https://developer.android.com/training/basics/supporting-devices/languages#SupportLayoutMirroring) (left-to-right or right-to-left).
- [`DeviceConfigurationOverride.Locales()`](https://developer.android.com/reference/kotlin/androidx/compose/ui/test/DeviceConfigurationOverride.Companion#(androidx.compose.ui.test.DeviceConfigurationOverride.Companion).Locales(androidx.compose.ui.text.intl.LocaleList)): Overrides the [locale](https://developer.android.com/guide/topics/resources/localization).
- [`DeviceConfigurationOverride.RoundScreen()`](https://developer.android.com/reference/kotlin/androidx/compose/ui/test/DeviceConfigurationOverride.Companion#(androidx.compose.ui.test.DeviceConfigurationOverride.Companion).RoundScreen(kotlin.Boolean)): Overrides if the screen is [round](https://developer.android.com/design/ui/wear/guides/foundations/getting-started#design-for-round).

To apply a specific override, wrap the content under test in a call to the
[`DeviceConfigurationOverride()`](https://developer.android.com/reference/kotlin/androidx/compose/ui/test/DeviceConfigurationOverride.composable#DeviceConfigurationOverride(androidx.compose.ui.test.DeviceConfigurationOverride,kotlin.Function0)) top-level function, passing the override
to apply as a parameter.

For example, the following code applies the
`DeviceConfigurationOverride.ForcedSize()` override to change the density
locally, forcing the `MyScreen` composable to be rendered in a large landscape
window, even if the device the test is running on doesn't support that window
size directly:


```kotlin
composeTestRule.setContent {
    DeviceConfigurationOverride(
        DeviceConfigurationOverride.ForcedSize(DpSize(1280.dp, 800.dp))
    ) {
        MyScreen() // Will be rendered in the space for 1280dp by 800dp without clipping.
    }
}
```

<br />

To apply multiple overrides together, use
[`DeviceConfigurationOverride.then()`](https://developer.android.com/reference/kotlin/androidx/compose/ui/test/DeviceConfigurationOverride#(androidx.compose.ui.test.DeviceConfigurationOverride).then(androidx.compose.ui.test.DeviceConfigurationOverride)):


```kotlin
composeTestRule.setContent {
    DeviceConfigurationOverride(
        DeviceConfigurationOverride.FontScale(1.5f) then
            DeviceConfigurationOverride.FontWeightAdjustment(200)
    ) {
        Text(text = "text with increased scale and weight")
    }
}
```

<br />

## Additional Resources

- **[Test apps on Android](https://developer.android.com/training/testing)**: The main Android testing landing page provides a broader view of testing fundamentals and techniques.
- **[Fundamentals of testing](https://developer.android.com/training/testing/fundamentals):** Learn more about the core concepts behind testing an Android app.
- **[Local tests](https://developer.android.com/training/testing/local-tests):** You can run some tests locally, on your own workstation.
- **[Instrumented tests](https://developer.android.com/training/testing/instrumented-tests):** It is good practice to also run instrumented tests. That is, tests that run directly on-device.
- **[Continuous integration](https://developer.android.com/training/testing/continuous-integration):** Continuous integration lets you integrate your tests into your deployment pipeline.
- **[Test different screen sizes](https://developer.android.com/training/testing/different-screens):** With some many devices available to users, you should test for different screen sizes.
- **[Espresso](https://developer.android.com/training/testing/espresso)**: While intended for View-based UIs, Espresso knowledge can still be helpful for some aspects of Compose testing.