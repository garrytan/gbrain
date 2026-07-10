Navigation 3 is a new navigation library designed to work with Compose. With
Navigation 3, you have full control over your back stack, and navigating to and
from destinations is as simple as adding and removing items from a list. It
creates a flexible app navigation system by providing:

- Conventions for modeling a back stack, where each entry on the back stack represents content that the user has navigated to
- A UI that automatically updates with back stack changes (including animations)
- A scope for items in the back stack, allowing state to be retained while an item is in the back stack
- An adaptive layout system that allows multiple destinations to be displayed at the same time, and allowing seamless switching between those layouts
- A mechanism for content to communicate with its parent layout (metadata)

At a high level, you implement Navigation 3 in the following ways:

1. Define the content that users can navigate to in your app, each with a unique key, and add a function to resolve that key to the content. See [Resolve keys
   to content](https://developer.android.com/guide/navigation/navigation-3/basics#resolve-keys).
2. Create a back stack that keys are pushed onto and removed as users navigate your app. See [Create a back stack](https://developer.android.com/guide/navigation/navigation-3/basics#create-back).
3. Use a [`NavDisplay`](https://developer.android.com/reference/kotlin/androidx/navigation3/ui/NavDisplay.composable) to display your app's back stack. Whenever the back stack changes, it updates the UI to display relevant content. See [Display
   the back stack](https://developer.android.com/guide/navigation/navigation-3/basics#display-back).
4. Modify `NavDisplay`'s [scene strategies](https://developer.android.com/guide/navigation/navigation-3/custom-layouts) as needed to support adaptive layouts and different platforms.

You can see the [full source code](https://cs.android.com/androidx/platform/frameworks/support/+/androidx-main:navigation3/) for Navigation 3 on AOSP.

## Improvements upon Jetpack Navigation

Navigation 3 improves upon the original Jetpack Navigation API in the following
ways:

- Provides a simpler integration with Compose
- Offers you full control of the back stack
- Makes it possible to create layouts that can read more than one destination from the back stack at the same time, allowing them to adapt to changes in window size and other inputs.

Read more about Navigation 3's principles and API design choices in [this blog
post](https://android-developers.googleblog.com/2025/05/announcing-jetpack-navigation-3-for-compose.html).

## Code samples

The [recipes repository](https://github.com/android/nav3-recipes) contains examples of how to use the
Navigation 3 building blocks to solve common navigation challenges.