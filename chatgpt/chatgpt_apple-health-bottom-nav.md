---
title: "Apple Health bottom nav"
type: guide
created: 2025-11-17
updated: 2025-11-17
source: chatgpt-export
conversation_id: 691a8916-ecb0-8332-acf7-5cec595f6b07
message_count: 4
tags: [chatgpt, import, code]
---
# Apple Health bottom nav

**Related:** [[personal_health]]

> Conversation ID: 691a8916-ecb0-8332-acf7-5cec595f6b07
> Created: 2025-11-17T02:32:10Z
> Updated: 2025-11-17T02:38:32Z
> Messages: 4

---

## User

{'asset_pointer': 'sediment://file_000000004c4c722fb46f28e8c9037994', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1536, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 127268, 'width': 708}
{'asset_pointer': 'sediment://file_00000000b9ec722fb159f6fbb09c3fc5', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1536, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 111729, 'width': 708}
How do we get our navigation on the bottom to look like Apple health attatched

---

## Assistant

Short version: use a *system* tab bar, not a custom pill, and style it with SF Symbols + accent color. That’s exactly what Apple Health is doing.

Assuming you’re on iOS and using SwiftUI, here’s how to get almost 1:1 with Health:

---

### SwiftUI – “Apple Health” style bottom nav

```swift
import SwiftUI

struct RootView: View {
    var body: some View {
        TabView {
            SummaryView()
                .tabItem {
                    Label("Summary", systemImage: "heart.fill")
                }

            SharingView()
                .tabItem {
                    Label("Sharing", systemImage: "person.2.fill")
                }

            BrowseView()
                .tabItem {
                    Label("Browse", systemImage: "magnifyingglass")
                }
        }
        // Same idea as Health: one accent color for selected item
        .tint(.pink)        // or your app’s accent color
    }
}
```

Key points:

- **Use `TabView`** instead of a custom HStack at the bottom. `TabView` gives you the native iOS tab bar.
- **Use SF Symbols** for icons: `"heart.fill"`, `"person.2.fill"`, `"magnifyingglass"` etc.
- **Let it be full-width & attached to the bottom** – don’t wrap it in a rounded rectangle or apply extra padding the way your current nav does.
- Set your app’s **Accent Color** in the asset catalog (or use `.tint`) so the selected icon and text are tinted like Apple Health.

---

### UIKit – same idea with `UITabBarController`

If you’re UIKit-based:

```swift
class RootTabBarController: UITabBarController {

    override func viewDidLoad() {
        super.viewDidLoad()

        let summary = UINavigationController(rootViewController: SummaryViewController())
        summary.tabBarItem = UITabBarItem(
            title: "Summary",
            image: UIImage(systemName: "heart.fill"),
            selectedImage: UIImage(systemName: "heart.fill")
        )

        let sharing = UINavigationController(rootViewController: SharingViewController())
        sharing.tabBarItem = UITabBarItem(
            title: "Sharing",
            image: UIImage(systemName: "person.2.fill"),
            selectedImage: UIImage(systemName: "person.2.fill")
        )

        let browse = UINavigationController(rootViewController: BrowseViewController())
        browse.tabBarItem = UITabBarItem(
            title: "Browse",
            image: UIImage(systemName: "magnifyingglass"),
            selectedImage: UIImage(systemName: "magnifyingglass")
        )

        viewControllers = [summary, sharing, browse]

        tabBar.tintColor = .systemPink      // selected color like Health
        tabBar.unselectedItemTintColor = .secondaryLabel
    }
}
```

---

If you tell me whether you’re using SwiftUI, UIKit, React Native, or Flutter, I can drop in the exact snippet for your stack, Mr. White.

---

## User

{'asset_pointer': 'sediment://file_000000009e00722fb28dee6f16ea32b3', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1536, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 98911, 'width': 708}

---

## Assistant

You’re super close, Mr. White — the only reason yours doesn’t look like Apple Health is that you built a **custom floating pill**; Health uses the **system tab bar** that’s attached edge-to-edge to the bottom.

So the fix is: **delete the custom pill nav and use the native tab bar** as the root container.

---

## If you’re using SwiftUI

Right now you probably have something like:

```swift
VStack {
    // main content
    Spacer()
    CustomBottomNav()    // the pill you showed
}
```

Replace that whole structure with a `TabView` at the root:

```swift
import SwiftUI

struct RootView: View {
    var body: some View {
        TabView {
            HomeView()
                .tabItem {
                    Label("Home", systemImage: "heart.fill")
                }

            MetricsView()
                .tabItem {
                    Label("Metrics", systemImage: "chart.bar.fill")
                }
        }
        .tint(.systemPurple)        // or your accent color
        .background(Color.black.ignoresSafeArea())
    }
}
```

Key points:

- **No rounded rectangle / capsule** around the tabs.
- `TabView` must be the **top-level container**, not nested inside another `VStack` with a custom bar under it.
- Use SF Symbols for icons (`"heart.fill"`, `"chart.bar.fill"` etc).
- Set the accent with `.tint(...)` so the selected tab looks like Health.

---

## If you’re using UIKit

Same idea: use a `UITabBarController` instead of a custom view at the bottom.

```swift
class RootTabBarController: UITabBarController {

    override func viewDidLoad() {
        super.viewDidLoad()

        let home = UINavigationController(rootViewController: HomeVC())
        home.tabBarItem = UITabBarItem(
            title: "Home",
            image: UIImage(systemName: "heart.fill"),
            selectedImage: UIImage(systemName: "heart.fill")
        )

        let metrics = UINavigationController(rootViewController: MetricsVC())
        metrics.tabBarItem = UITabBarItem(
            title: "Metrics",
            image: UIImage(systemName: "chart.bar.fill"),
            selectedImage: UIImage(systemName: "chart.bar.fill")
        )

        viewControllers = [home, metrics]

        tabBar.tintColor = .systemPurple
        tabBar.unselectedItemTintColor = .secondaryLabel
        tabBar.isTranslucent = true
        tabBar.backgroundColor = .black.withAlphaComponent(0.6)
    }
}
```

---

Bottom line: **stop drawing the pill** and let iOS draw the tab bar for you. That’s what will make it visually match Apple Health.


**Topic:** [[chatgpt-clusters/personal_health]]
