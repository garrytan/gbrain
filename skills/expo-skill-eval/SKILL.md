---
name: expo-skill-eval
description: Evaluate Expo skills in this repo end-to-end - trigger accuracy, generated code quality, and runtime screenshots on iOS simulator and Android emulator via Expo Go (web optional). Use when the user wants to eval an Expo skill, test that a skill produces working code, benchmark a skill with device screenshots, or verify a skill's output renders correctly.
version: 1.0.0
license: MIT
allowed-tools: "Read(~/.cache/expo-skill-eval/**), Read(/tmp/expo-skill-eval-*/**), Read(/private/tmp/expo-skill-eval-*/**), Write(/tmp/expo-skill-eval-*/**), Write(/private/tmp/expo-skill-eval-*/**), Edit(/tmp/expo-skill-eval-*/**), Edit(/private/tmp/expo-skill-eval-*/**), Bash(python3 /tmp/expo-skill-eval-*), Bash(python3 /private/tmp/expo-skill-eval-*), Bash(python3 *expo-skill-eval/scripts/*), Bash(tee /tmp/expo-skill-eval-*), Bash(tee /private/tmp/expo-skill-eval-*), Bash(bash *expo-skill-eval/scripts/*)"
---

# Expo Skill Eval

Evaluates skills in `plugins/expo/skills/` for trigger accuracy, generated code quality, and/or runtime rendering in Expo Go.

Requirements: macOS with Xcode (iOS simulators), Android SDK with at least one AVD, and `bun`. No other device tooling is assumed.

Workspace root: `/private/tmp/expo-skill-eval-<skill-name>/iteration-N/` (e.g. `/private/tmp/expo-skill-eval-expo-ui/iteration-4/`).

## Before starting — clarify scope

**Confirm all of the following up front, before any pipeline work — don't skip any** (only skip a given item if the request already states that choice). Batch them into `AskUserQuestion` calls of ≤4 questions each, in this order:

