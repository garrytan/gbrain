---
conversation_id: 691a8292-f414-8328-bc8d-5416d71cae30
created: 2025-11-17
links:
- '[[chatgpt-clusters/coding_ai_ml]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
- code
- long-form
title: Claude prompt for UI
type: guide
updated: 2025-11-17
---

# Claude prompt for UI

**Related:** [[coding_ai]]

> Conversation ID: 691a8292-f414-8328-bc8d-5416d71cae30
> Created: 2025-11-17T02:04:03Z
> Updated: 2025-11-17T02:07:43Z
> Messages: 2

---

## User

{'asset_pointer': 'sediment://file_00000000789c720c99830ce1bd824249', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1278, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 628029, 'width': 589}
{'asset_pointer': 'sediment://file_000000001f2871f59639bf75d0eb70d8', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1278, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 644059, 'width': 589}
look at the current state of our app.

I want the home/metric tab to float bottom left and the floating + button to act at the add entry button floating bottom right.

the final result should look like the attached apple health screenshot were the two tabs are floating bottom left and the search is floating bottom right.

Give me a prompt to give to claude code to modify our current implementation to achieve the result we want. Were building in swift with swift ui. We should lean on system components in ios26 sdk so we get the liquid glasss effects and everything.

Give me the prompt with clear evals

---

## Assistant

Here you go, Mr. White — you can paste this straight into Claude Code:

