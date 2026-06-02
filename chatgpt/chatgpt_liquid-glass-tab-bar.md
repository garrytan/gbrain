---
title: "Liquid Glass Tab Bar"
type: note
created: 2025-11-15
updated: 2025-11-15
source: chatgpt-export
conversation_id: 691908e7-c708-8327-9795-a6423e4f0de2
message_count: 2
tags: [chatgpt, import, code]
---
# Liquid Glass Tab Bar

> Conversation ID: 691908e7-c708-8327-9795-a6423e4f0de2
> Created: 2025-11-15T23:13:55Z
> Updated: 2025-11-15T23:15:08Z
> Messages: 2

---

## User

What is the name for the menu bar in iOS 26 with liquid glass where you have that floating options like in the Apple Health app I have summary and sharing and I have this nice liquid glass floating menu where I can switch between summary and sharing and it animates the little bubble and everything. What is that component called in SwiftUI so that I can use it in my own app?

---

## Assistant

Short version: what you’re looking at in Health is **just the tab bar** in the new **Liquid Glass design**, not a special new “Health-only” control.

On iOS 26, that’s implemented in SwiftUI as a **`TabView` with `Tab` items**. The OS automatically turns it into that floating, glassy, animated bar when you build with the iOS 26 SDK.citeturn6search1turn6search4  

So in SwiftUI you’d do something like:

```swift
struct RootView: View {
    var body: some View {
        TabView {
            SummaryView()
                .tabItem {
                    Label("Summary", systemImage: "heart")
                }

            SharingView()
                .tabItem {
                    Label("Sharing", systemImage: "person.2")
                }
        }
    }
}
```

Build that with Xcode 26, run on iOS 26, and you get:

- The **floating Liquid Glass tab bar**  
- The **bubble-like selection animation**  
- Automatic shrinking/expanding behavior on scroll/search etc., same as in Apple’s own apps.citeturn3search8turn6search7  

If instead you meant the *small pill of options inside a view* (sometimes at the top, not at the very bottom of the screen), that’s a **segmented control**, which in SwiftUI is a `Picker` with `.pickerStyle(.segmented)`. But the “Summary / Sharing” strip in Health that collapses with search is the tab bar, i.e. `TabView`.


## See Also
- [[chatgpt/chatgpt_ios-26-liquid-glass-integration]]
- [[chatgpt/chatgpt_linear-app-liquid-glass]]
- [[chatgpt/chatgpt_liquid-glass-implementation]]
- [[chatgpt/chatgpt_liquid-glass-slider-ui]]
- [[chatgpt/chatgpt_liquid-glass-ux-improvements]]