1. **Which skill** to eval (if not clear from the request).
2. **Prompts** — which prompts drive the eval. Built-in prompts (from the skill's eval cases) are **pre-selected all**; drop any, add a custom text prompt, or **build from an uploaded screenshot** (a target UI the skill must reproduce). See **Prompts** below.
3. **What to verify** — one multi-select of three options: Runtime + screenshots / Trigger accuracy / Code checks (no device). See *What to verify* below.
4. **Expo SDK** — latest (default, auto-detected) or a pinned version.
5. **Runner** — Expo Go (default) or development build.
6. **Platforms** — iOS / Android / web (always offer all three).
7. **Permission flag** for `claude -p` — skip-permissions (default) or accept-edits.
8. **Viewer delivery** — local only (default) or publish a shareable Artifact.
9. **If trigger accuracy is selected** — confirm the published `expo` plugin is disabled (or not installed).

Each is detailed below. Items 4–6 (SDK, runner, platforms) fit naturally in one `AskUserQuestion` call.

**If the skill to eval is not clear from the request**, list available skills from `plugins/expo/skills/` and ask which one to evaluate.

**How the skill under test is loaded — two mechanisms, one per phase** (don't pick one globally): executor runs reference it by **file path** (`SKILL_PATH = plugins/expo/skills/<skill>/SKILL.md`, read explicitly), while the trigger eval loads it as a **plugin** (`--plugin-dir plugins/expo`, so the model can auto-select it from its description). Both point at the *local, in-repo* version — that's what you're evaluating. You do **not** need any special flag to *launch* the harness session itself (the harness finds the skill by repo path); the mechanisms apply to the `claude -p` subprocesses it spawns. See steps 1 and 3 for why each phase differs. **One pre-run check (required when the trigger eval is in scope):** if the *published* `expo` plugin is installed/enabled, disable it (via `/plugin`) **before launching** the harness and re-enable after. A single disable is a global-config change that both this session and the spawned `claude -p` subprocesses inherit. Why it's required for the trigger eval: that phase loads the local skill via `--plugin-dir`, and a second installed `expo` collides with it — the model may trigger the *published* `expo:expo-ui`, and since detection only sees the tool-call name you'd silently score the published description instead of your local edits (the collision could also just error). The **executor / runtime / static** phases are *not* affected — they read the skill under test by its local `SKILL_PATH` with no `--plugin-dir` — so a run with no trigger eval can skip the disable. Disabling `expo` does **not** disable `expo-skill-eval` (a standalone project skill, not part of the `expo` plugin), so the harness stays available.

**Surface this to the user as an explicit up-front confirmation** — the same way you confirm which skill to eval. When the trigger eval is in scope, ask the user to confirm the published `expo` plugin is disabled (or not installed) *before* you start step 1; if it's still enabled, pause and have them disable it via `/plugin`. Don't run the trigger eval until they confirm — the harness can't reliably detect installed plugins on its own (reading the global plugin config or `claude plugin list` would prompt), so this is a manual confirmation, not an auto-check.

**Pick the prompts — built-in, custom, or a target screenshot.** The prompts are the *inputs* that drive the executor (with-skill and without-skill); they are separate from what you *verify*. Confirm them with `AskUserQuestion` (skip if the request already names a prompt):

- **Built-in prompts** — representative prompts you generate by reading the skill under test (its `SKILL.md` + `references/`) and `references/runtime-matrix.md`, covering the skill's standard use cases. (If the skill already ships eval cases under `evals/evals.json`, fold their `prompt` fields in too — but most skills don't, so you usually derive them.) **Pre-select all** so the default run exercises the skill's standard cases; let the user deselect any.
- **Custom text prompt** — a one-off prompt the user types. Don't spend a dedicated option slot on this: `AskUserQuestion` auto-adds a **"Type something"** / Other entry, and anything typed there becomes a custom text case.
- **Build from an uploaded screenshot** — the user gives the path to a **target screenshot** (a UI to reproduce). The executor is told to open it — `claude -p` reads PNGs with its Read tool — and build an app matching it; the case records the path as `reference_image`, and grading compares the generated app to that target (step 6). This is the strongest visual test for a UI skill: "build *this*."

**Respect `AskUserQuestion`'s 4-option-per-question cap with this priority** (the bug to avoid: the upload option silently dropped once the four slots fill up):

1. **Always reserve a slot for "Build from an uploaded screenshot."** It's the whole point of the visual eval and must never be the option that gets dropped.
2. **Don't add an explicit "Custom text prompt" option** — the auto "Type something" / Other entry already covers it.
3. Fill the remaining ≤3 slots with the built-in/representative prompts, **pre-selected**. If there are more than 3, collapse them into one pre-selected **"All built-in prompts (default)"** option and offer subset-picking in a short follow-up, so the upload option still fits.

Present it as a **multi-select**. When "Build from an uploaded screenshot" is picked, ask for the target image path in a follow-up. Each selected prompt (built-in, typed, or image) becomes one eval case (run with-skill and without-skill).

**Always confirm what to verify** unless the request makes it unambiguous. Present these options and let the user pick one or more (defaults in bold based on the skill's `references/runtime-matrix.md` entry):

| Option | What it does | When to suggest as default |
|--------|-------------|---------------------------|
| **Runtime + screenshots** | Full pipeline: fixture → executor → static gate → run the app on iOS/Android and screenshot it. The runner (Expo Go or dev build) is a separate question — don't name it here. | **Default** for any skill that renders an app screen (the `expo-go`/`dev-build` rows in `references/runtime-matrix.md`). Requires a booted simulator/emulator. |
| **Trigger accuracy** | Run realistic prompts via `claude -p`, check whether the skill is read. Measures recall (should-trigger queries only). | Always useful as a standalone check. |
| **Code checks (no device)** | `tsc --noEmit` + diff-aware lint + `expo export`, plus the grader checks the generated code against any custom expectations you provide. No device. | **Default** for `static-only` and `n/a` skills, and whenever you want to verify code patterns (correct import path, a `Host` wrapper, …) without running the app. |
**Present these as ONE multi-select question — *"What do you want to verify?"*** These are *grading dimensions* (how to judge what gets built) — distinct from the **Prompts** phase (what to build). The user may pick any combination. When a prompt is an **uploaded screenshot** (see **Prompts**), include **"Runtime + screenshots"** so the harness captures the generated app and the grader can score it against the target.

Read `references/runtime-matrix.md` to find the skill's default mode before suggesting. If the request already specifies a mode (e.g. "just check if it triggers", "run it on device"), skip the question and proceed.

**Pick the Expo SDK version — once, up front.** Detect the latest with `bash /abs/path/expo-skill-eval/scripts/latest-sdk.sh` (it prints the major, e.g. `56`; internally it uses `bun` to run `npm view expo dist-tags --json` and read the major via `JSON.parse`/`semver`, and it's covered by the bash-scripts rule — so don't run the registry query inline yourself, which would prompt). Then confirm with `AskUserQuestion`: default to that latest SDK, or let the user pin an older one (e.g. to reproduce a version-specific issue). Use the chosen version everywhere the fixture is built — pass it as the `<sdk>` arg to `make-fixture.sh` and write it into each eval case's `runtime.sdk`. If the request already names a version ("eval on SDK 54"), skip detection and use it.

**Default to the latest** — it stays compatible with the Expo Go that `expo start` installs on the device. Pinning an SDK *older* than the device's installed Expo Go makes `expo start` try to prompt "Install the recommended Expo Go version?"; with no TTY (the snapshot scripts read stdin from `/dev/null`) it dies with `Input is required, but 'npx expo' is in non-interactive mode` and **every snapshot fails**. So only pin an older SDK when you also pre-install a matching Expo Go on the simulator/emulator — otherwise stick with latest.

**Pick the runner — Expo Go (default) or a development build.** Ask with `AskUserQuestion` (skip if the request already says which):

- **Expo Go (default)** — the snapshot scripts run the app with `expo start --ios` / `expo start --android` as-is. Fast (no native compile), and it runs anything Expo Go bundles (including `@expo/ui` on SDK 56+). Cannot run custom native code (expo-modules, config plugins, native deps not in Expo Go).
- **Development build** — the snapshot scripts run `expo run:ios` / `expo run:android` instead, compiling a native dev client per fixture. Use this for skills whose output needs custom native code (the cases that would otherwise be `static-only`). Much slower — `expo run` prebuilds and natively compiles each fixture (minutes, especially the first), and needs the full iOS/Android build toolchain — so only choose it when the skill actually requires native code. **Disk-heavy:** each fixture's native build is multi-GB. The snapshot phase runs `clean-fixture.sh` after each fixture to keep peak usage to ~one build, but still prefer fewer eval cases and a **single platform** for dev-build runs, and keep a few GB free. `clean-fixture.sh` removes the per-fixture build *output* (`node_modules`, `ios`, `android`, `.expo`, `dist`, and the fixture's iOS DerivedData) and keeps the app source + git. The lever for dev-build disk is **fewer eval cases + one platform** — it only reclaims per-fixture build output and never touches shared dependency caches, so nothing gets re-downloaded.

Pass the choice to the snapshot scripts via the `EXPO_SKILL_EVAL_RUNNER` env var (`expo-go` default, or `dev-build`), and reflect it in each eval case's `runtime.mode` (`expo-go` or `dev-build`). See step 5.

**Pick the platforms — always ask, regardless of skill.** Offer iOS / Android / web (multi-select) with `AskUserQuestion`; default to iOS + Android, but always present web as an option — don't pre-filter by skill. **Web is a valid choice for most skills**: `@expo/ui`'s *universal* components (`Host`, `Row`, `Column`, `Button`, `List`, …) render on web, as do `expo-dom`, NativeWind/Tailwind, API routes, and plain React Native. The only thing that won't show on web is a *platform-specific* native tree (`@expo/ui/swift-ui` or `@expo/ui/jetpack-compose`), which renders blank there — and that blank is itself a useful signal, so it's still the user's call. Web runs via `snapshot-web.sh` (`expo start --web` + Playwright/Chromium) **regardless of the runner** (`expo run` is native-only; there's no web dev build), and it's the least-exercised path. Write the chosen set into each eval case's `runtime.platforms` and have `run_snapshots.py` loop them.

