---
name: eas-simulator
description: "EAS service (paid). Run and control a user's app on a remote iOS/Android simulator hosted on EAS cloud. Read before running any `eas simulator:*` commands - it has the current syntax for this experimental API. Use whenever the user needs a simulator they can't run locally - 'run my app on a cloud simulator', 'use eas simulator to run/install/screenshot my app', 'I'm on Linux/Cursor and need an iOS device', 'no sim on this box / headless CI', 'let an agent click through my app and screenshot it', 'test my dev build on a remote sim with live reload', 'stream a sim to my browser' - even when they don't say 'EAS Simulator' or 'cloud'. On a host WITHOUT a local simulator (Linux, CI, cloud sandbox) it's the default; on macOS, do NOT auto-trigger for a plain 'run on the simulator' - use it only for a cloud/remote/shareable sim, an iOS version they lack, or an agent-driven session. NOT for local sims (expo run:ios, Xcode, Android Studio), EAS Build/Update, web preview, or physical devices."
version: 1.0.0
license: MIT
allowed-tools: "Bash(npx *eas-cli@*), Bash(npx *agent-device@*), Bash(npx expo *), Bash(eas *), Bash(expo *), Bash(xcodebuild*), Bash(pod*)"
---

# EAS Simulator

> **EAS service - costs apply.** EAS Simulator runs on Expo Application Services cloud infrastructure, a paid product with free-tier limits; remote simulator sessions use your plan's compute allowance. See https://expo.dev/pricing.

EAS Simulator runs a remote iOS simulator or Android emulator on EAS infrastructure that you drive from your machine — from the CLI, from an AI agent (via `agent-device`), and from a browser preview. It's the unlock for **environments that can't run a simulator locally** (Linux boxes, cloud/background agents like Cursor Cloud), and for letting an agent *verify* a change on a real device instead of only reasoning about code.

The `simulator:*` commands are **experimental and hidden**, and need a recent eas-cli (≥ 20.3.0 as of writing) — which is why this skill runs everything via `npx --yes eas-cli@latest`. Flags and verbs may change; if a command fails, **`<cmd> --help` is authoritative.**

## When to use

The frontmatter `description` carries the trigger phrases. In short: use this to get a user's app onto a **cloud** simulator and interact with it — especially from a Mac-less or cloud/sandbox agent. **Not** for local sims (`expo run:ios`, Xcode, Android Studio), store builds/signing (that's EAS Build), or physical devices. For the macOS case, see *Cloud vs local* next.

## Cloud vs local: decide this first

- **Non-macOS** (Linux / CI / cloud sandbox like Cursor Cloud, detect via `uname -s` ≠ `Darwin`): the only way to get a sim — **just proceed.**
- **macOS:** local sims exist and a cloud session costs money + latency, so **ask first** ("a remote cloud sim — to share a live preview, offload, or test an iOS version you lack — or just run locally?") unless the user explicitly said cloud/remote/shareable.
- Always honor an explicit choice; for "run it locally" hand off to `expo run:ios` / Xcode.

```bash
# Programmatic detection — run this to decide before doing anything else:
if [ "$(uname -s)" != "Darwin" ] || ! xcrun --find simctl &>/dev/null 2>&1; then
  echo "no local sim — proceed with EAS Simulator"
else
  echo "local sim available — ask the user (cloud or local?)"
fi
```

## Prerequisites

