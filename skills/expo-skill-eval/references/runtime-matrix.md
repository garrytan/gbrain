# Runtime applicability matrix

Which `plugins/expo/skills/*` skills can be evaluated at which level. Consult this before writing eval cases — putting `runtime.mode: "expo-go"` on a skill that needs custom native code wastes a device cycle and produces a misleading FAIL.

Modes:

- **expo-go** — generated code runs in Expo Go on simulator/emulator; screenshot grading applies.
- **static-only** — stop after the static gate (`tsc` / lint / `expo export`). Used when the output needs custom native code, a dev build, or produces no UI at all.
- **n/a** — the skill's output is not app code (config, CI YAML, CLI workflows); code evals don't apply, or apply only as file-content assertions without a fixture app.

| Skill | Mode | Platforms | Notes |
|-------|------|-----------|-------|
| expo-router | expo-go | ios, android | Navigation/routing target: routes, links, native stacks, modals, sheets, headers. Native tabs sections may need a dev build — verify per case. |
| expo-native-ui | expo-go | ios, android | Core target for visual evals. RN primitives + styling/controls/media/animations all work in Expo Go. |
| expo-tailwind-setup | expo-go | ios, android, web | NativeWind v5 / react-native-css are JS-level; works in Expo Go. Good web candidate too. |
| expo-data-fetching | expo-go | ios, android | Fetch/React Query/SWR are pure JS. Mock or use stable public endpoints so evals are deterministic. |
| expo-dom | expo-go | ios, android, web | DOM components run in a webview on native (Expo Go, SDK 52+) and as-is on web. Allow extra settle time for the webview to paint. |
| eas-hosting | static-only + HTTP | — | No screenshot: while Metro runs, `curl` the route and save the response as an output file for grading. |
| expo-ui (merged swift-ui + jetpack-compose) | expo-go | ios, android, web | `@expo/ui` ships in the SDK 56 default template (~56.0.17) and its native code is included in Expo Go 56 — verified rendering 2026-06: a SwiftUI Form renders in Expo Go on the iOS simulator. The **universal** components (`Host`, `Row`, `Column`, `Button`, `List`, …) also render on **web**; only the platform-specific `@expo/ui/swift-ui` (SwiftUI) and `@expo/ui/jetpack-compose` (Compose) trees are native-only and render blank on web. Pick platforms by what the eval case uses. |
| expo-module | static-only | — | Custom native modules can't load in Expo Go. Gate on TS compile of the module API; native compilation (prebuild + xcodebuild/gradle) is possible but expensive — out of scope for now. |
| expo-app-clip | static-only | — | App Clip targets require prebuild + Xcode. Assert on config-plugin output instead. |
| expo-brownfield | static-only | — | Brownfield integration has no Expo Go story. Assert on generated integration files. |
| expo-dev-client | n/a | — | Output is build/distribution workflow, not renderable app code. |
| eas-app-stores | n/a | — | Deployment guidance; assert on transcript/config content only. |
| eas-workflows | n/a | — | Output is `.eas/workflows/` YAML; assert on YAML content (and `workflow_validate` via the Expo MCP if available). |
| expo-upgrade | static-only | — | An upgrade eval can run the static gate on the upgraded fixture — a strong signal. Needs a fixture pinned to an *older* SDK (pass e.g. `55` to make-fixture.sh). |
| eas-update-insights | n/a | — | CLI/metrics interpretation; no app code output. |
| eas-observe | expo-go (verify) | ios, android | `expo-observe` instrumentation is JS-level, but confirm the package works in Expo Go before relying on screenshots; fall back to static-only. |

Entries marked "verify" haven't been validated against a real run yet — confirm on first use and update this table.

## Image-prompt (clone-this) candidates

Image prompts (`reference_image` — build an app to match a target screenshot, graded by `reference_match` + `references/design-rubric.md`) are most informative for the **visual** skills — `expo-router`, `expo-ui`, `expo-tailwind-setup`, `expo-dom` — where reproducing a specific UI is the point. Pair them with "Runtime + screenshots" so the harness captures the generated app to compare against the target. They add nothing for `n/a` skills (no app UI).
