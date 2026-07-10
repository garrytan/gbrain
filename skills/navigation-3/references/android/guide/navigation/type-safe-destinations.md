This guide outlines the process of replacing string-based routes with
serializable Kotlin types to achieve compile-time safety and eliminate runtime
crashes caused by typos or incorrect argument types.

## Prerequisites

Before starting the migration, verify that your project meets the following
requirements:

1. **Navigation version**: Update to Jetpack Navigation 2.8.0 or higher
2. **Kotlin serialization plugin**:
3. Add the plugin to `libs.versions.toml`:

    [libraries]
    kotlinx-serialization-json = { module = "org.jetbrains.kotlinx:kotlinx-serialization-json", version.ref = "kotlinxSerializationJson" }

    [plugins]
    kotlin-serialization = { id = "org.jetbrains.kotlin.plugin.serialization", version.ref = "kotlin" }

- Add the dependencies to your top-level `build.gradle.kts` and module-level `build.gradle.kts`.

## Step 1: Define Your Destinations

Replace your constant route strings with `@Serializable` objects and classes.

- **For screens without arguments** : Use a `data object`
- **For screens with arguments** : Use a `data class`

**Before (string based):**

    const val ROUTE_HOME = "home"
    const val ROUTE_PROFILE = "profile/{userId}"

**After (type safe):**

    import kotlinx.serialization.Serializable

    @Serializable
    object Home

    @Serializable
    data class Profile(val userId: String)

## Step 2: Update the NavHost Configuration

Update your `NavHost` to use the new generic types in the `composable` and
`dialog` function.

**Before:**

    NavHost(navController, startDestination = "home") {
        composable("home") { HomeScreen(...) }
        composable("profile/{userId}") { backStackEntry ->
            val userId = backStackEntry.arguments?.getString("userId")
            ProfileScreen(userId)
        }
    }

**After:**

    NavHost(navController, startDestination = Home) {
        composable<Home> {
            HomeScreen(...)
        }
        composable<Profile> { backStackEntry ->
            // The library automatically handles argument extraction
            val profile: Profile = backStackEntry.toRoute()
            ProfileScreen(profile.userId)
        }
    }

## Step 3: Implement Type-Safe Navigation Calls

Replace string-interpolated navigation calls with class instances.

**Before:**

    navController.navigate("profile/user123")

**After:**

    navController.navigate(Profile(userId = "user123"))

## Step 4: Accessing Arguments in ViewModels

If you use a `ViewModel`, you can now extract the route object directly from the
`SavedStateHandle`.

**Implementation:**

    class ProfileViewModel(
        savedStateHandle: SavedStateHandle
    ) : ViewModel() {
        // Automatically parses arguments into the Profile class
        private val profile = savedStateHandle.toRoute<Profile>()
        val userId = profile.userId
    }

## Step 5: (Advanced) Handling Custom Types

If you need to pass complex data classes (not just primitives), you must define
a custom `NavType`.

1. **Create the Custom Type** : \`\`\`kotlin val SearchFilterType = object : NavType(isNullableAllowed = false) { override fun get(bundle: Bundle, key: String): SearchFilter? = Json.decodeFromString(bundle.getString(key) ?: return null)

    override fun parseValue(value: String): SearchFilter =
        Json.decodeFromString(Uri.decode(value))

    override fun put(bundle: Bundle, key: String, value: SearchFilter) {
        bundle.putString(key, Json.encodeToString(value))
    }

}



    2. **Register it in the Graph**:
    ```kotlin
    composable<Search>(
        typeMap = mapOf(typeOf<SearchFilter>() to SearchFilterType)
    ) { ... }

## Best practices and tips

- **Sealed Hierarchies**: For large apps, group your routes using a sealed interface or class to keep the navigation structure organized
- **Object Instances** : For routes without parameters, always use `object` instead of `class` to avoid unnecessary allocations
- **Nullable Types** : The new API supports nullable types (for example, `data
  class Search(val query: String?)`) and provides default values automatically
- **Testing** : Use `navController.currentBackStackEntry?.hasRoute<T>()` to check the current destination in a type-safe manner during UI tests