**Confirm how `claude -p` subprocesses run — once, before starting.** Ask with `AskUserQuestion` whether they may run with `--dangerously-skip-permissions`, then apply the same answer to every subprocess this run (never re-prompt mid-run):

- **Skip permissions (recommended)** — pass `--dangerously-skip-permissions`. Each subprocess runs unattended inside a throwaway fixture under `/private/tmp/expo-skill-eval-*` and can write files and run setup commands without prompting.
- **Accept edits only** — pass `--permission-mode acceptEdits` instead. Bash/installs are auto-denied (no TTY), so some evals may produce partial output.

A bare `claude -p` with neither flag can't write files at all. If the request already states a preference ("skip permissions", "don't use the dangerous flag"), skip the question.

**Confirm how to deliver the results viewer — once, up front.** Publishing to claude.ai is outward-facing, so never do it mid-run by surprise; ask in the same up-front `AskUserQuestion` (alongside the permission flag):

- **Local only (default)** — `generate_viewer.py` writes `viewer.html` and opens it in the local browser. Nothing leaves the machine.
- **Publish a shareable Artifact** — additionally render the viewer to a claude.ai Artifact (a default-private web page the user can share with teammates) at the very end. Only do this if the user opts in here.

If the request already says whether to share/publish, skip the question. See the **Viewer** section for the publish mechanics.

## Eval case schema

You generate the run's eval cases — one per chosen prompt — and write them to `<workspace>/iteration-N/evals.json` (the viewer reads them from there). Each case extends the standard skill-creator eval-case shape with a `runtime` block and visual expectations:

```json
{
  "id": 1,
  "prompt": "Build me a settings screen with a dark mode toggle and a list of options",
  "expected_output": "Working Expo Router screen",
  "expectations": [
    "Uses Expo Router file-based routing",
    "TypeScript compiles with no errors"
  ],
  "runtime": {
    "mode": "expo-go",
    "platforms": ["ios", "android"],
    "sdk": "56"
  },
  "visual_expectations": [
    "No red error screen or Expo Go error overlay on any platform",
    "A settings screen with a visible toggle control is rendered"
  ]
}
```

- `runtime.mode`: how the eval runs after the static gate —
  - `"expo-go"`: run in Expo Go (`expo start --<platform>`) and screenshot. Fast, JS-only. **Default.**
  - `"dev-build"`: build a native dev client (`expo run:<platform>`) and screenshot. For skills whose output uses custom native code; much slower (native compile per fixture).
  - `"static-only"`: stop after the static gate — for skills that produce no UI, or when you don't want to run a device at all (CI).

  Consult `references/runtime-matrix.md` for which repo skills support which mode. (`dev-build` lets you actually run skills that previously had to be `static-only` for needing native code.)
- `runtime.platforms`: subset of `ios`, `android`, `web` — chosen up front (always offered, not gated on the skill; see **Before starting**). Defaults to `["ios", "android"]`.
- `runtime.sdk`: Expo SDK major for the fixture app — set it to the version chosen up front (see **Before starting — clarify scope**). Omit to use the latest template.
- `reference_image` (optional — **image prompt**): absolute path to a **target screenshot** the skill must reproduce. When set, the executor is told to open it (via its Read tool) and build a matching app, and the grader scores how closely the generated app reproduces it (step 6) on top of the usual expectations. Set in the **Prompts** phase via "build from an uploaded screenshot."

An image-prompt case is a normal case with `reference_image` set; enable "Runtime + screenshots" so the harness captures the result to compare against the target:

```json
{
  "prompt": "Build an app whose UI matches the attached reference screenshot.",
  "reference_image": "/abs/path/to/target.png",
  "runtime": { "mode": "expo-go", "platforms": ["ios"], "sdk": "56" },
  "visual_expectations": ["Matches the reference's layout, components, and color treatment"]
}
```

## Pipeline per eval case

**Orchestration model — on the main thread you run `python3 <orchestrator>` and almost nothing else.** Every phase is driven by a small Python orchestrator you `Write` into the workspace and run with `python3 /private/tmp/expo-skill-eval-<skill>/<phase>.py` (covered by the `python3` rule). The orchestrators are the **only** place the `scripts/*.sh` files are invoked — always via `subprocess.run(["bash", "<scripts>/<name>.sh", …])`, which runs as a child of `python3` and needs no rule of its own — and the only place parallelism, logging, and directory creation live. So on the main thread you only ever: **Write** orchestrators, **run** them with `python3`, **inspect** outputs with the `Read`/`Glob`/`Grep` tools, and **spawn the grader subagent**. Never put a command inside a chained/backgrounded/piped shell construct, and never run ad-hoc `mkdir`/`ls`/`cat`/`tail`/`echo` — that is what prompts. (A single standalone `bash …/scripts/<name>.sh …` is fine for one-off manual debugging, e.g. re-running one flaky snapshot, but the pipeline itself goes through the orchestrators.) **Run each orchestrator in the foreground** — let the tool call block until it finishes; the orchestrators already parallelize *within* a phase, so you don't need to overlap phases. Do **not** shell-background a phase with `… & echo "$!"` / `wait` (the `&`, `echo`, and `wait` segments have no rule and prompt). If you genuinely must run a phase while continuing other work, use the **Bash tool's `run_in_background` parameter** on a plain `python3 <orchestrator> 2>&1 | tee <ws>/…log` call — never hand-rolled shell `&`. **Expect exactly one permission prompt at the very start:** the first `Write` into the workspace. `allowed-tools` can suppress `Bash`/`Read` but not `Write`/`Edit`, so choose **"allow all edits in this directory for the session"** on that first prompt — it covers every orchestrator, `evals.json`, and viewer file for the whole run.

