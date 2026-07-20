---
name: expo-ui
description: "Framework (OSS). Build native UI with the @expo/ui package: real SwiftUI on iOS and Jetpack Compose on Android rendered from React in an Expo or React Native app. Covers universal cross-platform components (Host, Column, Row, Button, Text, List, and more imported from @expo/ui), drop-in replacements for popular React Native community libraries (BottomSheet, DateTimePicker, Slider, Menu, etc.), and platform-specific SwiftUI (@expo/ui/swift-ui, iOS only) and Jetpack Compose (@expo/ui/jetpack-compose, Android only) trees and modifiers. Use when adding or reviewing @expo/ui Host/RNHostView trees, building native-feeling UI where standard React Native components fall short (grouped settings forms with toggles, sections, menus, sheets, pickers, sliders), choosing between universal and platform-specific components, or replacing an RN community UI library with a native @expo/ui equivalent. Not for custom native modules, Expo Router navigation, Reanimated, or data fetching."
version: 1.0.0
license: MIT
allowed-tools: "Bash(node *expo-ui/scripts/list-components.js *)"
---

# Expo UI (`@expo/ui`)

`@expo/ui` renders real native UI from React: SwiftUI on iOS, Jetpack Compose on Android. Start with its universal components (one tree for iOS, Android, and web) and drop to platform-specific SwiftUI/Jetpack Compose only when the universal layer falls short. It also ships drop-in replacements for migrating off RN community UI libraries.

> These instructions track the latest Expo SDK. The **universal** layer requires **SDK 56+**. Drop-in replacements and the platform-specific layers also exist on SDK 55. For component details on a specific SDK, refer to the Expo UI docs for that version.

## Installation

```bash
npx expo install @expo/ui
```

On SDK 56, `@expo/ui` works in Expo Go, so `npx expo start` runs it directly — no custom build required. On older SDKs, build a dev client first (`npx expo run:ios` / `npx expo run:android`).

Every `@expo/ui` tree — universal or platform-specific — must be wrapped in `Host`.

## Choosing an approach (read this first)

Work down this list and stop at the first layer that meets the need:

1. **Universal components — start here.** Import from the `@expo/ui` root. One component tree runs unmodified on iOS, Android, and web from a single source (Compose on Android, SwiftUI on iOS, `react-native-web`/`react-dom` on web). No platform file splits. → `./references/universal.md`

2. **Platform-specific (SwiftUI / Jetpack Compose).** Import from `@expo/ui/swift-ui` or `@expo/ui/jetpack-compose`. Use **only** when the universal layer is missing a component or modifier you need, or when you need platform-specific behavior or optimization. **Downside:** you write two trees and split them into `.ios.tsx` / `.android.tsx` files (or branch on `Platform.OS`) — more code to maintain.

   > **`@expo/ui/swift-ui` is iOS-only. `@expo/ui/jetpack-compose` is Android-only.** Importing either in a file that runs on the other platform will crash at runtime with "Unable to get view config" errors. Isolate platform-specific trees in `.ios.tsx` / `.android.tsx` files placed in `components/` (never inside `app/` — Expo Router does not support platform extensions for route files), or guard with `Platform.OS` in a regular route file. `Host` must always be imported from `@expo/ui` (the universal package root), not from the platform-specific sub-packages. → `./references/swift-ui.md` and `./references/jetpack-compose.md`

**Already using an RN community UI library?** `@expo/ui` also ships **drop-in replacements** — API-compatible swaps for popular libraries (`@gorhom/bottom-sheet`, `@react-native-community/datetimepicker`, and more), imported from `@expo/ui/community/<name>`. This is a migration side-path for replacing an existing dependency, not a step in the universal-vs-platform decision above. → `./references/drop-in-replacements.md`

## References

Consult these resources as needed:

```
references/
  universal.md             Universal @expo/ui components and when to use them (SDK 56+)
  drop-in-replacements.md  API-compatible replacements for RN community UI libraries
  swift-ui.md              Platform-specific iOS UI: @expo/ui/swift-ui components, modifiers, RNHostView, useNativeState
  jetpack-compose.md       Platform-specific Android UI: @expo/ui/jetpack-compose components, modifiers, LazyColumn caveat, icons, useNativeState
```


## Contract

This skill guarantees:

- Covers its source domain per the skill description: "Framework (OSS). Build native UI with the @expo/ui package: real SwiftUI on iOS and Jetpack Compose on Android rendered from React in an Expo or React Native app. Covers universal cross-platform components (Host, Column, Row, Button, Text, List, and more impo
- Loads only task-relevant references/scripts and keeps context lean.
- Produces concrete, source-grounded output: exact commands, code snippets, app configuration, token values, or platform steps as applicable.
- Never fabricates APIs, configuration keys, UI tokens, store metadata, or platform behavior not present in the source references or current project.

## Output Format

Lead with the actionable result. For implementation tasks, return the changed files/commands and verification result. For design/mobile guidance, return concise token/component/platform steps grounded in the skill references. Avoid dumping complete reference files; cite the relevant path and extract only the decisive snippet.

## Anti-Patterns

- Inventing APIs, store metadata, UI tokens, or platform capabilities.
- Copying large references into the response when a targeted excerpt is enough.
- Applying this skill outside its domain when a more specific skill exists.
- Skipping verification commands or platform checks after making changes.
