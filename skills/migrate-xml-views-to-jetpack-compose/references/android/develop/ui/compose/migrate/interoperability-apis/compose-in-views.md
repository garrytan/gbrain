> [!NOTE]
> **Note:** Interoperability is supported for hybrid apps that use Compose and Views. For apps that are only in Compose, use the recommended Compose-only architecture with a single Activity and latest navigation libraries, like Navigation 3.

You can add Compose-based UI into an existing app that uses a View-based design.

To create a new, entirely Compose-based screen, have your
activity call the `setContent()` method, and pass whatever composable functions
you like.


```kotlin
class ExampleActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        setContent { // In here, we can call composables!
            MaterialTheme {
                Greeting(name = "compose")
            }
        }
    }
}

@Composable
fun Greeting(name: String) {
    Text(text = "Hello $name!")
}
```

<br />

This code looks just like what you'd find in a Compose-only app.

> [!CAUTION]
> **Caution:** To use the `ComponentActivity.setContent`
> method, add the `androidx.activity:activity-compose:$latestVersion`
> dependency to your `build.gradle` file.
>
> See the [Activity releases page](https://developer.android.com/jetpack/androidx/releases/activity)
> to find out the latest version.

## `ViewCompositionStrategy` for `ComposeView`

[`ViewCompositionStrategy`](https://developer.android.com/reference/kotlin/androidx/compose/ui/platform/ViewCompositionStrategy)
defines when the Composition should be disposed. The default,
[`ViewCompositionStrategy.Default`](https://developer.android.com/reference/kotlin/androidx/compose/ui/platform/ViewCompositionStrategy#Default()),
disposes the Composition when the underlying
[`ComposeView`](https://developer.android.com/reference/kotlin/androidx/compose/ui/platform/ComposeView)
detaches from the window, unless it is part of a pooling container such as a
`RecyclerView`. In a single-Activity Compose-only app, this default behavior is
what you would want, however, if you are incrementally adding Compose in your
codebase, this behavior may cause state loss in some scenarios.

To change the `ViewCompositionStrategy`, call the [`setViewCompositionStrategy()`](https://developer.android.com/reference/kotlin/androidx/compose/ui/platform/AbstractComposeView#setViewCompositionStrategy(androidx.compose.ui.platform.ViewCompositionStrategy))
method and provide a different strategy.

The table below summarizes the different scenarios you can use
`ViewCompositionStrategy` in:

| `ViewCompositionStrategy` | Description and Interop Scenario |
|---|---|
| [`DisposeOnDetachedFromWindow`](https://developer.android.com/reference/kotlin/androidx/compose/ui/platform/ViewCompositionStrategy.DisposeOnDetachedFromWindow) | The Composition will be disposed when the underlying `ComposeView` is detached from the window. Has since been superseded by `DisposeOnDetachedFromWindowOrReleasedFromPool`. Interop scenario: \* `ComposeView` whether it's the sole element in the View hierarchy, or in the context of a mixed View/Compose screen (not in Fragment). |
| [`DisposeOnDetachedFromWindowOrReleasedFromPool`](https://developer.android.com/reference/kotlin/androidx/compose/ui/platform/ViewCompositionStrategy.DisposeOnDetachedFromWindowOrReleasedFromPool) (**Default**) | Similar to `DisposeOnDetachedFromWindow`, when the Composition is not in a pooling container, such as a `RecyclerView`. If it is in a pooling container, it will dispose when either the pooling container itself detaches from the window, or when the item is being discarded (i.e. when the pool is full). Interop scenario: \* `ComposeView` whether it's the sole element in the View hierarchy, or in the context of a mixed View/Compose screen (not in Fragment). \* `ComposeView` as an item in a pooling container such as `RecyclerView`. |
| [`DisposeOnLifecycleDestroyed`](https://developer.android.com/reference/kotlin/androidx/compose/ui/platform/ViewCompositionStrategy.DisposeOnLifecycleDestroyed) | The Composition will be disposed when the provided [`Lifecycle`](https://developer.android.com/reference/androidx/lifecycle/Lifecycle) is destroyed. Interop scenario \* `ComposeView` in a Fragment's View. |
| [`DisposeOnViewTreeLifecycleDestroyed`](https://developer.android.com/reference/kotlin/androidx/compose/ui/platform/ViewCompositionStrategy.DisposeOnViewTreeLifecycleDestroyed) | The Composition will be disposed when the `Lifecycle` owned by the `LifecycleOwner` returned by `ViewTreeLifecycleOwner.get` of the next window the View is attached to is destroyed. Interop scenario: \* `ComposeView` in a Fragment's View. \* `ComposeView` in a View wherein the Lifecycle is not known yet. |

## `ComposeView` in Fragments (Transitionary Step)

> [!NOTE]
> **Note:** For hybrid apps with Views and Compose, that use Fragments, use `ComposeView` to wrap composables content and add to a Fragment during migration. For Compose-only apps, do not use Fragments and instead use the recommended Compose-only architecture with a single Activity and latest navigation libraries, like Navigation 3.

If you want to incorporate Compose UI content in a fragment or an existing View
layout, use [`ComposeView`](https://developer.android.com/reference/kotlin/androidx/compose/ui/platform/ComposeView)
and call its
[`setContent()`](https://developer.android.com/reference/kotlin/androidx/compose/ui/platform/ComposeView#setContent(kotlin.Function0))
method. `ComposeView` is an Android [`View`](https://developer.android.com/reference/android/view/View).

You can put the `ComposeView` in your XML layout just like any other `View`:

```xml
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:orientation="vertical"
    android:layout_width="match_parent"
    android:layout_height="match_parent">

  <TextView
      android:id="@+id/text"
      android:layout_width="wrap_content"
      android:layout_height="wrap_content" />

  <androidx.compose.ui.platform.ComposeView
      android:id="@+id/compose_view"
      android:layout_width="match_parent"
      android:layout_height="match_parent" />
</LinearLayout>
```

In the Kotlin source code, inflate the layout from the [layout
resource](https://developer.android.com/guide/topics/resources/layout-resource) defined in XML. Then get the
`ComposeView` using the XML ID, set a Composition strategy that works best for
the host `View`, and call `setContent()` to use Compose.


```kotlin
class ExampleFragmentXml : Fragment() {

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View {
        val view = inflater.inflate(R.layout.fragment_example, container, false)
        val composeView = view.findViewById<ComposeView>(R.id.compose_view)
        composeView.apply {
            // Dispose of the Composition when the view's LifecycleOwner
            // is destroyed
            setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnViewTreeLifecycleDestroyed)
            setContent {
                // In Compose world
                MaterialTheme {
                    Text("Hello Compose!")
                }
            }
        }
        return view
    }
}
```

<br />

Alternatively, you can also use view binding to obtain references to the
`ComposeView` by referencing the generated binding class for your XML layout file:


```kotlin
class ExampleFragment : Fragment() {

    private var _binding: FragmentExampleBinding? = null

    // This property is only valid between onCreateView and onDestroyView.
    private val binding get() = _binding!!

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View {
        _binding = FragmentExampleBinding.inflate(inflater, container, false)
        val view = binding.root
        binding.composeView.apply {
            // Dispose of the Composition when the view's LifecycleOwner
            // is destroyed
            setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnViewTreeLifecycleDestroyed)
            setContent {
                // In Compose world
                MaterialTheme {
                    Text("Hello Compose!")
                }
            }
        }
        return view
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}
```

<br />

![Two slightly different text elements, one above the other](https://developer.android.com/static/develop/ui/compose/images/interop-hellos.png)

**Figure 1.** This shows the output of the code that adds Compose elements in a
View UI hierarchy. The "Hello Android!" text is displayed by a
`TextView` widget. The "Hello Compose!" text is displayed by a
Compose text element.

You can also include a `ComposeView` directly in a fragment if your full screen
is built with Compose, which lets you avoid using an XML layout file entirely.


```kotlin
class ExampleFragmentNoXml : Fragment() {

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View {
        return ComposeView(requireContext()).apply {
            // Dispose of the Composition when the view's LifecycleOwner
            // is destroyed
            setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnViewTreeLifecycleDestroyed)
            setContent {
                MaterialTheme {
                    // In Compose world
                    Text("Hello Compose!")
                }
            }
        }
    }
}
```

<br />

## Multiple `ComposeView` instances in the same layout

If there are multiple `ComposeView` elements in the same layout, each one must
have a unique ID for `savedInstanceState` to work.


```kotlin
class ExampleFragmentMultipleComposeView : Fragment() {

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View = LinearLayout(requireContext()).apply {
        addView(
            ComposeView(requireContext()).apply {
                setViewCompositionStrategy(
                    ViewCompositionStrategy.DisposeOnViewTreeLifecycleDestroyed
                )
                id = R.id.compose_view_x
                // ...
            }
        )
        addView(TextView(requireContext()))
        addView(
            ComposeView(requireContext()).apply {
                setViewCompositionStrategy(
                    ViewCompositionStrategy.DisposeOnViewTreeLifecycleDestroyed
                )
                id = R.id.compose_view_y
                // ...
            }
        )
    }
}
```

<br />

The `ComposeView` IDs are defined in the `res/values/ids.xml` file:

```xml
<resources>
  <item name="compose_view_x" type="id" />
  <item name="compose_view_y" type="id" />
</resources>
```

## Preview composables in Layout Editor

You can also preview composables within the Layout Editor for your XML layout
containing a `ComposeView`. Doing so lets you see how your composables look
within a mixed Views and Compose layout.

Say you want to display the following composable in the Layout Editor. Note
that composables annotated with `@Preview` are good candidates to preview in the
Layout Editor.


```kotlin
@Preview
@Composable
fun GreetingPreview() {
    Greeting(name = "Android")
}
```

<br />

To display this composable, use the `tools:composableName` tools attribute and
set its value to the fully qualified name of the composable to preview in the
layout.

```xml
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:tools="http://schemas.android.com/tools"
    android:orientation="vertical"
    android:layout_width="match_parent"
    android:layout_height="match_parent">

  <androidx.compose.ui.platform.ComposeView
      android:id="@+id/my_compose_view"
      tools:composableName="com.example.compose.snippets.interop.InteroperabilityAPIsSnippetsKt.GreetingPreview"
      android:layout_height="match_parent"
      android:layout_width="match_parent"/>

</LinearLayout>
```

![Composable displayed within layout editor](https://developer.android.com/static/develop/ui/compose/images/layout-editor-composable-preview.png)