### 0. Workspace setup

Create the run's directory tree once, with the workspace script — **never with ad-hoc `mkdir`** (a raw `mkdir` prompts: there is no `mkdir` rule, and a `"$WORKSPACE/…"` variable can't match a path glob anyway):

```bash
bash /abs/path/expo-skill-eval/scripts/make-workspace.sh /private/tmp/expo-skill-eval-<skill> iteration-N <num-evals>
```

This creates `trigger-evals/scratch` and `iteration-N/eval-<i>/{with_skill,without_skill}/outputs` for every eval. It is covered by `Bash(bash *expo-skill-eval/scripts/*)`, and the `mkdir`s inside run as children of the script (no rule of their own). After this, every other directory is made by the scripts/orchestrators that need it (`make-fixture.sh`, the executor orchestrator's `os.makedirs`, the snapshot scripts) or by the `Write` tool auto-creating parents — so you never need another `mkdir`.

### 1. Trigger eval (should-trigger only)

Write a `run_trigger_eval_real.py` script under the workspace's `trigger-evals/` directory. Use **only `"should_trigger": true` queries** — the expo plugin is a family of complementary skills, so multiple skills triggering on the same prompt is not a failure. Measure recall only: realistic prompts that should use the skill, scored by trigger rate.

The script should run `claude -p <query>` per query (with `--output-format=stream-json --verbose --include-partial-messages`, `CLAUDECODE` stripped from the env, and the permission flag confirmed up front in **Before starting — clarify scope**) and detect whether the target skill was triggered by watching for its `Skill` or `Read` tool call in the stream. Note: `--include-partial-messages` requires both `--output-format=stream-json` and `--verbose` — omitting either causes an immediate CLI error.

**Load the skill under test — pass `--plugin-dir` to every trigger subprocess.** The trigger eval measures whether the skill's *description* makes the model reach for it, so the subprocess must have the **local** skill (the version with your edits) loaded. A `claude -p` subprocess does **not** inherit the parent session's `--plugin-dir`, so add it explicitly: `--plugin-dir <plugin-root>`, where `<plugin-root>` is the **absolute** path to the plugin directory that owns the skill — the `plugins/expo` ancestor containing `.claude-plugin/plugin.json` (e.g. `--plugin-dir /Users/.../skills/plugins/expo`). It must be absolute: the subprocess runs from the throwaway `scratch/` cwd, so a relative `plugins/expo` won't resolve — and a missing plugin dir silently loads nothing, which masquerades as a 0% trigger rate. Then watch for the skill triggering under its plugin-qualified name (`<plugin>:<skill>`, e.g. `expo:expo-ui`). Two caveats: (1) if the **published** `expo` plugin is also installed globally, disable it (via `/plugin`) for the run and re-enable after — otherwise two copies of `expo` collide in the subprocess and the model may trigger the *published* `expo:expo-ui`, silently scoring its description instead of your local edits (trigger detection only sees the tool-call name, so it can't tell the copies apart; dev checkouts usually don't have it installed). (2) Never make a synthetic duplicate of the skill — a real loaded copy always wins, so the synthetic harness scores 0%. (Executors are unaffected by an installed plugin: they read the local `SKILL_PATH` directly and pass no `--plugin-dir`.)

Run each query's subprocess from an empty throwaway cwd (e.g. `trigger-evals/scratch/`), not the repo root. A should-trigger prompt like "build me a settings screen" can make the subprocess write files, and with `--dangerously-skip-permissions` those writes would otherwise land in the skills repo. Trigger detection only needs the skill's `Skill`/`Read` call to appear in the stream — it doesn't need a fixture — so any incidental writes are throwaway.

Set a per-query subprocess timeout of at least **300 seconds**. A 180s limit is too short — some queries cause the model to start generating code before triggering the skill, which pushes total runtime past 3 minutes.

Run trigger evals once per skill, not per code eval case.

### 2. Fixture

Each executor run gets a fresh Expo app, created by `scripts/make-fixture.sh <app-path> <sdk> [clean|full]`:

```bash
scripts/make-fixture.sh <workspace>/iteration-N/eval-X/<config>/app <sdk>          # blank app (default)
scripts/make-fixture.sh <workspace>/iteration-N/eval-X/<config>/app <sdk> full     # keep example tabs
```

The script creates the app with `bunx create-expo-app -t default@sdk-<version>` (or the latest template when no version is given) once per SDK version + variant, caches it under `~/.cache/expo-skill-eval/fixtures/`, and clones the cache with APFS copy-on-write — so the first run per variant pays the install cost and every later run is near-instant. The default `clean` variant runs the template's `reset-project` script, so executors start from a blank app and every screen in the output is theirs — a much cleaner grading signal. Use `full` only when the eval prompt assumes an existing app (e.g. "I have an app with two tabs..."). The script also resets git inside the clone, so `git diff` in the app shows exactly what the executor changed (useful evidence for the grader).

**Build fixtures sequentially, then fan out executors — never create fixtures concurrently.** `make-fixture.sh` shares a cache under `~/.cache/expo-skill-eval/fixtures/` keyed by SDK+variant. If two runs both find the cache cold and call `bunx create-expo-app` at the same time, bun's link step collides and one fails with `EEXIST` / "could not determine executable to run for package create-expo-app". So in the executor orchestrator (step 3), create **all** fixtures one at a time first — a plain Python loop calling `subprocess.run(["bash", "<scripts>/make-fixture.sh", app, sdk, variant])` (where `sdk` is the version chosen up front) — *then* fan out the `claude -p` executors with a `ThreadPoolExecutor`. Sequential creation is cheap: only the first fixture per SDK+variant pays the install cost; the rest are ~1s APFS clones. (And never fan fixtures out with ad-hoc shell like `make-fixture.sh A & make-fixture.sh B & wait` — the `&`/`wait` segments prompt; the sequential Python loop avoids both the race and the prompt.)

### 3. Generate (executor subagents)

Run executors as `claude -p` subprocess calls from a Python script, **not** via the `Agent` tool. The `Agent` tool spawns subagents with their own permission context — file edits inside the fixture app will prompt the user. A `claude -p` subprocess is a separate process outside the permission system entirely (the same pattern the trigger eval harness uses).

Write a Python script to `/private/tmp/expo-skill-eval-<skill>/run_executors.py`. **First create every run's fixture in a sequential loop** — `subprocess.run(["bash", "<scripts>/make-fixture.sh", app, sdk, variant], …)` one at a time (concurrent creation races the shared bun cache — see step 2). **Then** run the with-skill and without-skill `claude -p` calls in parallel via a `ThreadPoolExecutor`. Both phases live inside Python (covered by the `python3` rule), so nothing runs as ad-hoc shell on the main thread. Each executor prompt must include:

- The skill path (with-skill runs only) and the eval prompt.
- **Image-prompt cases (`reference_image` set):** the absolute path to the target screenshot plus an instruction like "Open the reference screenshot at `<path>` with your Read tool and build an app whose UI matches it as closely as you can — layout, components, spacing, and colors." (`claude -p` renders PNGs read this way, so the executor can actually see the target.)
- The fixture app path: "Make your changes inside `<app-path>`. The project already exists and has dependencies installed. Use absolute paths for all file operations."
- "Before writing any files, inspect the project layout — run `ls`, read `package.json` and `app.json` — to find the correct routes directory. Recent SDK default templates place Expo Router routes in `src/app/`; older ones use `app/` at the project root — inspect to confirm which this fixture uses."
- "Do NOT start the dev server, boot simulators, or take screenshots — the harness does that after you finish."
- Where to save a short summary of what was built.

Flags for the `claude -p` subprocess:
- Strip `CLAUDECODE` from the environment (`env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}`) — otherwise `claude -p` hangs silently when nested inside a running Claude Code session.
- A permission flag, confirmed with the user up front (see **Before starting — clarify scope**): either `--dangerously-skip-permissions` or `--permission-mode acceptEdits`. Bake the chosen flag into the generated script. A bare `claude -p` with neither flag can't write files — it has no TTY to approve the edit and emits code as text instead.
- **Do NOT pass `--plugin-dir` to executors** (unlike the trigger eval). The with-skill run already reads the skill by its absolute `SKILL_PATH`, so it tests the local content directly; and the without-skill run must have **no** skill available at all — loading the plugin would let the skill auto-trigger and contaminate the baseline. Keeping executors path-based also cleanly separates the two questions: the executor measures *content quality* (is the skill useful once read?), the trigger eval measures *triggering* (does the description get it picked?).

Capture stdout/stderr per run to a log file next to the fixture for grading evidence. Set timeout to 900s per executor — with-skill runs read multiple reference files before coding and regularly take 5–10 minutes.

### 4. Static gate

Write `run_static.py` and run it with `python3`. For each eval/config app it calls `subprocess.run(["bash", "<scripts>/check-static.sh", app, "ios,android"], capture_output=True, …)` across a `ThreadPoolExecutor` (static gates are independent — run them concurrently *inside Python*, never with shell `&`/`wait`), and writes each result to `eval-<i>/<config>/static.json` (exit code + captured output) for the grader.

`check-static.sh` runs `tsc --noEmit`, `expo lint`, and `expo export` for the listed platforms. A passing export catches most import/syntax/missing-module failures without touching a device; a failing export short-circuits step 5 with a clean FAIL — record it and have the snapshot orchestrator skip that app.

### 5. Run + screenshot (serial across evals)

Write `run_snapshots.py` and run it with `python3`. Simulators and emulators are shared resources, so this orchestrator runs **serially** (no thread pool): for each app that passed the static gate, and each platform, it `os.makedirs` the `outputs/` dir and calls `subprocess.run(["bash", "<scripts>/snapshot-<platform>.sh", app, f"{outputs}/<platform>.png", port], env={**os.environ, "EXPO_SKILL_EVAL_RUNNER": runner}, …)`. Pass the port as a positional argument: use `8081` for iOS and `8082` for Android — `expo run:ios/android --port N` is supported and using separate ports lets you run both platforms without port collisions if you ever parallelize. Screenshots land in the run's `outputs/` directory so the viewer renders them inline.

**Reclaim disk after each fixture — essential for `dev-build` runs.** Once all selected platforms for an app are captured (and *before* the next fixture builds), call `subprocess.run(["bash", "<scripts>/clean-fixture.sh", app])`. Each `expo run:<platform>` leaves multi-GB native build output (iOS Pods + DerivedData, Android Gradle build); without this, evals × configs × iterations pile up and fill the disk mid-run (the instability you'll see is the disk filling). `clean-fixture.sh` removes the heavy regenerable dirs (`node_modules`, `ios`, `android`, `.expo`, `dist`) and the fixture's iOS DerivedData, keeping the app source + git so the grader's `git diff` still works. With serial snapshots + per-fixture cleanup, peak disk stays at ~one fixture's build instead of all of them. (Harmless for `expo-go` runs too — they just have little to reclaim.)

`runner` is the up-front choice (`expo-go` default, or `dev-build`). The snapshot scripts honor `EXPO_SKILL_EVAL_RUNNER`: `expo-go` launches with `expo start --<platform>` (and the Expo Go install/deep-link dance); `dev-build` launches with `expo run:<platform> --port <port>`, which compiles+installs a native dev client and skips the Expo Go steps. The scripts already default the `dev-build` timeout to 900s, but bump `EXPO_SKILL_EVAL_BUNDLE_TIMEOUT` higher if the first native compile needs it. `make-fixture.sh` pre-installs `expo-dev-client` in every fixture so the dev-client URL scheme is registered before `expo run` tries to deep-link the app open.

**Snapshot scripts always capture the initial route `/`.** They open the app via a deep link and take one screenshot — they cannot tap or navigate. Design eval prompts so the feature under test renders at the root route. If the executor places the main UI behind a navigation action (e.g. an "Open Settings" button on the index), the snapshot will miss the feature entirely and all visual expectations will fail.

Each `snapshot-<platform>.sh` **frees its Metro port on startup** (kills any stale process left on it by a crashed prior run) and tears Metro down on exit — so you never need to run `lsof`/`kill`/`pkill` yourself to clear ports (that would prompt, and it's already handled). It then starts Metro, waits for the "Bundled" line in the Metro log, settles, captures a screenshot, and tears Metro down. iOS boots the newest available iPhone simulator if none is booted; Android boots the first AVD if no device is attached (the slow path — boot once and reuse across the whole iteration). Android first **recycles a wedged/`offline` emulator** (graceful `adb emu kill`, then force-kill + adb reset) so a half-dead instance can't poison the run, and boots with **hardware GPU** (`-gpu host`, Metal-accelerated on Apple Silicon). If `host` self-aborts the emulator on a given machine (qemu `SIGABRT` deep in gfxstream/Metal — possible on Apple Silicon under load), edit `GPU_MODE` in `snapshot-android.sh` to a software mode (`guest` renders reliably but slowly — bump the settle; avoid `swiftshader_indirect`, which **hangs at boot** on arm64). `snapshot-web.sh` runs only when `platforms` includes web. Each script writes a Metro log next to the screenshot (`<name>.metro.log`) — include it in the grader's inputs. If a script exits non-zero it still attempts a best-effort screenshot (an error screen is evidence too). **dev-build relaunch:** after Metro is up, the scripts relaunch the app via `xcrun simctl launch` (iOS) and `adb shell am start -n <pkg>/.MainActivity` (Android) — both avoid the "Open in X?" system dialog that a URL-scheme deep link triggers on first launch.

After all screenshots for the iteration are captured, always generate the viewer — pass the workspace root to the checked-in script:

```bash
python3 /abs/path/expo-skill-eval/scripts/generate_viewer.py /private/tmp/expo-skill-eval-<skill>
```

It writes `viewer.html` into the workspace root (one level above `iteration-N/`) and opens it in the browser itself (via `webbrowser.open`) — so no separate `open` command (and no `Bash(open:*)` rule) is needed. See the **Viewer** section below.

### 6. Grade

Spawn a grader subagent in the foreground. Its prompt must include:

- The eval prompt, expectations list, and visual_expectations from the eval case.
- The instructions in `agents/visual-grader.md` (screenshot grading, redbox detection).
- The screenshot files, Metro logs, and the step-4 `static.json` as inputs.
- **Image-prompt cases** (case has `reference_image`): also include the **target screenshot** (`reference_image`), `references/design-rubric.md`, and the fixture's `git diff`. Tell the grader to compare the generated screenshot(s) to the target and emit the `reference_match` + `quality` blocks below.

The grader writes `grading.json` next to the outputs with this shape:
```json
{
  "score": 8.5,
  "max_score": 9,
  "expectations": [
    {"text": "...", "passed": true, "evidence": "..."}
  ],
  "reference_match": {
    "score": 7, "max": 10,
    "evidence": "ios.png vs target.png: same two-section grouped list + toggle; accent color differs (blue vs target's green); row spacing tighter than target"
  },
  "quality": {
    "dimensions": [
      {"name": "Layout & hierarchy", "score": 2, "max": 3, "evidence": "ios.png: …"}
    ],
    "subtotal": 17,
    "max": 24,
    "summary": "…"
  },
  "user_notes_summary": {"needs_review": false, "notes": ""}
}
```
Visual expectations go into the same `expectations` array with evidence naming the screenshot file and describing what is visible. The `reference_match` block (how closely the generated app reproduces the target screenshot) and the `quality` block (design-rubric scores from `references/design-rubric.md`) are emitted **only for image-prompt cases** — or when a quality grade is explicitly requested. Omit both for plain text-prompt runs.

## Rollout phases

Build out and debug the pipeline in this order — each phase is independently useful:

1. **Static**: steps 1–4 only (`runtime.mode: "static-only"` for everything). No devices needed; CI-friendly.
2. **iOS**: add `snapshot-ios.sh` to the loop. `simctl` is the most scriptable target.
3. **Android**: add `snapshot-android.sh`. Emulator boot is the slowest part — keep one emulator running for the whole session.
4. **Web**: add `snapshot-web.sh` for skills that target web (uses Playwright via `bunx`; first run downloads Chromium).

## Practical notes

- **Temp locations**: all eval workspaces go under `/private/tmp/expo-skill-eval-<skill-name>/iteration-N/`. Everything in this run — `Read`, `Write`, `Edit`, and `Bash` — is covered by the `allowed-tools` frontmatter, so a correctly-loaded skill runs prompt-free.
- **Permission rule forms (why this skill stays prompt-free)**: the rule *syntax* matters and the two tool families behave differently:
  - **`Bash(...)` rules — path-scoped to the skill's own code (no broad interpreters).** `Bash(python3 /private/tmp/expo-skill-eval-*)` (plus the `/tmp` alias) runs the Python orchestrators you generate under the workspace; `Bash(python3 *expo-skill-eval/scripts/*)` runs the checked-in `scripts/generate_viewer.py`; `Bash(tee /private/tmp/expo-skill-eval-*)` (+ `/tmp`) lets `python3 … 2>&1 | tee <workspace>/…log` write a log without prompting; `Bash(bash *expo-skill-eval/scripts/*)` runs only this skill's `scripts/*.sh`. Because every path is pinned, the escape hatches stay denied: `python3 -c …`, `bash -c …`, `tee /etc/…`, and running code anywhere else do **not** match (verified empirically — a scoped rule allows `bash <dir>/run.sh` but blocks `bash -c …` and any other path). Commands the scripts call internally — `bunx`, `xcrun simctl`, `adb`, `git`, `mkdir`, `expo` — are children of the script, not Bash tool calls, so they need no rule. Do **not** run ad-hoc `mkdir`/`ls`/`find`/`cat`/`grep` from the main thread (they have no rule and prompt — and a raw `mkdir "$WORKSPACE/…"` can't match a path glob because the path is an unexpanded variable): create the directory tree with `make-workspace.sh` (step 0), let orchestrators create their own dirs (`os.makedirs`), and **inspect results with the `Read`/`Glob`/`Grep` tools** (no Bash rule needed).
  - **Bash rule matching (tested, non-obvious):** a Bash rule is a gitignore-style glob over the command string. `*` matches any run of characters **including `/` and spaces** and works **mid-pattern** — so `Bash(python3 /private/tmp/expo-skill-eval-*)` matches `python3 /private/tmp/expo-skill-eval-x/run.py 2>&1`, and `Bash(bash *expo-skill-eval/scripts/*)` matches `bash /any/abs/path/expo-skill-eval/scripts/foo.sh args`. Two gotchas that burned earlier attempts: `**` is matched **literally** (never use it in a Bash rule), and the `:*` suffix only works right after the command token (`Bash(python3:*)`) — **not** after a partial path (`Bash(python3 /path-:*)` does not match). Compound commands split on `|`, `&&`, `||`, `;`, `&` and each segment needs its own matching rule.
  - **`Read` rules suppress prompts; `Write`/`Edit` rules do *not*.** This is a Claude Code asymmetry (not a pattern bug, and not reload — in a session where the `Bash`/`Read` rules from this same frontmatter are clearly working, `Write` still prompts): file creation/editing always goes through Claude Code's edit-approval flow regardless of `allowed-tools`. The frontmatter still scopes `Read`/`Write`/`Edit` to `…/expo-skill-eval-*/**` (both the `/tmp` and `/private/tmp` forms, since macOS doesn't auto-resolve the symlink) as documentation and a guardrail, but those `Write`/`Edit` entries won't silence the prompt on their own. **Practical consequence:** at the start of a run you get **one** Write prompt for the workspace — choose **"Yes, allow all edits in this directory for the session"** and every later orchestrator / `evals.json` / viewer write under that workspace goes through silently. That single directory approval, not a rule, is what makes file-writing prompt-free.
  - **Reload after editing frontmatter — a full restart, not `/reload-skills`.** `allowed-tools` is read once when the skill loads at session start; `/reload-skills` reloads the skill *body* but does **not** reliably refresh the permission rules. After editing this file, **quit Claude Code entirely and start a new session**, then re-run the skill — otherwise a stale (cached) ruleset keeps prompting even though the file on disk is correct.
  - **Grader subagents** run with their own permission context and will still prompt for file access — that is expected and separate from the main thread's rules.
- **Calling eval scripts — one standalone command, never chained.** Invoke each script as its own Bash call with an absolute path: `bash /abs/path/expo-skill-eval/scripts/snapshot-ios.sh arg1 arg2` (covered by `Bash(bash *expo-skill-eval/scripts/*)`). Do **not** combine it with `&`, `&&`, `||`, `;`, `wait`, `tail`, `head`, or `echo` — compound commands are checked per segment, and those extra segments have no rule, so the whole thing prompts even though the `bash …/scripts/…` part is allowed. (The one allowed pipe is `… 2>&1 | tee <workspace>/…log`, since the scoped `tee` rule covers it.) Need parallelism or output trimming? Put it in a Python orchestrator (covered by `python3 /…/expo-skill-eval-*`), which runs scripts via `subprocess` across a `ThreadPoolExecutor`. Inspect results with the `Read`/`Glob`/`Grep` tools, not `cat`/`ls`/`grep`. **General rule: under this skill's tight scoping, any ad-hoc shell the agent improvises will prompt — the fix is to move it into a script/orchestrator (or use the scoped `tee`), never to broaden a rule.**
- **Inspecting outputs (screenshots, logs, files) — use tools, not shell.** To find files use the **Glob** tool (e.g. `/private/tmp/expo-skill-eval-<skill>/iteration-N/**/ios.png`); to view them use the **Read** tool — Read renders PNGs visually, which is exactly what you need to confirm a screenshot rendered. To search file contents use **Grep**. Never use `find`/`ls`/`cat` for this: they prompt, and `find … -exec …` is deliberately *not* allowed because its `-exec` can run anything (e.g. `-exec rm`). These tools are scoped and prompt-free; reach for them every time you'd otherwise type `find`/`ls`/`cat`.
- **Generated Python scripts**: write orchestration/aggregation scripts under the workspace (e.g. `/private/tmp/expo-skill-eval-<skill>/aggregate.py`) and run them with `python3` (covered by `Bash(python3 /private/tmp/expo-skill-eval-*)`). The viewer is the exception — it's the checked-in `scripts/generate_viewer.py`, run via `Bash(python3 *expo-skill-eval/scripts/*)`. `Write` auto-creates parent dirs but prompts the first time — approve the workspace directory once (see the `Write`/`Edit` note above). Capture output either by having the script write its own log or via `python3 … 2>&1 | tee <workspace>/…log` (covered by the scoped `tee` rule); read logs back with the `Read` tool. Don't use `python3 -c …` for setup (the scoped rule only matches a workspace script *path*, so a bare `-c` prompts).

- **Trigger evals vs installed plugin**: detect the real installed skill name (e.g. `expo:expo-ui`) in the stream — a synthetic-duplicate harness always scores 0% when the real plugin is installed because the model picks the genuine skill over the synthetic copy.
- **Benchmark aggregation**: save each run's `grading.json` + `timing.json` under `eval-<N>/<config>/run-1/`. Write a Python aggregation script under the workspace and run it with `python3`.
- **Expo Go ceiling**: anything requiring custom native code (expo-module, App Clips, brownfield) cannot run in Expo Go. Use `static-only` mode for those — see `references/runtime-matrix.md` before writing eval cases for a skill (note: `@expo/ui` *does* run in Expo Go on SDK 56+).
- **API-route skills**: instead of a screenshot, verify with `curl` against the route while Metro is up; record the response as an output file for grading.
- **Timing data**: capture token counts and duration into `timing.json` immediately after each executor run — it is not recoverable later. To capture token counts, add `--output-format=stream-json --verbose` to the executor `claude -p` call and parse the `message_start` / `message_delta` events from the log. Without these flags the log only contains prose and elapsed seconds are the only recoverable metric.
- **First-launch dialogs**: Expo Go occasionally shows a one-time prompt on a fresh simulator. If a screenshot captures a dialog instead of the app, re-run the snapshot script (it reopens the URL) and re-capture.

## Viewer

After taking screenshots, always generate and open the HTML viewer so the user can see results immediately without being asked. The viewer is the checked-in `scripts/generate_viewer.py` — run it with the workspace root as its argument:

```bash
python3 /abs/path/expo-skill-eval/scripts/generate_viewer.py /private/tmp/expo-skill-eval-<skill>
```

It writes a self-contained `/private/tmp/expo-skill-eval-<skill>/viewer.html` and opens it in the browser itself (`webbrowser.open`). What it renders:
- A tab per iteration (`iteration-*` under the workspace root; remembers the last active tab in `localStorage`).
- For each eval case (read from `<iteration>/evals.json`): side-by-side with_skill / without_skill columns, each showing static-gate status, score, the platform screenshots (click to zoom; embedded as base64 `data:` URIs so the file is self-contained), the expectation list with PASS/FAIL badges, and reviewer notes.
- For **image-prompt cases** (a `grading.json` with `reference_match` / `quality`): the **target screenshot** beside the generated ones, the `reference_match` score (generated vs target), the `quality` rubric per config (one bar per dimension with its score/max plus the subtotal), and the **quality delta** (with_skill − without_skill subtotal) in the summary bar alongside the correctness delta.
- A summary bar with with_skill %, without_skill %, and delta.
- A trigger accuracy table when `trigger-evals/trigger_results.json` exists.
- A dark background with color-coded scores (green ≥85%, amber ≥65%, red below).

### Publishing the viewer (only if opted in up front)

The local `viewer.html` is always generated. **Only when the user chose "Publish a shareable Artifact"** in the up-front confirmation, additionally render it to a claude.ai Artifact at the very end — never publish without that opt-in (it's outward-facing and a published page can be cached/indexed). Mechanics:

- The `Artifact` tool wraps the file in its own `<!doctype html>…<head></head><body>` skeleton, so the file you hand it must be **page content only** — inline `<style>`/`<script>`, base64 `data:` images, and a `<title>`, but **no** `<!DOCTYPE>/<html>/<head>/<body>` tags of its own (a full standalone document gets double-wrapped and renders wrong).
- The script emits an Artifact-friendly variant when you add `--artifact`: `python3 /abs/path/expo-skill-eval/scripts/generate_viewer.py /private/tmp/expo-skill-eval-<skill> --artifact` writes `viewer_artifact.html` (same content, skeleton stripped, no browser open). Pass that file to the `Artifact` tool (`favicon: "📊"`), not the standalone one.
- The viewer is already self-contained (base64 screenshots, inline CSS/JS), so it satisfies the Artifact CSP (no external hosts).

## References

- `references/runtime-matrix.md` — per-skill runtime applicability (expo-go vs static-only, platform notes).
- `agents/visual-grader.md` — screenshot grading instructions for the grader subagent.


## Contract

This skill guarantees:

- Covers its source domain per the skill description: Evaluate Expo skills in this repo end-to-end - trigger accuracy, generated code quality, and runtime screenshots on iOS simulator and Android emulator via Expo Go (web optional). Use when the user wants to eval an Expo skill, test that a skill produces working
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
