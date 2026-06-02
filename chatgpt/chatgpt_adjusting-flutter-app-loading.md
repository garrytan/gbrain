---
title: "Adjusting Flutter App Loading"
type: note
created: 2024-01-19
updated: 2024-01-19
source: chatgpt-export
conversation_id: b16af703-743d-4260-ba4e-ef42fe4c2734
message_count: 2
tags: [chatgpt, import]
---
# Adjusting Flutter App Loading

> Conversation ID: b16af703-743d-4260-ba4e-ef42fe4c2734
> Created: 2024-01-19T01:13:32Z
> Updated: 2024-01-19T01:13:51Z
> Messages: 2

---

## User

how do i adjust the loading screen of my flutter app

---

## Assistant

To adjust the loading screen of your Flutter app, you'll need to modify the splash screen settings. Here's a concise guide:

1. **Edit the Launch Screen for iOS:**
   - Open `Runner.xcworkspace` in Xcode, found in the `ios` folder of your Flutter project.
   - Navigate to `Runner/Assets.xcassets/LaunchImage.imageset`.
   - Replace the existing images with your custom images for different screen sizes.
   - Modify `LaunchScreen.storyboard` for more complex designs.

2. **Change the Splash Screen for Android:**
   - Open your Flutter project and go to `android/app/src/main`.
   - Navigate to `res/drawable` (create this folder if it doesn't exist).
   - Add your splash screen image here.
   - Edit `res/values/styles.xml` to use the new image as a splash screen.

3. **Implement a Flutter Loading Screen:**
   - Create a new Dart file for your custom loading screen.
   - Use a `StatefulWidget` to manage the state.
   - Display your desired loading graphics or animations.
   - Transition to the home screen after loading is complete, possibly using `Future.delayed`.

Remember, for specific details and more complex customizations, refer to the Flutter documentation or consider using packages that help in customizing splash screens.
