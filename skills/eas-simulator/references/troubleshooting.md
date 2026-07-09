# Troubleshooting

Concrete errors seen while validating this flow, and the fix.

| Symptom | Cause | Fix |
|---|---|---|
| `Command simulator:start not found` | `eas-cli` too old (commands are hidden but present from ≥ 20.3.0) | Run via `npx eas-cli@latest …`, or upgrade `eas-cli`. |
| `An Expo user account is required` / `whoami` shows logged-out | No browser login on a cloud/CI/headless box, or `EXPO_TOKEN` unset/invalid | Set **`EXPO_TOKEN`** (expo.dev → Account → Access Tokens) in the env; verify `npx --yes eas-cli@latest whoami`. (Interactive machines can `eas login`.) |
| `simulator:start`/`build`: no linked project / missing `projectId` | A fresh `create-expo-app` isn't linked to EAS | `npx --yes eas-cli@latest init` to create/link it (writes `extra.eas.projectId`). |
| `prebuild`/`eas build` prompts for or fails on a missing **iOS bundle identifier** | A fresh app often has no `ios.bundleIdentifier` | Set it in app config (e.g. `dev.<owner>.<slug>`); confirm via `npx expo config --json` (may live in `app.config.js`). |
| `--max-duration-minutes` rejected, or `simulator:start` denied / not-allowlisted / quota error | The flag is **paid-plan only**, or the experimental feature isn't enabled for the account | Drop `--max-duration-minutes` for the default; check the plan / that EAS Simulator is enabled for the account. |
| `start` keeps "Waiting for … session to be ready" but it never returns | `start`'s readiness poll can miss a session that's actually live | Don't rely on it — poll `npx --yes eas-cli@latest simulator:get --id <id> --json` for `status: IN_PROGRESS` + a populated `remoteConfig`. |
| `ERR_NGROK_3200` / endpoint offline; `Remote daemon is unavailable` | The session's tunnel/daemon dropped — left idle and timed out, or the VM was torn down | A drop invalidates the **whole** session (installed app, `@e` refs, Metro). **Don't retry the failed verb** — start a fresh session, reset the dotenv, and re-run install→open→drive from the top, acting immediately. |
| Two sessions running / orphaned session / surprise double billing | A second `start` (e.g. to "retry" a slow boot) creates a second billed session and overwrites the dotenv id, orphaning the first | Never `start` again to retry — poll the existing session instead. Find orphans with `simulator:list --status IN_PROGRESS` and stop each with `simulator:stop --id <id>`. |
| A device verb hangs (no return for a minute+) | Slow daemon; `press`/`screenshot` can block ~90s | Wrap verbs in `timeout 120 …`; on timeout `snapshot -i` to see if the action landed before retrying (taps can double-fire). Don't blind-retry. |
| `install requires an active session or an explicit device selector` | `install` can't infer the device | Pass `--platform ios` (or `open` something first to establish a session). |
| `Unknown command: tap` | The tap verb is `press` | Use `press <ref\|selector>` (e.g. `press @e2` or `press 'label="Open"'`). |
| `SESSION_NOT_FOUND: No active session. Run open first.` | A verb (e.g. `screenshot`) ran before any app/session was opened | `open <app\|url>` first (or pass `--platform ios`). |
| `simulator:exec` / `build` / `simulator:stop`: "Run this command inside a project directory." | Run from the wrong cwd | Run from the Expo project directory (where `app.json`/`eas.json` live). |
| New session's id shows as the *previous* one; "Overwriting previous simulator session (id: …)" | The stale `.env.eas-simulator` had an old `EAS_SIMULATOR_SESSION_ID`; the warning line masks the new id | Reset the dotenv before `start`: `printf '# managed by eas-cli\n' > .env.eas-simulator`. |
| No `.env.eas-simulator` written after `start` | `--json` suppresses the dotenv | Run `start` *without* `--json` for the `exec` flow; with `--json` you must read `remoteConfig` from stdout and set the env yourself. |
| `pod install` fails: `Unicode Normalization not appropriate for ASCII-8BIT` | Ruby 4 + CocoaPods with a non-UTF-8 locale | Re-run with `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 pod install`. |
| (Mode C) Deep-link `open` lands on the dev-client launcher, not the app | Opening the deep link triggers a system "Open in '<app>'?" dialog; and the launcher only auto-discovers Metro on the LAN | `press 'label="Open"'` to dismiss the dialog, then "Enter URL manually" → `fill` the `https://<host>.on.expo.app` manifest URL → "Connect". |
| (Mode C) App shows expo-router "Unmatched Route" | The connect URL was parsed as a route path | `press 'label="Go back"'` (or navigate to `/`). |
| (Mode C) Dev client shows a `?` placeholder / blank after connect | Bundle not fetched yet | `press 'label="Reload"'` and wait ~40-60s for the first build+transfer over the tunnel. |
| (Mode C) `expo start` fails: "port 8081 already in use" | A Metro is already bound to 8081 (often one from earlier in the session) | Don't relaunch onto it. Reuse if it's yours (`curl -sf localhost:8081/status`), else free it (`PIDS=$(lsof -ti:8081); [ -n "$PIDS" ] && kill $PIDS`) then start one. There is only ever one Metro. |
| (Mode C) `expo start` / `node` killed with **exit 137** | 137 = SIGKILL — almost always the **OOM killer** (memory pressure, common in constrained cloud sandboxes, esp. a native build + Metro at once). **Not** a port clash. | Reduce memory pressure: don't run a native build and Metro concurrently; give the sandbox more memory; retry. |
| (Mode C) Edits won't live-reload no matter how often you reconnect | A **release** build is installed — its JS is baked in, so it ignores Metro | Stop reconnecting: **install the dev (Debug) build**, connect it to Metro, reload. Reconnecting a release build to Metro is a no-op. |
| `expo start --tunnel` errors for a robot/`EXPO_TOKEN` user | The ngrok robot-user guard | Use tunnel v2: `EXPO_UNSTABLE_TUNNEL_V2=1 expo start --tunnel`. |
| Unexpected charges / a session you forgot | `start --non-interactive` does NOT auto-stop | Always `npx --yes eas-cli@latest simulator:stop --id <id>`. List leftovers with `npx --yes eas-cli@latest simulator:list`. |
| Screenshot shows **old content** / my recent edits don't appear | Running a **release build (Mode A/B)** whose JS was baked in *before* your edits — typically a reused/stale build | A/B reflect code at build time, not now. **Rebuild** (ensure the build's fingerprint matches current source), or use **Mode C** (dev + Metro) so live edits show via Fast Refresh. The screenshot itself is fresh — it's the build that's stale. (`9:41` in the status bar is the sim default, not staleness.) |

## Performance expectations

Set the user's expectations honestly — this is experimental:
- **Boot is variable**: ~90s warm to ~15 min cold. Poll patiently.
- **`snapshot` can be slow** on iOS (tens of seconds).
- **First bundle load** over the tunnel (Mode C) is the slow part; subsequent Fast Refreshes are fast.
