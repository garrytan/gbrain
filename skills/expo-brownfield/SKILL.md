---
name: expo-brownfield
description: Framework (OSS). Integrate Expo and React Native into an existing native iOS or Android app. Use when the user mentions brownfield, embedding React Native in a native app, AAR/XCFramework, or adding Expo to an existing Kotlin/Swift project. Covers both the isolated approach and the integrated approach.
---

# Expo Brownfield

A **brownfield** app is an existing native iOS or Android app that adopts React Native incrementally, as opposed to a **greenfield** app that is React Native from day one.

Expo supports two distinct ways to add React Native to a brownfield project:

| Approach       | What ships to the native app                                        | When to choose                                                                   |
| -------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **Isolated**   | Prebuilt AAR / XCFramework                                          | Native team doesn't need Node or RN tooling; RN code can live in a separate repo |
| **Integrated** | React Native sources added to the existing Gradle / CocoaPods build | One team owns everything; comfortable with RN tooling; wants a single build      |

For the full decision matrix, see [./references/comparison.md](./references/comparison.md).

## Pick an approach

Use these quick rules — fall through to `comparison.md` for anything ambiguous.

- **Choose isolated** if the iOS/Android team must consume RN as a regular library dependency (AAR or XCFramework), without installing Node, Yarn, or the React Native build toolchain.
- **Choose isolated** if RN code and native code live in separate repositories or release on independent cadences.
- **Choose integrated** if a single team owns both the native and RN code and is willing to add React Native + Expo to the native project's Gradle and CocoaPods setup.
- **Choose integrated** if you want hot reload and JS source maps to work seamlessly inside the existing native build process.

## References

- ./references/brownfield-isolated.md -- Build RN as AAR/XCFramework and consume from the native app (BrownfieldActivity, ReactNativeViewController, ReactNativeView)
- ./references/brownfield-integrated.md -- Add RN and Expo directly to existing Gradle and CocoaPods builds (ReactActivity, RCTRootView, Podfile)
- ./references/comparison.md -- Decision criteria, trade-offs, and scenario mapping for choosing an approach
- ./references/troubleshooting.md -- Metro connection, build, signing, and module-resolution issues common to both approaches

More information available at https://docs.expo.dev/brownfield/overview/

## Shared prerequisites

Both approaches require, in the environment that _builds_ the React Native side:

- **Node.js (LTS)** — runs the Expo CLI and JavaScript code.
- **Yarn** — manages JavaScript dependencies.

The integrated approach additionally requires **CocoaPods** on iOS (`sudo gem install cocoapods`). The isolated approach does **not** require CocoaPods or any RN tooling in the consuming native app.

## Versioning note

**Expo SDK 55 is the minimum supported version for brownfield integration.** Earlier SDKs lack `expo-brownfield`, the required `ExpoReactHostFactory` / `ExpoReactNativeFactory` entry points, and the current autolinking surface. When creating the Expo project, always pin the SDK explicitly:

```sh
npx create-expo-app@latest my-project --template default@sdk-55
```

Pin the same Expo SDK across both the RN project and any embedded dependencies.


## Contract

This skill guarantees:

- Covers its source domain per the skill description: Framework (OSS). Integrate Expo and React Native into an existing native iOS or Android app. Use when the user mentions brownfield, embedding React Native in a native app, AAR/XCFramework, or adding Expo to an existing Kotlin/Swift project. Covers both the iso
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
