# Running your app on the remote sim — tested sequences

The remote sim boots blank. You install a **simulator-targeted** build onto the session, then open it. Pick a mode from `SKILL.md`. (Sequences validated against eas-cli 20.3.x + agent-device 0.17.x in mid-2026; the commands are experimental — if one fails, re-check `<cmd> --help`.)

In all modes, the session is started the same way and driven through `npx --yes eas-cli@latest simulator:exec`. Replace `dev.example.app` with the app's iOS `bundleIdentifier` (from `app.json` → `ios.bundleIdentifier`), and run from the project directory.

> These sequences are **iOS**. For **Android**: build via `npx --yes eas-cli@latest build --platform android` (or local Gradle), `install` the `.apk` instead of an `.app`, skip `pod install`, and note there's **no `webPreviewUrl`** (Android is agent-driven / screenshot-only).

## Starting a session (shared by all modes)

```bash
# Reset the dotenv first so the new session id isn't masked by an "Overwriting previous session" warning.
printf '# managed by eas-cli\n' > .env.eas-simulator

# Start (no --json, so it writes .env.eas-simulator). It boots the sim + agent-device daemon.
npx --yes eas-cli@latest simulator:start --platform ios --type agent-device --non-interactive
```

`start`'s own poll is unreliable, so confirm liveness with a bounded loop (boot is ~90s–15min). `get`/`exec`/`stop` default to the session in `.env.eas-simulator`, so you can omit `--id`:

```bash
# Poll up to ~16 min; IN_PROGRESS + remoteConfig = live; a terminal status = failed boot (stop + restart).
for i in $(seq 1 64); do
  S=$(npx --yes eas-cli@latest simulator:get --json --non-interactive 2>/dev/null)
  echo "$S" | grep -q '"status": *"IN_PROGRESS"' && echo "$S" | grep -q remoteConfig && { echo "live"; break; }
  echo "$S" | grep -qE '"status": *"(STOPPED|ERRORED)"' && { echo "boot failed — stop + restart"; break; }
  sleep 15
done
```

If you need the id explicitly, it's `EAS_SIMULATOR_SESSION_ID` in `.env.eas-simulator`. `start` also prints a `webPreviewUrl` (iOS-only browser preview — surface it per the SKILL.md "watch it live" rules) and a job-run URL. Once live, the session env is in `.env.eas-simulator`, so `simulator:exec` works.

---

## Mode A — Local release build (embedded JS, no Metro)

A Release build bundles the JS into the binary, so it renders without Metro. Good for a quick "run my current code on a cloud device" when a Mac toolchain is available.

```bash
# 1. Generate native project + build a Release simulator .app
npx expo prebuild --platform ios          # set ios.bundleIdentifier in app.json first to avoid prompts
# pod install can fail on Ruby 4 + CocoaPods with a Unicode/ASCII-8BIT error — fix with a UTF-8 locale:
( cd ios && LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 pod install )
LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 xcodebuild \
  -workspace ios/<App>.xcworkspace -scheme <App> \
  -configuration Release -sdk iphonesimulator -derivedDataPath ios/build build
# → ios/build/Build/Products/Release-iphonesimulator/<App>.app

# 2. Start a session (see "Starting a session" above), then install + open + drive
APP=ios/build/Build/Products/Release-iphonesimulator/<App>.app
npx --yes eas-cli@latest simulator:exec npx agent-device@latest install dev.example.app "$APP" --platform ios
npx --yes eas-cli@latest simulator:exec npx agent-device@latest open dev.example.app --platform ios
npx --yes eas-cli@latest simulator:exec npx agent-device@latest screenshot ./shot.png

# 3. Stop
npx --yes eas-cli@latest simulator:stop          # omit --id → stops the dotenv session
```

The `install` here **uploads** the (~90MB) `.app` to the remote daemon over the tunnel, which installs it on the sim with `simctl`.

---

## Mode B — EAS build (the VM downloads it; no credentials)

**Explicit-only** (see the SKILL.md mode picker): a *static* EAS artifact for CI/sharing, or when the user names an existing EAS build. For no-Mac **live** iteration use Mode C with an EAS dev-client build (see Mode C below), not this. **Simulator builds are unsigned, so EAS asks for no credentials.**

