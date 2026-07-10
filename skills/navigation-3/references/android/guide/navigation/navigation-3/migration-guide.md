To migrate your app from [Navigation 2](https://developer.android.com/guide/navigation) to Navigation 3, follow these steps:

1. Add the Navigation 3 dependencies.
2. Update your navigation routes to implement the `NavKey` interface.
3. Create classes to hold and modify your navigation state.
4. Replace `NavController` with these classes.
5. Move your destinations from `NavHost`'s `NavGraph` into an `entryProvider`.
6. Replace `NavHost` with `NavDisplay`.
7. Remove Navigation 2 dependencies.

> [!IMPORTANT]
> **Important:** We released an agent skill to help you install and migrate to Jetpack Navigation 3. Try out the skill from the [Android skills repository](https://github.com/android/skills).

<br />


## AI Prompt

### Migrate from Navigation 2 to Navigation 3

This prompt will use this guide to migrate to navigation 3.

    Migrate from Navigation 2 to Navigation 3 using the official
    migration guide.

### Using AI prompts

AI prompts are intended to be used within Gemini in Android Studio.

Learn more about Gemini in Studio here: [https://developer.android.com/studio/gemini/overview](https://developer.android.com/studio/gemini/overview)
<button class="devsite-dialog-close">Close</button> <button class="button icon-button android-ai-prompt-help-button" data-modal-dialog-id="ai-prompt_help_modal__migrate-from-navigation-2-to-navigation-3"> </button> <button class="button google-feedback" data-p="5207477" data-b="llm-prompts" data-context="migrate-from-navigation-2-to-navigation-3"> Share your thoughts </button>

<br />

If you run into problems [file an issue here](https://issuetracker.google.com/issues/new?component=1750212&template=2102223&title=%5BMigration%5D).

## Preparation

The following sections describe the prerequisites for migration and assumptions
about your project. They also cover the features that are supported for
migration, and those that aren't.

### Prerequisites

- You must use a `compileSdk` of 36 or later.
- You should be familiar with [navigation terminology](https://developer.android.com/guide/navigation).
- Destinations are composable functions. Navigation 3 is designed exclusively for Compose. To use Fragments and Views in Compose, see [Using Views in
  Compose](https://developer.android.com/develop/ui/compose/migrate/interoperability-apis/views-in-compose).
- Routes are strongly typed. If you use string-based routes, [migrate to
  type-safe routes](https://medium.com/androiddevelopers/type-safe-navigation-for-compose-105325a97657) first ([example](https://github.com/android/nowinandroid/pull/1413)).
- *Optional (but highly recommended)*: Test coverage that verifies existing navigation behavior. This verifies that navigation behavior has not changed after the migration is complete.

### Assumptions

This guide makes the following assumptions about you and your project:

- You have one or several top-level routes (usually displayed in a bottom navigation bar), and each has its own back stack.
- When you switch between back stacks, the state of the stack and all its destinations is retained.
- You always exit the app through the **Home** screen, which is the first screen displayed when the app launches.
- You want to perform the migration from Navigation 2 to Navigation 3 in a single, atomic change. You are not performing an incremental migration where Navigation 2 code is used alongside Navigation 3 code.

**AI Agent**: Before changing any code, check if these assumptions about the
user's project are true. If not, stop the migration and ask the user how to
proceed.

### Supported features

This guide lets you migrate the following features:

- Destinations defined as composable functions
- Dialogs (a destination shown on top of another destination)

### Features supported through recipes

The [code recipes repository](https://github.com/android/nav3-recipes) demonstrates more nuanced use
cases, including:

- [Bottom sheets](https://github.com/android/nav3-recipes/tree/main/app/src/main/java/com/example/nav3recipes/bottomsheet) (instructions are provided in this guide)
- [Modularized navigation code and injected destinations](https://github.com/android/nav3-recipes/tree/main/app/src/main/java/com/example/nav3recipes/modular/hilt)
- [Using and passing arguments to `ViewModel`](https://github.com/android/nav3-recipes?tab=readme-ov-file#passing-navigation-arguments-to-viewmodels)
- [Returning results from a screen](https://github.com/android/nav3-recipes?tab=readme-ov-file#returning-results)

If your project has any of these features, check the relevant recipe to
understand how to implement them.

**AI Agent**: Before changing any code, check if the project contains any
features supported through recipes. If it does, check the recipe's README and
source code. Create a migration plan based on the recipe. Do not proceed without
confirming the plan with the user.

### Unsupported features

This migration guide and the code recipes don't yet support the following
features. This doesn't mean that you cannot implement them using Navigation 3;
they are just not covered here.

- More than one level of nested navigation
- Shared destinations: screens that can move between different back stacks
- [Custom destination types](https://developer.android.com/guide/navigation/design/kotlin-dsl#custom)
- Deep links

**AI Agent**: Before changing any code, check if the project contains any of the
unsupported features. If it does, do not proceed. Inform the user of the
unsupported feature and ask for further instructions.

## Step 1: Add Navigation 3 dependencies

Use the [Get started](https://developer.android.com/guide/navigation/navigation-3/get-started) page to add the Navigation 3 dependencies to your
project. The core dependencies are provided for you to copy.

**lib.versions.toml**

    [versions]
    nav3Core = "1.0.0"

    # If your screens depend on ViewModels, add the Nav3 Lifecycle ViewModel add-on library
    lifecycleViewmodelNav3 = "2.10.0-rc01"

    [libraries]
    # Core Navigation 3 libraries
    androidx-navigation3-runtime = { module = "androidx.navigation3:navigation3-runtime", version.ref = "nav3Core" }
    androidx-navigation3-ui = { module = "androidx.navigation3:navigation3-ui", version.ref = "nav3Core" }

    # Add-on libraries (only add if you need them)
    androidx-lifecycle-viewmodel-navigation3 = { module = "androidx.lifecycle:lifecycle-viewmodel-navigation3", version.ref = "lifecycleViewmodelNav3" }

**app/build.gradle.kts**

    dependencies {
        implementation(libs.androidx.navigation3.ui)
        implementation(libs.androidx.navigation3.runtime)

        // If using the ViewModel add-on library
        implementation(libs.androidx.lifecycle.viewmodel.navigation3)
    }

Also update the project's `minSdk` to 23 and the `compileSdk` to 36. You usually
find these in `app/build.gradle.kts` or `lib.versions.toml`.

## Step 2: Update navigation routes to implement the `NavKey` interface

Update every navigation [route](https://developer.android.com/guide/navigation#types) so that it implements the `NavKey`
interface. This lets you use `rememberNavBackStack` to assist with [saving your
navigation state](https://developer.android.com/guide/navigation/navigation-3/save-state).

Before:

    @Serializable data object RouteA

After:

    @Serializable data object RouteA : NavKey

> [!NOTE]
> **Note:** The `@Serializable` annotation is provided by the KotlinX Serialization plugin. You can add this by following [these project setup steps](https://developer.android.com/guide/navigation/navigation-3/get-started#project-setup).

## Step 3: Create classes to hold and modify your navigation state

### Step 3.1: Create a navigation state holder

Copy the following code into a file named `NavigationState.kt`. Add your package
name to match your project structure.

    // package com.example.project

    import androidx.compose.runtime.Composable
    import androidx.compose.runtime.MutableState
    import androidx.compose.runtime.getValue
    import androidx.compose.runtime.mutableStateOf
    import androidx.compose.runtime.remember
    import androidx.compose.runtime.saveable.rememberSerializable
    import androidx.compose.runtime.setValue
    import androidx.compose.runtime.snapshots.SnapshotStateList
    import androidx.compose.runtime.toMutableStateList
    import androidx.navigation3.runtime.NavBackStack
    import androidx.navigation3.runtime.NavEntry
    import androidx.navigation3.runtime.NavKey
    import androidx.navigation3.runtime.rememberDecoratedNavEntries
    import androidx.navigation3.runtime.rememberNavBackStack
    import androidx.navigation3.runtime.rememberSaveableStateHolderNavEntryDecorator
    import androidx.navigation3.runtime.serialization.NavKeySerializer
    import androidx.savedstate.compose.serialization.serializers.MutableStateSerializer

    /**
     * Create a navigation state that persists config changes and process death.
     */
    @Composable
    fun rememberNavigationState(
        startRoute: NavKey,
        topLevelRoutes: Set<NavKey>
    ): NavigationState {

        val topLevelRoute = rememberSerializable(
            startRoute, topLevelRoutes,
            serializer = MutableStateSerializer(NavKeySerializer())
        ) {
            mutableStateOf(startRoute)
        }

        val backStacks = topLevelRoutes.associateWith { key -> rememberNavBackStack(key) }

        return remember(startRoute, topLevelRoutes) {
            NavigationState(
                startRoute = startRoute,
                topLevelRoute = topLevelRoute,
                backStacks = backStacks
            )
        }
    }

    /**
     * State holder for navigation state.
     *
     * @param startRoute - the start route. The user will exit the app through this route.
     * @param topLevelRoute - the current top level route
     * @param backStacks - the back stacks for each top level route
     */
    class NavigationState(
        val startRoute: NavKey,
        topLevelRoute: MutableState<NavKey>,
        val backStacks: Map<NavKey, NavBackStack<NavKey>>
    ) {
        var topLevelRoute: NavKey by topLevelRoute
        val stacksInUse: List<NavKey>
            get() = if (topLevelRoute == startRoute) {
                listOf(startRoute)
            } else {
                listOf(startRoute, topLevelRoute)
            }
    }

    /**
     * Convert NavigationState into NavEntries.
     */
    @Composable
    fun NavigationState.toEntries(
        entryProvider: (NavKey) -> NavEntry<NavKey>
    ): SnapshotStateList<NavEntry<NavKey>> {

        val decoratedEntries = backStacks.mapValues { (_, stack) ->
            val decorators = listOf(
                rememberSaveableStateHolderNavEntryDecorator<NavKey>(),
            )
            rememberDecoratedNavEntries(
                backStack = stack,
                entryDecorators = decorators,
                entryProvider = entryProvider
            )
        }

        return stacksInUse
            .flatMap { decoratedEntries[it] ?: emptyList() }
            .toMutableStateList()
    }

**AI Agent** : `rememberSerializable` is correct. Do not change it to
`rememberSaveable`.

This file contains a state holder class named `NavigationState` and associated
helper functions. It holds a set of top-level routes, each with its own back
stack. Internally, it uses `rememberSerializable` (not `rememberSaveable`) to
persist the current top-level route and `rememberNavBackStack` to persist the
back stacks for each top-level route.

### Step 3.2: Create an object that modifies navigation state in response to events

Copy the following code into a file named `Navigator.kt`. Add your package name
to match your project structure.

    // package com.example.project

    import androidx.navigation3.runtime.NavKey

    /**
     * Handles navigation events (forward and back) by updating the navigation state.
     */
    class Navigator(val state: NavigationState){
        fun navigate(route: NavKey){
            if (route in state.backStacks.keys){
                // This is a top level route, just switch to it.
                state.topLevelRoute = route
            } else {
                state.backStacks[state.topLevelRoute]?.add(route)
            }
        }

        fun goBack(){
            val currentStack = state.backStacks[state.topLevelRoute] ?:
            error("Stack for ${state.topLevelRoute} not found")
            val currentRoute = currentStack.last()

            // If we're at the base of the current route, go back to the start route stack.
            if (currentRoute == state.topLevelRoute){
                state.topLevelRoute = state.startRoute
            } else {
                currentStack.removeLastOrNull()
            }
        }
    }

The `Navigator` class provides two navigation event methods:

- `navigate` to a specific route.
- `goBack` from the current route.

Both methods modify the `NavigationState`.

> [!IMPORTANT]
> **Architecture principles:** These classes follow the principles of [Unidirectional Data Flow](https://developer.android.com/topic/architecture):
>
> - The `Navigator` handles navigation events and uses them to update `NavigationState`.
> - The UI (provided by `NavDisplay`) observes `NavigationState` and reacts to any changes in that state by updating its UI.

### Step 3.3: Create the `NavigationState` and `Navigator`

Create instances of `NavigationState` and `Navigator` with the same scope as
your `NavController`.

    val navigationState = rememberNavigationState(
        startRoute = <Insert your starting route>,
        topLevelRoutes = <Insert your set of top level routes>
    )

    val navigator = remember { Navigator(navigationState) }

## Step 4: Replace `NavController`

Replace `NavController` navigation event methods with `Navigator` equivalents.

| **`NavController` field or method** | **`Navigator` equivalent** |
|---|---|
| `navigate()` | `navigate()` |
| `popBackStack()` | `goBack()` |

Replace `NavController` fields with `NavigationState` fields.

| **`NavController` field or method** | **`NavigationState` equivalent** |
|---|---|
| `currentBackStack` | `backStacks[topLevelRoute]` |
| `currentBackStackEntry` `currentBackStackEntryAsState()` `currentBackStackEntryFlow` `currentDestination` | `backStacks[topLevelRoute].last()` |
| Get the top level route: Traverse up the hierarchy from the current back stack entry to find it. | `topLevelRoute` |

Use `NavigationState.topLevelRoute` to determine the item that is currently
selected in a navigation bar.

Before:

    val isSelected = navController.currentBackStackEntryAsState().value?.destination.isRouteInHierarchy(key::class)

    fun NavDestination?.isRouteInHierarchy(route: KClass<*>) =
        this?.hierarchy?.any {
            it.hasRoute(route)
        } ?: false

After:

    val isSelected = key == navigationState.topLevelRoute

Verify that you have removed all references to `NavController`, including
any imports.

## Step 5: Move your destinations from `NavHost`'s `NavGraph` into an `entryProvider`

In Navigation 2, you [define your destinations](https://developer.android.com/guide/navigation/design#compose)
using the [NavGraphBuilder DSL](https://developer.android.com/guide/navigation/design/kotlin-dsl#navgraphbuilder),
usually inside `NavHost`'s trailing lambda. It is common to use extension
functions here as described in [Encapsulate your navigation code](https://developer.android.com/guide/navigation/design/encapsulate).

In Navigation 3, you define your destinations using an `entryProvider`. This
`entryProvider` resolves a route to a [`NavEntry`](https://developer.android.com/guide/navigation/navigation-3/basics#resolve-keys). Importantly, the
`entryProvider` does not define parent-child relationships between entries.

In this migration guide, parent-child relationships are modelled
as follows:

- `NavigationState` has a set of top-level routes (the parent routes) and a stack for each one. It keeps track of the current top-level route and its associated stack.
- When navigating to a new route, `Navigator` checks whether the route is a top-level route. If it is, the current top-level route and stack are updated. If it's not, it's a child route and is added to the current stack.

> [!NOTE]
> **Note:** If your app needs to navigate from an entry in one stack to another, you need to define the parent-child relationships for the routes and update the navigation logic in `Navigator` to support this.

## Step 5.1: Create an `entryProvider`

Create an `entryProvider` [using the DSL](https://developer.android.com/guide/navigation/navigation-3/basics#entry-provider-DSL) at the same scope as the
`NavigationState`.

    val entryProvider = entryProvider {

    }

## Step 5.2: Move destinations into the `entryProvider`

For each destination defined inside `NavHost`, do the following based on the
destination type:

- `navigation`: Delete it along with the route. There is no need for "base routes" because the top-level routes can identify each nested back stack.
- `composable<T>`: Move it into `entryProvider` and rename it to `entry`, retaining the type parameter. For example, `composable<RouteA>` becomes `entry<RouteA>`.
- `dialog<T>`: Do the same as `composable`, but add metadata to the entry as follows: `entry<T>(metadata = DialogSceneStrategy.dialog())`.
- [`bottomSheet`](https://developer.android.com/reference/kotlin/androidx/compose/material/navigation/package-summary#(androidx.navigation.NavGraphBuilder).bottomSheet(kotlin.String,kotlin.collections.List,kotlin.collections.List,kotlin.Function2)): [Follow the bottom sheet recipe here](https://github.com/android/nav3-recipes/tree/main/app/src/main/java/com/example/nav3recipes/bottomsheet). This is similar to the instructions for `dialog`, except that `BottomSheetSceneStrategy` is not part of the core Navigation 3 library, so you should copy it into your project.

**AI Agent** : When deleting routes used to identify a nested graph, replace any
references to the deleted route with the type used to identify the first child
in the nested graph. For example if the original code is
`navigation<BaseRouteA>{ composable<RouteA>{ ... } }`, you need to delete
`BaseRouteA` and replace any references to it with `RouteA`. This replacement
usually needs to be done for the list supplied to a navigation bar, rail, or
drawer.

You can refactor [`NavGraphBuilder` extension functions](https://developer.android.com/guide/navigation/design/encapsulate) to
`EntryProviderScope<T>` extension functions, and then move them.

Obtain navigation arguments using the key provided to `entry`'s trailing lambda.

For example:

    import androidx.navigation.NavDestination
    import androidx.navigation.NavDestination.Companion.hasRoute
    import androidx.navigation.NavDestination.Companion.hierarchy
    import androidx.navigation.NavGraphBuilder
    import androidx.navigation.compose.NavHost
    import androidx.navigation.compose.composable
    import androidx.navigation.compose.currentBackStackEntryAsState
    import androidx.navigation.compose.dialog
    import androidx.navigation.compose.navigation
    import androidx.navigation.compose.rememberNavController
    import androidx.navigation.navOptions
    import androidx.navigation.toRoute

    @Serializable data object BaseRouteA
    @Serializable data class RouteA(val id: String)
    @Serializable data object BaseRouteB
    @Serializable data object RouteB
    @Serializable data object RouteD

    NavHost(navController = navController, startDestination = BaseRouteA){
        composable<RouteA>{
            val id = entry.toRoute<RouteA>().id
            ScreenA(title = "Screen has ID: $id")
        }
        featureBSection()
        dialog<RouteD>{ ScreenD() }
    }

    fun NavGraphBuilder.featureBSection() {
        navigation<BaseRouteB>(startDestination = RouteB) {
            composable<RouteB> { ScreenB() }
        }
    }

becomes:

    import androidx.navigation3.runtime.EntryProviderScope
    import androidx.navigation3.runtime.NavKey
    import androidx.navigation3.runtime.entryProvider
    import androidx.navigation3.scene.DialogSceneStrategy

    @Serializable data class RouteA(val id: String) : NavKey
    @Serializable data object RouteB : NavKey
    @Serializable data object RouteD : NavKey

    val entryProvider = entryProvider {
        entry<RouteA>{ key -> ScreenA(title = "Screen has ID: ${key.id}") }
        featureBSection()
        entry<RouteD>(metadata = DialogSceneStrategy.dialog()){ ScreenD() }
    }

    fun EntryProviderScope<NavKey>.featureBSection() {
        entry<RouteB> { ScreenB() }
    }

## Step 6: Replace `NavHost` with `NavDisplay`

Replace `NavHost` with `NavDisplay`.

- Delete `NavHost` and replace it with `NavDisplay`.
- Specify `entries = navigationState.toEntries(entryProvider)` as a parameter. This converts the navigation state into the entries that `NavDisplay` shows using the `entryProvider`.
- Connect `NavDisplay.onBack` to `navigator.goBack()`. This causes `navigator` to update the navigation state when `NavDisplay`'s built-in back handler completes.
- If you have dialog destinations, add `DialogSceneStrategy` to `NavDisplay`'s `sceneStrategies` parameter.

For example:

    import androidx.navigation3.ui.NavDisplay

    NavDisplay(
        entries = navigationState.toEntries(entryProvider),
        onBack = { navigator.goBack() },
        sceneStrategies = remember { listOf(DialogSceneStrategy()) }
    )

## Step 7: Remove Navigation 2 dependencies

Remove all Navigation 2 imports and library dependencies.

## Summary

Congratulations! Your project is now migrated to Navigation 3. If you or your AI
agent has run into any problems using this guide, [file a bug
here](https://issuetracker.google.com/issues/new?component=1750212&template=2102223&title=%5BMigration%5D).