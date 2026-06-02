---
title: "Install Flutter App iOS"
type: note
created: 2024-01-10
updated: 2024-01-10
source: chatgpt-export
conversation_id: e320ccd0-f9d4-4c47-a7eb-e9f5a2c8f49b
message_count: 2
tags: [chatgpt, import]
---
# Install Flutter App iOS

> Conversation ID: e320ccd0-f9d4-4c47-a7eb-e9f5a2c8f49b
> Created: 2024-01-10T04:42:56Z
> Updated: 2024-01-10T04:43:16Z
> Messages: 2

---

## User

how do i permanently install my flutter app on my ios device

---

## Assistant

To permanently install your Flutter app on your iOS device, you need to follow these steps:

1. **Build the App for iOS**: 
   - Open your Flutter project in your IDE.
   - Run `flutter build ios` to create a release build for iOS.

2. **Xcode Configuration**: 
   - Open the `Runner.xcworkspace` in Xcode (found in your project's `ios` folder).
   - Configure your app’s version and build number.
   - Ensure your Apple Developer account is set up in Xcode (Xcode > Preferences > Accounts).

3. **Signing & Capabilities**:
   - In Xcode, go to the project's target and navigate to the 'Signing & Capabilities' tab.
   - Select your Team, and Xcode will automatically manage provisioning profiles.

4. **Deploy on Device**:
   - Connect your iOS device to your computer.
   - Select your device in Xcode.
   - Run the app. Xcode will install it on your device.

5. **Permanent Installation**:
   - To keep the app on your device permanently, you need to enroll in the Apple Developer Program ($99/year).
   - Without enrollment, the app will expire after 7 days for free Apple ID accounts.

6. **Distribution (Optional)**:
   - For broader distribution (e.g., through the App Store), follow the App Store submission process in Xcode.

By following these steps, your Flutter app will be permanently installed on your iOS device, assuming you have an active Apple Developer Program membership.
