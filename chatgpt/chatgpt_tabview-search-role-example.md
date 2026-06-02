---
title: "TabView search role example"
type: guide
created: 2025-11-23
updated: 2025-11-23
source: chatgpt-export
conversation_id: 69228c6a-85bc-8327-b58d-91fe30b72e36
message_count: 6
tags: [chatgpt, import, code]
---
# TabView search role example

> Conversation ID: 69228c6a-85bc-8327-b58d-91fe30b72e36
> Created: 2025-11-23T04:24:53Z
> Updated: 2025-11-23T04:30:04Z
> Messages: 6

---

## User

{'asset_pointer': 'sediment://file_00000000658871f5b524bc3691b78202', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1536, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 115427, 'width': 708}
Yeah, Doug, can you explain to me how to achieve the same thing in SwiftUI, where the tabs are floating left and the action button is floating right, and they're all using system components, but they're in line with each other. What would be the best way to recreate this using system components that would inherit iOS 26 SDK properties, including LiquidGlass and LiquidGlassEffect, without doing anything crazy custom so that it's all adapted based on system perhaps?

---

## Assistant

Mr. White, the most “system-native” way to get *left floating tabs + a separated trailing button aligned on the same baseline* in SwiftUI on iOS 26 is to use the new Liquid Glass–aware `TabView` + `Tab` API and make the trailing control a **search-role tab**. Apple’s own apps do exactly this; on iPhone, a `.search` role tab renders as a separate circular/floaty control on the right of the glass tab cluster. citeturn4search4turn4search2turn3search4

### 1) Closest match to your screenshot: trailing “action” as a `.search` tab
This yields:
- left: a floating glass tab group
- right: a floating circular search/action button
- both auto-styled with Liquid Glass when compiled with the iOS 26 SDK, as long as you don’t override their backgrounds. citeturn0search13turn4search2turn4search4

```swift
import SwiftUI

enum RootTab: Hashable {
    case summary, sharing, search
}

struct RootView: View {
    @SceneStorage("selectedTab") private var selectedTab: RootTab = .summary
    @State private var searchText = ""

    var body: some View {
        TabView(selection: $selectedTab) {

            Tab("Summary", systemImage: "heart.fill", value: .summary) {
                SummaryView()
            }

            Tab("Sharing", systemImage: "person.2.fill", value: .sharing) {
                SharingView()
            }

            // Trailing floating control
            Tab(role: .search) {
                NavigationStack {
                    SearchView()
                        .navigationTitle("Search")
                }
            }
        }
        .searchable(text: $searchText)          // makes the search tab expand into a field
        .tabBarMinimizeBehavior(.onScrollDown)  // optional: matches iOS 26 collapsing behavior
        .tabViewStyle(.sidebarAdaptable)        // iPad/Mac become sidebar automatically
    }
}
```

**Why this is “best”:**
- It’s *all stock components*.  
- The layout (spacing, baseline alignment, hit targets) is handled by the system and adapts per device.  
- Liquid Glass + LiquidGlassEffect are inherited automatically by `TabView` and tab items under iOS 26 without you doing anything custom. citeturn0search13turn3search10turn3search11

**Important do-nots for Liquid Glass:**
- Don’t slap custom solid `.background(Color...)` on the tab bar or tabs.
- Don’t blur/opacity-stack over glass controls; it fights the system effect. citeturn0search13

---

### 2) If the trailing button is **not search**
If it’s a global action (e.g., “+”, “Now Playing”, etc.) and you want to stay honest to system intent, use a **bottom accessory**. This is a first-class iOS 26 TabView feature and inherits glass + minimization behavior. citeturn3search11turn3search3turn3search10

```swift
TabView(selection: $selectedTab) {
    Tab("Summary", systemImage: "heart.fill", value: .summary) { SummaryView() }
    Tab("Sharing", systemImage: "person.2.fill", value: .sharing) { SharingView() }
}
.tabViewBottomAccessory {
    Button {
        // global action
    } label: {
        Image(systemName: "plus")
            .font(.title2.weight(.semibold))
    }
}
```

**Tradeoff:** accessories are more “pill/strip” by default, not a tiny circle. Still 100% system and glass-native.

---

### 3) If you ever must add a small custom floating button
Keep it minimal and let iOS 26 render the glass:

```swift
Button { /* action */ } label: {
    Image(systemName: "magnifyingglass")
        .font(.title3.weight(.semibold))
        .padding(14)
}
.glassEffect(.clear, in: Circle())     // iOS 26 glass on your shape
```

Use `.glassEffect` variants like `.clear` or `.identity` only when you truly need a custom view; they’re meant to extend Liquid Glass to non-system shapes. citeturn2search6turn2search7

---

**Bottom line:**  
For your exact layout, do **Option 1**: a `.search` role tab inside a `TabView`. That reproduces the left floating tab cluster + right floating action button alignment using only system components, and it will automatically pick up LiquidGlass/LiquidGlassEffect behaviors from the iOS 26 SDK.

---

## User

I want the action button to be a plus button that launches a new entry, and I want the buttons on the left to be our menu buttons for home and metric screens, respectively. Can you concisely combine all of that into a simple AI prompt, specifying exactly what to utilize in SwiftUI, but not inserting any opinionated code or examples, just a concise paragraph form prompt?

---

## Assistant

Mr. White, here’s a concise AI prompt you can paste:  

“Describe how to recreate an iOS-26-native bottom control bar in SwiftUI using only system components: a floating Liquid Glass tab cluster on the left with two tabs (‘Home’ and ‘Metrics’) built via `TabView` + the iOS 26 `Tab` API, and a separate floating trailing circular **plus** action on the right that launches a ‘New Entry’ flow. Use a role-based trailing tab (not custom layout) so the plus renders as a right-side floating control aligned with the tab cluster and inherits iOS 26 LiquidGlass/LiquidGlassEffect, minimization, spacing, and hit-target behavior automatically across devices.”

---

## User

You have to write it at Cloud Code or GPT-5.1 so that I can have it execute.

---

## Assistant

Mr. White, paste this into a Codex Cloud task or a GPT-5.1-Codex/Thinking run:

“Implement an iOS 26 SwiftUI root navigation bar that matches Apple’s Liquid Glass tab style using **only system components**. Use `TabView` with the iOS 26 `Tab` API to create two leading floating tabs labeled **Home** and **Metrics**. Add a **separate trailing floating circular plus action** aligned on the same horizontal line as the left tab cluster, which presents a ‘New Entry’ flow. Prefer a role/accessory-based system placement (e.g., trailing role tab or `tabViewBottomAccessory`) so the plus renders as a right-side floating control without custom tab bars, GeometryReader layouts, or manual materials. Avoid overriding tab backgrounds so LiquidGlass/LiquidGlassEffect, minimization-on-scroll, spacing, and platform adaptivity are inherited automatically from the iOS 26 SDK. Return the minimal SwiftUI code and brief rationale for why the chosen system placement keeps the UI fully adaptive.” citeturn0search1turn0search2turn0search4


## See Also
- [[chatgpt/chatgpt_automated-role-submission]]
- [[chatgpt/chatgpt_building-role-based-schedule]]
- [[chatgpt/chatgpt_clerk-role-elements]]
- [[chatgpt/chatgpt_job-role-analysis]]
- [[chatgpt/chatgpt_resume-update-bartender-role]]