⚠️ **Check for an existing build first.** Before triggering a new build, check if a fingerprint-matched one already exists — it saves ~15-20 min:

```bash
npx --yes eas-cli@latest build:list --platform ios --profile <your-sim-profile> --status finished --json | \
  head -20   # look for a sim build whose fingerprint matches current source
```

If one matches, skip straight to step 3 with its artifact URL.

⚠️ **Order matters:** build FIRST, `start` the session LAST. The build takes ~15-20 min and a session left idle that long times out (`ERR_NGROK_3200`) — don't `start` until you have the artifact URL.

```bash
# 1. Find or create a simulator build profile in eas.json.
#    Read eas.json if it exists and look for a build profile with ios.simulator: true.
#    If one exists, note its name and skip to step 2.
#    If not, add one named "sim" — use node, python3, jq, or a direct JSON edit, whichever
#    is available. Preserve all other profiles. Minimum: { "ios": { "simulator": true } }

# 2. Build (no credentials prompt for a simulator build). Prints an artifact URL when done (~15-20 min).
npx --yes eas-cli@latest build --platform ios --profile sim --non-interactive
# → https://expo.dev/artifacts/eas/<hash>.tar.gz

# 3. Start a session, then install-from-source so the VM downloads the artifact (no local upload)
ART="https://expo.dev/artifacts/eas/<hash>.tar.gz"
npx --yes eas-cli@latest simulator:exec npx agent-device@latest install-from-source "$ART" --platform ios
npx --yes eas-cli@latest simulator:exec npx agent-device@latest open dev.example.app --platform ios
npx --yes eas-cli@latest simulator:exec npx agent-device@latest screenshot ./shot.png

# 4. Stop
npx --yes eas-cli@latest simulator:stop          # omit --id → stops the dotenv session
```