- **Run every `eas` command via `npx --yes eas-cli@latest …`** — guarantees a CLI new enough to have `simulator:*` (a global `eas` is often too old), and `--yes` skips npx's prompt. (Bare `eas` is fine if `eas --version` is current.)
- **Authenticated.** Interactive machine → `npx --yes eas-cli@latest login`. **Cloud sandbox / CI / headless agent has no browser login — set `EXPO_TOKEN`** (expo.dev → Account → Access Tokens) in the env instead. Verify either way with `npx --yes eas-cli@latest whoami`.
- Run from an Expo **project directory.** A fresh app needs one-time setup: `npx --yes eas-cli@latest init` to create/link the project (when there's no `projectId`), and **set `ios.bundleIdentifier`** in app config if it's missing — a fresh `create-expo-app` often has none, and `prebuild`/`eas build` need it (they prompt or fail without it; e.g. `dev.<owner>.<slug>`). Read current config with `npx expo config --json` (it may live in `app.config.js`). The first Mode-C run is slow (native build); later runs reuse it.
- A controller to drive the device. This skill uses **agent-device** (open source, MIT), run on demand via `npx agent-device@latest` — nothing globally installed. **argent** is an alternative (`--type argent` in `simulator:start`); see [references/controllers.md](./references/controllers.md).
- **`.env.eas-simulator`** is written/managed by eas-cli (not this skill): it holds the session id (`EAS_SIMULATOR_SESSION_ID`) + the daemon URL/**token**, so `get`/`stop`/`exec` default to that session (usually **omit `--id`**; pass `--id <id>` to target another). It carries a **token → keep it gitignored** (eas-cli marks it "do not commit" but may not add the ignore rule, and a fresh app's `.gitignore` won't cover it — add `.env.eas-simulator` if missing).
- `--max-duration-minutes` is paid-plan only; otherwise a default applies.

## The core loop (always the same)

A session is: **start → (install your app) → drive → stop.** `eas-cli` owns the *session*; the device *verbs* (open/tap/screenshot) come from the controller, which `npx --yes eas-cli@latest simulator:exec` runs for you with the session's connection env loaded.

```bash
# 1. Start a session (boots the remote sim + agent-device daemon; writes .env.eas-simulator).
printf '# managed by eas-cli\n' > .env.eas-simulator   # clear any stale session first
npx --yes eas-cli@latest simulator:start --platform ios --type agent-device --non-interactive
#    Then confirm it's live: simulator:get --json → status IN_PROGRESS (bounded poll in run-your-app.md).

# 2. Drive it through `exec` (loads the session env, then runs the command you give it).
#    agent-device runs on demand via npx — nothing installed globally.
npx --yes eas-cli@latest simulator:exec npx agent-device@latest open <app-or-url> --platform ios
npx --yes eas-cli@latest simulator:exec npx agent-device@latest snapshot -i          # interactive UI tree → @e1, @e2 refs
npx --yes eas-cli@latest simulator:exec npx agent-device@latest press @e2            # tap a ref (NOTE: 'press', not 'tap')
npx --yes eas-cli@latest simulator:exec npx agent-device@latest screenshot ./shot.png

# 3. Stop (ends billing; tears down the VM) and reset the dotenv. Omit --id to target the dotenv session.
npx --yes eas-cli@latest simulator:stop
printf '# managed by eas-cli\n' > .env.eas-simulator
```

To **watch** it live, hand the user the `webPreviewUrl` that `start` prints (an `--type agent-device` iOS session runs serve-sim alongside the daemon, so it emits one — agent control *and* a browser preview in one session; Android has no preview, and `--type serve-sim` is preview-only). **This URL is for the *user's* browser — you cannot open it for them, and it must never touch the sim:**
- **"Open it here" (Cursor/VS Code)** → print the URL on its own line and tell the user to open Simple Browser (`Cmd/Ctrl+Shift+P` → "Simple Browser: Show") and paste it. Then **stop**: do not shell out to a system browser or a Cursor/VS Code URL handler, and do not ask "did a tab appear?" — you can't confirm it, the handoff is done.
- **Never `open` the `webPreviewUrl` on the sim.** It's a browser preview, not a deep link and not an `agent-device open` argument; routing it to the device renders a browser-in-a-browser (a real past failure).
- **Headless agent** (no display) → just return the URL as the deliverable.
- **Keeping it alive for the user to drive** → bound it: start with `--max-duration-minutes N` so it auto-stops; tell them it bills until stopped and when it auto-stops; offer to reopen/extend when it ends. (This is the one case where "stop right away" doesn't apply; one-shot `screenshot`/`get` runs still stop immediately.)

`start` also prints a job-run URL.

## Commands at a glance

| Command | Purpose |
|---|---|
| `npx --yes eas-cli@latest simulator:start --platform ios\|android [--type agent-device\|argent\|serve-sim] [--package-version X] [--max-duration-minutes N] [--non-interactive] [--json]` | Create a session; boot the sim + controller; write `.env.eas-simulator`; print `webPreviewUrl` + job-run URL |
| `npx --yes eas-cli@latest simulator:exec <cmd> [args…]` | Load `.env.eas-simulator`, then run `<cmd>` with that env. The bridge to the controller. |
| `npx --yes eas-cli@latest simulator:get [--id] [--json]` | Session status + connection details. **Use this to confirm readiness** (see *Operating principles*). |
| `npx --yes eas-cli@latest simulator:list [--status …] [--type …] [--platform …]` | List an app's sessions |
| `npx --yes eas-cli@latest simulator:stop [--id]` | Stop a session (idempotent) |

## Running the user's app — pick a mode

The remote sim boots **blank — no Expo Go, no apps.** Install a build, then drive it — but **match the build *type* to the goal first** (the box below); that's where live-session runs derail. Full sequences: [references/run-your-app.md](./references/run-your-app.md) — read before running a mode.

> **Match the build to the goal before installing anything — this is where live-session runs derail.** Two traps, same root (grabbing a build that doesn't fit the request):
> 1. **Wrong type.** Live edits (Mode C) **require a dev build.** A *static* build — a local Release (A), the default EAS sim build (B), or **any build left on the sim from an earlier screenshot run** — freezes its JS at build time and **can never hot-reload.** For a live request, **ignore existing builds entirely** and install a **dev** build (local Debug, or an EAS build with `developmentClient: true`). Never reconnect Metro to a static build hoping it'll reload — it won't.
> 2. **Stale.** A static look must match current source — reuse only a fingerprint-matched build, else build fresh; reuse is explicit-only.
>
> So a leftover EAS/release build is **not** a shortcut for "iterate live" — it's the wrong binary. The fact that a build *exists* never makes it the right one.

| Mode | What it is | Choose when | Live edits? |
|---|---|---|---|
| **A — Local release build** | Build a Release `.app` locally, `agent-device install` it (uploads) | User has a Mac toolchain and wants a quick "run my current code on a cloud device" | No (rebuild to see changes) |
| **B — EAS build** (rare, explicit-only) | `eas build` a simulator build, `agent-device install-from-source <url>` (the VM downloads it) | **Only when explicitly asked** — the user names an existing/EAS build, or wants a static EAS artifact for CI/sharing. Not for "show me"/"iterate" (use C). Sim builds need no credentials. | No |
| **C — Local dev build + tunnel** | Dev (Debug) build + `EXPO_UNSTABLE_TUNNEL_V2=1 expo start --tunnel` + connect the dev client to Metro | **The agentic edit-and-see loop** — change code and see it live (Fast Refresh) | **Yes** |

Quick decision — **default to C; A and B are explicit-only:**
- **C (almost everything):** iterate, interact, poke the app, live edits — *and* most "show me my app" (current code needs a build anyway, so live+current wins). Mac → dev client builds locally; no Mac → build it on EAS (`developmentClient: true`). **Unsure → C.**
- **A:** only an explicit one-shot **static** screenshot on a Mac.
- **B:** only when the user names an existing/EAS build or wants a static EAS artifact (CI/sharing) — see the box above for why a static build is the wrong tool for "iterate."

## Driving the device (agent-device)

`agent-device` is the controller. Common verbs (run each as `npx --yes eas-cli@latest simulator:exec npx agent-device@latest <verb>`):

| Verb | Does |
|---|---|
| `apps --platform ios` | List installed apps (the blank sim shows none) |
| `install <appId> <path> --platform ios` | Install a local `.app` (uploads it) |
| `install-from-source <url> --platform ios` | Install from a URL — the VM downloads it (use for EAS artifacts) |
| `open <appId\|deep-link> --platform ios` | Launch an app (bundle id) or follow an app **deep link** (`exp+slug://…`). **Not** for the `webPreviewUrl` — that's a browser preview for the user, never the device. |
| `snapshot -i` | Interactive accessibility tree → `@e1`-style refs |
| `press <ref\|selector>` | Tap (e.g. `press @e2` or `press 'label="Open"'`) — **the tap verb is `press`, not `tap`** |
| `fill <ref> "text"` | Type into a field |
| `screenshot <path>` | Capture the screen to a local PNG (downloaded from the daemon) — requires an app to be open (`open` first) |
| `metro prepare` / `metro reload` | Point a dev client at Metro / reload (Mode C) |

For the full verb set and the `argent` controller alternative, see [references/controllers.md](./references/controllers.md).

## Operating principles

The non-obvious mental model worth internalizing. Specific error→fix lookups (hung verbs, `tap`→`press`, `--platform`, `--json`, `pod install` locale, orphaned sessions, boot variability) live in [references/troubleshooting.md](./references/troubleshooting.md).

1. **Establish ground truth, then reset — don't patch-loop.** Never assume an existing session or Metro is yours or healthy. Before driving, confirm:
   - **cwd** — you're in the intended Expo project dir (a misdirected `start`/`exec` sessions the *wrong app* + drops a stray `.env.eas-simulator`; `pwd` / check `app.json`).
   - **session live** — `IN_PROGRESS` via `simulator:get --json` (a stopped session keeps its id + `remoteConfig`, so the dotenv alone isn't proof).
   - **one Metro on `:8081`** — reuse if it's yours, else free the port before starting (run-your-app.md).
   - **build fits intent** — a **release build can't live-reload**; if live edits are wanted and a release build is installed, **install the dev build, don't reconnect**.

   If current code isn't rendering after your **first** connect, stop poking live state: **reset to baseline** (stop session → clear dotenv → kill Metro) and redo the mode **once**; a second failure → stop and report. Never restart Metro in place, reconnect more than once, rebuild the native client to fix a JS/connection problem, or surface a preview URL while state is unknown. (A daemon drop — `ERR_NGROK_3200` / `Remote daemon is unavailable` — is the same: reset, don't retry.)
2. **`exec` is a wrapper, not a driver.** `simulator:exec` loads `.env.eas-simulator` and spawns the command you pass; the device verbs come from the controller (`npx agent-device@latest`). There is no `simulator:tap`.
3. **Act immediately; don't park an idle session.** Sessions are short-lived — install and drive right after `start`. Leaving one idle drops the tunnel/daemon (→ reset, per #1).
4. **Stop on every exit path (billing) and reset the dotenv.** `--non-interactive` doesn't auto-stop, and a forgotten session bills until stopped. Don't `start` again to "retry" a slow boot — that orphans a second billed session.
5. **Screenshot only the correct, fresh build.** Mode C only after the dev client connects to Metro; A/B only from a build matching current source — reusing a pre-existing build is the #1 "my edits don't show" cause (see the build caveat above). (`9:41` in the status bar is the sim default, not staleness.)

## Stop and clean up

Stop the session (ends billing) **and reset the dotenv** so a later run doesn't try to reuse the dead session:

```bash
npx --yes eas-cli@latest simulator:stop          # omit --id → stops the dotenv session (or pass --id <id>)
printf '# managed by eas-cli\n' > .env.eas-simulator   # clear the stale session id so it isn't reused
# if you started Metro for Mode C, stop it too (Ctrl+C in its terminal, or kill the expo process)
```

## References

- [references/run-your-app.md](./references/run-your-app.md) — full tested command sequences for modes A, B, and C (read before running a mode).
- [references/controllers.md](./references/controllers.md) — agent-device verb reference and the `argent` alternative.
- [references/troubleshooting.md](./references/troubleshooting.md) — concrete errors and fixes.

Source of truth: Expo docs and the `eas` / `agent-device` CLIs (`npx --yes eas-cli@latest simulator:* --help`, `agent-device --help`). This skill teaches how to apply them; it doesn't replace them.


## Contract

This skill guarantees:

- Covers its source domain per the skill description: "EAS service (paid). Run and control a user's app on a remote iOS/Android simulator hosted on EAS cloud. Read before running any `eas simulator:*` commands - it has the current syntax for this experimental API. Use whenever the user needs a simulator they can'
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
