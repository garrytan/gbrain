You can include an Android View hierarchy in a Compose UI. This approach is
particularly useful if you want to use UI elements that are not yet available in
Compose, like
[`AdView`](https://developers.google.com/android/reference/com/google/android/gms/ads/AdView).
This approach also lets you reuse custom views you may have designed.

> [!NOTE]
> **Note:** Use `AndroidView` as a wrapper only for missing SDK components without Compose support. Rewrite your custom Views in Compose wherever possible, starting the migration with the simplest custom Views and scaling to more complex ones.

<br />

To include a view element or hierarchy, use the [`AndroidView`](https://developer.android.com/reference/kotlin/androidx/compose/ui/viewinterop/AndroidView.composable#AndroidView(kotlin.Function1,androidx.compose.ui.Modifier,kotlin.Function1))
composable. `AndroidView` is passed a lambda that returns a
[`View`](https://developer.android.com/reference/android/view/View). `AndroidView` also provides an `update`
callback that is called when the view is inflated. The `AndroidView` recomposes
whenever a `State` read within the callback changes. `AndroidView`, like many
other built-in composables, takes a `Modifier` parameter that can be used, for
example, to set its position in the parent composable.


```kotlin
@Composable
fun CustomView() {
    var selectedItem by remember { mutableIntStateOf(0) }

    // Adds view to Compose
    AndroidView(
        modifier = Modifier.fillMaxSize(), // Occupy the max size in the Compose UI tree
        factory = { context ->
            // Creates view
            MyView(context).apply {
                // Sets up listeners for View -> Compose communication
                setOnClickListener {
                    selectedItem = 1
                }
            }
        },
        update = { view ->
            // View's been inflated or state read in this block has been updated
            // Add logic here if necessary

            // As selectedItem is read here, AndroidView will recompose
            // whenever the state changes
            // Example of Compose -> View communication
            view.selectedItem = selectedItem
        }
    )
}

@Composable
fun ContentExample() {
    Column(Modifier.fillMaxSize()) {
        Text("Look at this CustomView!")
        CustomView()
    }
}
```

<br />

> [!NOTE]
> **Note:** Prefer to construct a View in the `AndroidView` `factory` lambda instead of using `remember` to hold a View reference outside of `AndroidView`.

## `AndroidView` with view binding

To embed an XML layout, use the
[`AndroidViewBinding`](https://developer.android.com/reference/kotlin/androidx/compose/ui/viewinterop/package-summary#AndroidViewBinding(kotlin.Function3,%20androidx.compose.ui.Modifier,%20kotlin.Function1))
API, which is provided by the `androidx.compose.ui:ui-viewbinding` library. To
do this, your project must enable [view binding](https://developer.android.com/topic/libraries/view-binding#setup).

> [!NOTE]
> **Note:** For Compose-only apps, don't use `AndroidViewBinding` to inflate full screen-level XML layouts, and instead use it only for smaller, legacy XML layouts during the incremental migration process.


```kotlin
@Composable
fun AndroidViewBindingExample() {
    AndroidViewBinding(ExampleLayoutBinding::inflate) {
        exampleView.setBackgroundColor(Color.GRAY)
    }
}
```

<br />

## `AndroidView` in Lazy lists

If you are using an `AndroidView` in a Lazy list (`LazyColumn`, `LazyRow`,
`Pager`, etc.), consider using the [`AndroidView`](https://developer.android.com/reference/kotlin/androidx/compose/ui/viewinterop/package-summary#AndroidView(kotlin.Function1,kotlin.Function1,androidx.compose.ui.Modifier,kotlin.Function1,kotlin.Function1))
overload introduced in version 1.4.0-rc01. This overload allows Compose to reuse
the underlying `View` instance when the containing composition is reused as is
the case for Lazy lists.

This overload of `AndroidView` adds 2 additional parameters:

- `onReset` - A callback invoked to signal that the `View` is about to be reused. This must be non-null to enable View reuse.
- `onRelease` (optional) - A callback invoked to signal that the `View` has exited the composition and will not be reused again.


```kotlin
@Composable
fun AndroidViewInLazyList() {
    LazyColumn {
        items(100) { index ->
            AndroidView(
                modifier = Modifier.fillMaxSize(), // Occupy the max size in the Compose UI tree
                factory = { context ->
                    MyView(context)
                },
                update = { view ->
                    view.selectedItem = index
                },
                onReset = { view ->
                    view.clear()
                }
            )
        }
    }
}
```

<br />

## Fragments in Compose (Transitionary Step)

Use the `AndroidFragment` composable to add a `Fragment` in Compose.
`AndroidFragment` has fragment-specific handling such as removing the
fragment when the composable leaves the composition.

> [!NOTE]
> **Note:** Wrap existing Fragments in Compose only during incremental migration. For Compose-only apps, do not use Fragments and instead use the recommended Compose-only architecture with a single Activity and latest navigation libraries, like Navigation 3.

To include a fragment, use the [`AndroidFragment`](https://developer.android.com/reference/kotlin/androidx/fragment/compose/package-summary#AndroidFragment)
composable. You pass a `Fragment` class to `AndroidFragment`, which then adds
an instance of that class directly into the composition. `AndroidFragment` also
provides a `fragmentState` object to create the `AndroidFragment` with a given
state, `arguments` to pass into the new fragment, and an `onUpdate` callback
that provides the fragment from the composition. Like many
other built-in composables, `AndroidFragment` accepts a `Modifier` parameter
that you can use, for
example, to set its position in the parent composable.

Call `AndroidFragment` in Compose as follows:


```kotlin
@Composable
fun FragmentInComposeExample() {
    AndroidFragment<MyFragment>()
}
```

<br />

## Calling the Android framework from Compose

Compose operates within the Android framework classes. For example, it's hosted
on Android View classes, like `Activity` or `Fragment`, and might use Android
framework classes like the `Context`, system resources,
`Service`, or `BroadcastReceiver`.

To learn more about system resources, see [Resources in Compose](https://developer.android.com/develop/ui/compose/resources).

### Composition Locals

[`CompositionLocal`](https://developer.android.com/reference/kotlin/androidx/compose/runtime/CompositionLocal)
classes allow passing data implicitly through composable functions. They're
usually provided with a value in a certain node of the UI tree. That value can
be used by its composable descendants without declaring the `CompositionLocal`
as a parameter in the composable function.

`CompositionLocal` is used to propagate values for Android framework types in
Compose such as `Context`, `Configuration` or the `View` in which the Compose
code is hosted with the corresponding
[`LocalContext`](https://developer.android.com/reference/kotlin/androidx/compose/ui/platform/package-summary#LocalContext()),
[`LocalConfiguration`](https://developer.android.com/reference/kotlin/androidx/compose/ui/platform/package-summary#LocalConfiguration()),
or
[`LocalView`](https://developer.android.com/reference/kotlin/androidx/compose/ui/platform/package-summary#LocalView()).
Note that `CompositionLocal` classes are prefixed with `Local` for better
discoverability with auto-complete in the IDE.

Access the current value of a `CompositionLocal` by using its `current`
property. For example, the code below shows a toast message by providing
`LocalContext.current` into the `Toast.makeToast` method.


```kotlin
@Composable
fun ToastGreetingButton(greeting: String) {
    val context = LocalContext.current
    Button(onClick = {
        Toast.makeText(context, greeting, Toast.LENGTH_SHORT).show()
    }) {
        Text("Greet")
    }
}
```

<br />

### Broadcast receivers

To showcase `CompositionLocal` and [side
effects](https://developer.android.com/develop/ui/compose/side-effects), if a
[`BroadcastReceiver`](https://developer.android.com/guide/components/broadcasts) needs to be registered from
a composable function, use of `LocalContext` to use the current context, and
`rememberUpdatedState` and `DisposableEffect` side effects.


```kotlin
@Composable
fun SystemBroadcastReceiver(
    systemAction: String,
    onSystemEvent: (intent: Intent?) -> Unit
) {
    // Grab the current context in this part of the UI tree
    val context = LocalContext.current

    // Safely use the latest onSystemEvent lambda passed to the function
    val currentOnSystemEvent by rememberUpdatedState(onSystemEvent)

    // If either context or systemAction changes, unregister and register again
    DisposableEffect(context, systemAction) {
        val intentFilter = IntentFilter(systemAction)
        val broadcast = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                currentOnSystemEvent(intent)
            }
        }

        context.registerReceiver(broadcast, intentFilter)

        // When the effect leaves the Composition, remove the callback
        onDispose {
            context.unregisterReceiver(broadcast)
        }
    }
}

@Composable
fun HomeScreen() {

    SystemBroadcastReceiver(Intent.ACTION_BATTERY_CHANGED) { batteryStatus ->
        val isCharging = /* Get from batteryStatus ... */ true
        /* Do something if the device is charging */
    }

    /* Rest of the HomeScreen */
}
```

<br />

## Other interactions

If there isn't a utility defined for the interaction you need, the best practice
is to follow the general Compose guideline,
*data flows down, events flow up* (discussed at more length in [Thinking
in Compose](https://developer.android.com/develop/ui/compose/mental-model)). For example, this composable
launches a different activity:


```kotlin
class OtherInteractionsActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // get data from savedInstanceState
        setContent {
            MaterialTheme {
                ExampleComposable(data, onButtonClick = {
                    startActivity(Intent(this, MyActivity::class.java))
                })
            }
        }
    }
}

@Composable
fun ExampleComposable(data: DataExample, onButtonClick: () -> Unit) {
    Button(onClick = onButtonClick) {
        Text(data.title)
    }
}
```

<br />