**Build freshness:** reuse only a build whose **fingerprint matches current source** (`npx --yes eas-cli@latest build:list --platform ios --json`, or `get-build` by fingerprint per Callstack's public `eas-agent-device` workflow); otherwise **rebuild** or use Mode C. Tell the user which build you used. (Why this matters → SKILL.md "Reusing an existing build" caveat.)

---

## Mode C — Local dev build + tunnel (live edits via Fast Refresh)

This is the agentic edit-and-see loop: a **dev (Debug) build** loads JS from your local **Metro** over **tunnel v2**, so code edits appear on the remote sim via Fast Refresh. It has the most steps — each is necessary.

⚠️ **Don't install a release build as a "quick interim" and screenshot it** — that interim shows stale, build-time code (the "outdated screenshot" trap). Go straight to the dev build + Metro; screenshot only after the dev client is connected to Metro.

**No local Mac toolchain?** (the common cloud/Linux case) Build the dev client on **EAS** instead of step 1 below. ⚠️ Same order-matters rule as Mode B: build first, start the session after you have the artifact URL.

```bash
# ── Non-Mac path: replace step 1 with these ──────────────────────────────────

# Find or create a dev-client simulator build profile in eas.json.
#    Read eas.json if it exists and look for a build profile with developmentClient: true + ios.simulator: true.
#    If one exists, note its name and skip to the build step.
#    If not, add one named "dev-sim" — use node, python3, jq, or a direct JSON edit, whichever
#    is available. Preserve all other profiles. Minimum: { "developmentClient": true, "ios": { "simulator": true } }

# Build (~15-20 min). Prints an artifact URL when done.
npx --yes eas-cli@latest build --platform ios --profile dev-sim --non-interactive
# → https://expo.dev/artifacts/eas/<hash>.tar.gz

# Start a session AFTER the build finishes (don't start early — idle sessions time out).
# Then in step 3 below, use install-from-source (VM downloads the artifact) instead of local install:
ART="https://expo.dev/artifacts/eas/<hash>.tar.gz"
npx --yes eas-cli@latest simulator:exec npx agent-device@latest install-from-source "$ART" --platform ios
# Continue from step 3a (open the dev client, enter Metro URL) onward — identical to the Mac path.
```

```bash
# 1. Add expo-dev-client and build a Debug (dev-client) simulator .app
npx expo install expo-dev-client
npx expo prebuild --platform ios --clean   # set ios.bundleIdentifier first (as in Mode A) to avoid prompts
( cd ios && LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 pod install )
LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 xcodebuild \
  -workspace ios/<App>.xcworkspace -scheme <App> \
  -configuration Debug -sdk iphonesimulator -derivedDataPath ios/build-debug build
DEVAPP=ios/build-debug/Build/Products/Debug-iphonesimulator/<App>.app

# 2. Start Metro with tunnel v2 — exactly ONE instance. First check :8081:
#    `curl -sf localhost:8081/status` answers AND it's your Metro → reuse it, skip this step.
#    Port taken but NOT yours → `PIDS=$(lsof -ti:8081); [ -n "$PIDS" ] && kill $PIDS` BEFORE starting
#    (relaunching onto an occupied 8081 is the "port already in use" clash). A bare `&` won't survive across agent
#    shell calls — use a long-lived/background run or a separate terminal. tunnel v2 (durable-object,
#    not ngrok) works from robot/cloud agents where plain --tunnel is blocked.
EXPO_UNSTABLE_TUNNEL_V2=1 npx expo start --tunnel --port 8081
#    → note the deep link exp+<slug>://<host>.on.expo.app; the manifest URL is https://<host>.on.expo.app

# 3. Start a session, install the dev build, then connect it to Metro.
#    RELIABLE path = "open the dev client, then Enter URL manually". The deep-link + system "Open in
#    '<app>'?" dialog is flaky: the dialog may not appear, and `press 'label="Open"'` can hang ~90s
#    against a slow daemon. Don't make the loop depend on it.
#    The button labels below ("Enter URL manually"/"Connect"/"Reload"/"Go back", and the system "Open")
#    are expo-dev-client / iOS / expo-router UI — the same across ANY Expo app (not app-specific), but
#    UI text that can shift across versions. Treat them as illustrative: if a label doesn't match,
#    `snapshot -i` and press the current ref. The flow matters, not the exact strings.
npx --yes eas-cli@latest simulator:exec npx agent-device@latest install dev.example.app "$DEVAPP" --platform ios

#    a) launch the dev client (it opens its launcher, which only auto-discovers LAN Metro — ours is remote):
npx --yes eas-cli@latest simulator:exec npx agent-device@latest open dev.example.app --platform ios

#    b) point it at your remote Metro via "Enter URL manually":
npx --yes eas-cli@latest simulator:exec npx agent-device@latest press 'label="Enter URL manually"'
npx --yes eas-cli@latest simulator:exec npx agent-device@latest snapshot -i          # get the text-field ref
npx --yes eas-cli@latest simulator:exec npx agent-device@latest fill @<field> "https://<host>.on.expo.app"
npx --yes eas-cli@latest simulator:exec npx agent-device@latest press 'label="Connect"'

#    c) first-run dev menu → Reload to fetch the bundle (first build+transfer over the tunnel ~40-60s):
npx --yes eas-cli@latest simulator:exec npx agent-device@latest press 'label="Reload"'

#    d) expo-router may show "Unmatched Route" (the connect URL was parsed as a path) → go to home:
npx --yes eas-cli@latest simulator:exec npx agent-device@latest press 'label="Go back"'

# 4. Edit a source file locally → Fast Refresh pushes it to the remote sim with NO reload. Screenshot to confirm.
npx --yes eas-cli@latest simulator:exec npx agent-device@latest screenshot ./live.png

# 5. Stop the session AND Metro
npx --yes eas-cli@latest simulator:stop          # omit --id → stops the dotenv session
# kill the `expo start --tunnel` process
```

Notes:
- The launcher's auto-discovery only scans the LAN, so a remote Metro must be entered via "Enter URL manually" — that's why this is the connect step.
- **This "Enter URL manually" + public tunnel URL flow is the ONLY connect path.** If it fails, don't switch mechanisms or reconnect in a loop — reset to baseline and redo Mode C once (SKILL.md principle 1). (`agent-device`'s `metro prepare --proxy-base-url` bridge exists but is not part of this loop.)