```text
You are Claude Code, helping me refactor an iOS SwiftUI app called **LogYourBody**.

## Goal

On the main screen of the app (the one that currently shows:
- top segmented buttons: `Home`, `Metrics`, `+ Add Entry`
- cards for Steps / Weight / Body Fat / FFMI

…replace the current top-tab UX with a **bottom-floating layout** similar to the Apple Health “Summary” screen:

- A floating pill-style control in the **bottom-left** for switching between `Home` and `Metrics`.
- A floating circular **“+” button in the bottom-right** that opens our existing `AddEntrySheet` as the **Add Entry** action.
- Use system materials and components from the latest iOS SDK (assume iOS 17+), so we get the native “liquid glass” look.

## Constraints / Implementation Requirements

1. **Locate main container view**
   - Find the SwiftUI view that currently owns the `Home / Metrics / + Add Entry` segmented control at the top of the screen (this is the main metrics/home screen).
   - Do **not** change the data or navigation structure in a breaking way; just refactor layout and wiring.

2. **Bottom-floating shell**

   - Wrap the main content in a `ZStack` or use `.safeAreaInset(edge: .bottom)` so the floating controls sit above scrollable content and respect the home indicator.
   - Implement a small layout similar to:

     ```swift
     .safeAreaInset(edge: .bottom) {
         HStack {
             FloatingTabSwitcher(selectedTab: $selectedTab)   // bottom left
             Spacer()
             AddEntryFloatingButton(onTap: { showAddEntrySheet = true })  // bottom right
         }
         .padding(.horizontal, 16)
         .padding(.bottom, 12)
     }
     ```

3. **Floating tab switcher (bottom-left)**

   - Create a reusable `FloatingTabSwitcher` view with an `enum MainTab { case home, metrics }` and `@Binding var selectedTab`.
   - Appearance / behavior:
     - Capsule-shaped container.
     - `background(.ultraThinMaterial)` with a subtle shadow and smooth corner radius to mimic the Apple Health pill.
     - Two segments: `Home` and `Metrics` (text + SF symbol optional).
     - Tapping a segment updates `selectedTab` and visually highlights the selected one (e.g. filled pill for selected, dimmed for unselected) using system colors (`.tint`, `.primary`, `.secondary`), not hard-coded custom colors.
     - Works in light & dark mode.

4. **Floating Add Entry button (bottom-right)**

   - Create a reusable `AddEntryFloatingButton`:
     - A circular button pinned bottom-right (via the HStack above).
     - `background(.ultraThinMaterial)` clipped to a `Circle()` with a subtle shadow.
     - Centered `Image(systemName: "plus")` with accessible size.
   - When tapped, it should present **our existing `AddEntrySheet`**:
     - Add `@State private var isPresentingAddEntry = false` to the main screen.
     - Attach `.sheet(isPresented: $isPresentingAddEntry)` that presents `AddEntrySheet(isPresented: $isPresentingAddEntry, initialTab: 0)` (or whatever default tab makes sense).
     - Ensure the sheet uses the existing `AuthManager` environment object.

5. **Remove old top tabs**

   - Remove or refactor the old top segmented/tab UI for `Home / Metrics / + Add Entry` so that:
     - Only `Home` and `Metrics` remain as tabs, controlled by the new bottom `FloatingTabSwitcher`.
     - `+ Add Entry` no longer appears as a tab; that action is exclusively the floating `+` button bottom-right.

6. **Content switching**

   - Implement content switching with a `switch` on `selectedTab` in the main screen body:

     ```swift
     switch selectedTab {
     case .home:
         HomeViewContent()
     case .metrics:
         MetricsViewContent()
     }
     ```

   - Reuse the existing subviews you find in the project; do not duplicate metric-card logic.

7. **Use system components**

   - Prefer:
     - `Material` backgrounds (`.ultraThinMaterial` or `.regularMaterial`),
     - `.safeAreaInset(edge: .bottom)`,
     - `Label`, `Button`, `Capsule`, `Circle`,
     - SF Symbols (`house`, `chart.bar`, `plus`) as appropriate.
   - No custom blur implementations or third-party dependencies.

8. **Accessibility & ergonomics**

   - Ensure:
     - Hit targets are at least ~44x44 points.
     - Add `accessibilityLabel` for the tab switcher segments and the Add Entry button (e.g. “Add entry”, “Home tab”, “Metrics tab”).
     - The floating controls do not overlap the Dynamic Island or home indicator and look correct on iPhone 13/14/15 simulators.

## Evals / Acceptance Criteria

After making changes, the following must all be true:

1. **Layout & look**
   - On the main screen, the top `Home / Metrics / + Add Entry` control is gone.
   - A pill-shaped `Home / Metrics` control is visible in the **bottom-left**, floating above content with a glassy Material background.
   - A circular floating `+` button is visible in the **bottom-right**, also with a glassy Material background.
   - Both controls look good in light and dark mode without manual color overrides.

2. **Behavior**
   - Tapping `Home` shows the Home content that previously corresponded to the “Home” tab.
   - Tapping `Metrics` shows the Metrics content that previously corresponded to the “Metrics” tab.
   - Tapping the floating `+` presents `AddEntrySheet` modally, using the existing implementation.
   - Dismissing `AddEntrySheet` returns to the same main screen, with floating controls still visible and working.

3. **System integration**
   - Layout uses `.safeAreaInset(edge: .bottom)` (or an equivalent system API) rather than hard-coding offsets.
   - Backgrounds use `.background(.ultraThinMaterial)` or `.regularMaterial` with `Capsule()`/`Circle()` clipping and a subtle shadow, not custom blur code.

4. **Technical quality**
   - The project builds with **no new warnings or errors** for the current iOS deployment target.
   - There are no Auto Layout or SwiftUI runtime layout warnings in the Xcode console when running the main screen.
   - The bottom-floating controls do not overlap the home indicator or get clipped when scrolling.

Please:
- Make minimal, targeted edits (no full-file rewrites).
- Show the final diff or the updated Swift files for the main screen and any new views (`FloatingTabSwitcher`, `AddEntryFloatingButton`).
```


**Topic:** [[chatgpt-clusters/coding_ai]]


## See Also
- [[chatgpt/chatgpt_ai-prompt-for-claude]]
- [[chatgpt/chatgpt_claude-design-logo-prompt]]
- [[chatgpt/chatgpt_claude-prompt-generators]]
- [[chatgpt/chatgpt_admin-dashboard-prompt]]
- [[chatgpt/chatgpt_agent-mode-prompt]]
