---
title: "Automating lint fixes"
type: essay
created: 2025-11-19
updated: 2025-11-20
source: chatgpt-export
conversation_id: 691e42d7-509c-832e-8454-9afcfe79d279
message_count: 10
tags: [chatgpt, import, code, long-form]
---
# Automating lint fixes

> Conversation ID: 691e42d7-509c-832e-8454-9afcfe79d279
> Created: 2025-11-19T22:22:00Z
> Updated: 2025-11-20T01:38:49Z
> Messages: 10

---

## User

Yeah, I keep running into lint issues on local development for Swift iOS, particularly when using AI coding assistants. And every time we run through a task, we get a bajillion kinds of errors and stuff. What is the proper workflow we can use to automate dealing with fixing those linting and stuff like that? Is there any kind of husky hooks or commands we should be running manually? What should we be doing on CI? Should we be using Fastlane? Should we be using Fastlane locally? And is there a way to set up Fastlane to assist with any of this? So that we're not constantly having to dive into all these errors individually.

---

## Assistant

Short answer, Mr. White:  
Yes, you *definitely* want automation here – SwiftLint + SwiftFormat, wired into git hooks and Fastlane, and then CI calls Fastlane so everything is consistent.

I’ll lay out a concrete setup you can more or less copy-paste.

---

## 1. Pick your tools

**Core stack:**

- **SwiftLint** – code style / lint rules.
- **SwiftFormat** (or Apple’s `swift-format`) – auto-formatting.
- **Fastlane** – single entry point for “do all the checks” locally and on CI.

Install via Homebrew:

```bash
brew install swiftlint
brew install swiftformat   # or swift-format if you prefer
```

Add configs at repo root:

**`.swiftlint.yml` (minimal, non-noisy start):**

```yaml
disabled_rules:
  - line_length
  - todo
  - identifier_name

opt_in_rules:
  - empty_count
  - force_unwrapping
  - redundant_optional_initialization

included:
  - YourApp
  - YourAppTests

excluded:
  - Carthage
  - Pods
  - Generated

reporter: "xcode"
```

**`.swiftformat` (example):**

```txt
--indent 4
--indentcase false
--semicolons never
--self insert
--stripunusedargs closure-only
--disable redundantSelf
```

Tune these once, then freeze. The goal is **predictable output**, not perfect pedagogy.

---

## 2. Wire into Xcode (but don’t rely on it)

Add a **Run Script Phase** to your main target:

**Build phase for lint only (no auto-fix):**

```bash
if which swiftlint >/dev/null; then
  swiftlint --quiet
else
  echo "warning: SwiftLint not installed; run 'brew install swiftlint'"
fi
```

If you really want, you can also lint formatting:

```bash
if which swiftformat >/dev/null; then
  swiftformat . --lint
fi
```

Build should **never** auto-modify files; that belongs in pre-commit / manual commands.

---

## 3. Git hooks (“Husky, but for iOS”)

Husky is a Node thing, but the same idea works with plain git hooks or something like `lefthook` / `pre-commit`. Easiest pattern:

1. Commit hooks into `githooks/`.
2. Have a small script that installs symlinks into `.git/hooks`.

**`Scripts/install_hooks.sh`:**

```bash
#!/usr/bin/env bash
set -euo pipefail

HOOK_DIR="$(git rev-parse --show-toplevel)/.git/hooks"
SRC_DIR="$(git rev-parse --show-toplevel)/githooks"

mkdir -p "$HOOK_DIR"

for hook in pre-commit pre-push; do
  if [ -f "$SRC_DIR/$hook" ]; then
    ln -sf "$SRC_DIR/$hook" "$HOOK_DIR/$hook"
    chmod +x "$HOOK_DIR/$hook"
  fi
done

echo "Git hooks installed."
```

**`githooks/pre-commit`:**

```bash
#!/usr/bin/env bash
set -euo pipefail

echo "Running SwiftFormat..."
if which swiftformat >/dev/null; then
  swiftformat . >/dev/null
else
  echo "swiftformat not installed"
fi

echo "Running SwiftLint..."
if which swiftlint >/dev/null; then
  swiftlint --quiet
else
  echo "swiftlint not installed"
fi
```

If lint fails, commit is blocked. That’s what you want: AI dumps code, you hit commit, hook either fixes or yells.

You can make this only touch staged files for speed, but this is enough to start.

---

## 4. Fastlane: single entry point for “all checks”

Add `Gemfile`:

```ruby
source "https://rubygems.org"

gem "fastlane"
```

Install:

```bash
bundle install
fastlane init   # choose manual setup
```

**Fastfile (key parts):**

```ruby
default_platform(:ios)

platform :ios do
  desc "Run formatters & linters"
  lane :lint do
    sh "swiftformat ."
    sh "swiftlint --quiet"
  end

  desc "Run tests + lint; used locally"
  lane :dev_checks do
    sh "swiftformat ."
    sh "swiftlint --quiet"
    scan(
      scheme: "YourApp",
      clean: false
    )
  end

  desc "CI lane: no auto-fix, just verify"
  lane :ci do
    sh "swiftformat . --lint"
    sh "swiftlint --quiet"
    scan(
      scheme: "YourApp",
      clean: true
    )
  end
end
```

### Using Fastlane locally

Train the team to use:

```bash
bundle exec fastlane lint        # quick checks
bundle exec fastlane dev_checks  # before merge / PR
```

Or wrap in a Makefile:

```makefile
lint:
	bundle exec fastlane lint

check:
	bundle exec fastlane dev_checks
```

Then devs just run:

```bash
make lint
make check
```

Your git hooks can also just call `bundle exec fastlane lint` instead of raw commands.

---

## 5. CI setup (GitHub Actions example)

The idea: CI does exactly what devs do, via Fastlane.

```yaml
name: iOS CI

on:
  pull_request:
  push:
    branches: [ main ]

jobs:
  build-and-test:
    runs-on: macos-latest

    steps:
      - uses: actions/checkout@v4

      - name: Set up Ruby
        uses: ruby/setup-ruby@v1
        with:
          ruby-version: '3.2'
          bundler-cache: true

      - name: Install tools
        run: |
          brew install swiftlint
          brew install swiftformat

      - name: Run CI lane
        run: bundle exec fastlane ios ci
```

CI will fail if:

- Formatting is off (`swiftformat . --lint`),
- SwiftLint has violations,
- Tests fail.

No manual triage per task; AI can spam whatever it wants, CI tells you if it’s clean.

---

## 6. Reducing “bajillion errors” from AI

A few pragmatic moves:

1. **Relax rules at first.**  
   Start with a small, meaningful subset of SwiftLint rules. Add more once noise drops.

2. **Exclude noisy areas.**  
   Generated code, vendor stuff, or legacy modules can be excluded in `.swiftlint.yml` and `.swiftformat`.

3. **Use `autocorrect` after big AI edits.**

   ```bash
   swiftlint autocorrect
   swiftformat .
   ```

   Do this locally before committing. That’s your “clean up everything the bot just wrote” button.

4. **Teach the AI your style.**  
   Paste your `.swiftlint.yml` / `.swiftformat` into the prompt occasionally and literally say “match these conventions” – it reduces violations a lot.

---

## 7. Suggested day-to-day workflow

For you and the team:

1. **During dev:**  
   Let AI generate code freely.

2. **Before commit:**

   ```bash
   make lint        # or bundle exec fastlane lint
   # (which will run swiftformat + swiftlint)
   git commit ...
   ```

   If hooks are installed, they’ll enforce this anyway.

3. **Before opening / updating a PR:**

   ```bash
   make check       # runs tests + lint lane
   ```

4. **CI:** runs `fastlane ios ci` on every PR / push.  
   If CI is green, you know lint/format/tests _match_ local behavior.

---

If you tell me:

- Which tools you already have (SwiftLint, SwiftFormat, none),
- Which CI you’re on (GitHub Actions, Bitrise, etc.),

I can write a repo-ready `.swiftlint.yml`, `.swiftformat`, `Fastfile`, hooks, and a CI config tailored to your setup so you can just drop them in.

---

## User

And what rules should we have for claude code, and windsurf to enforce this in its work

---

## Assistant

Good question to lock this down, Mr. White.

Think of it in two layers:

1. **Hard technical contract** → “All code must pass SwiftFormat + SwiftLint with our configs.”
2. **Behavioral rules for the AI** → “How to write code so we don’t get a lint bomb afterward.”

Below is a ruleset you can paste into Claude / Windsurf as project instructions, plus some Swift-specific details.

---

## 1. Core “contract” to give Claude / Windsurf

You want something like this as **project-level / workspace rules** (not just a one-off prompt):

> **Code quality contract**
> - The codebase uses **SwiftLint** (config: `.swiftlint.yml` in repo root) and **SwiftFormat** (config: `.swiftformat`).
> - Treat these tools as **source of truth for style and structure**.
> - All Swift code you produce **must compile** and **must be written to satisfy** these tools *as much as reasonably possible from context*.
> - Prefer patterns that avoid common lint errors: no force unwraps, limited `!` / `try!`, no dead code, no unused variables/arguments, no long methods, no nested pyramids of doom.
> - When editing an existing file, **conform to the style that’s already there** if it clearly matches the SwiftLint/SwiftFormat rules.
> - Do **not** reformat the entire file or unrelated code. Limit edits to what’s necessary for the task.

---

## 2. Make the AI explicitly “aware” of SwiftLint & SwiftFormat

Paste (or summarize) your configs directly into the tool once per session, then add rules like:

> **SwiftLint / SwiftFormat awareness**
> - Assume the `.swiftlint.yml` and `.swiftformat` below are active in CI and pre-commit hooks.
> - When proposing new code:
>   - Avoid patterns that obviously violate these rules (e.g., `force_unwrapping`, forbidden rules, or naming violations).
>   - Prefer `guard` and safe unwrapping over `if let` pyramids where the rules encourage it.
>   - Use access control (`private`, `fileprivate`) to prevent unused symbol warnings where appropriate.
> - When you suggest a multi-step change, include **a short note** like: “This should pass SwiftLint/SwiftFormat given the current config.”

You don’t need every rule enumerated; you need the **big recurring offenders** turned into writing guidelines.

---

## 3. Swift-specific behavioral rules to reduce lint noise

You can add a section like:

> **Swift style & safety rules**
> - Avoid `!` unless absolutely necessary; prefer `guard let` or `if let`.
> - Use explicit types on public APIs and protocols, but let type inference handle obvious locals where allowed by lint rules.
> - Use `private` / `fileprivate` where possible to avoid unused/visibility lint issues.
> - Keep functions short and focused; if you see a function exceeding ~40–50 lines, suggest extracting helpers instead of dumping more logic in.
> - Follow Swift naming conventions:
>   - types: `PascalCase`
>   - methods/properties/variables: `camelCase`
>   - no abbreviations unless clearly established in the codebase.
> - Avoid leaving `print`, `TODO`, and commented-out blocks in final suggestions unless the task is explicitly to add them.

If your `.swiftlint.yml` disables some of this, tweak accordingly.

---

## 4. How to phrase this for **Claude Code**

For Claude’s “project rules” / “system” field (or first message in the session), something like:

> - This repository is a Swift iOS app.
> - The project uses **SwiftLint** and **SwiftFormat** with the configs in `.swiftlint.yml` and `.swiftformat`.
> - Your code must be written so that, after running `swiftformat .` and `swiftlint`, there are **no style or lint violations**, except where impossible to avoid with given constraints.
> - Prefer safe optional handling (no `!` or `try!`), small functions, and consistent naming.
> - Never reformat entire files or unrelated code. Only change what’s needed for the request.

Then, when you ask for code, you can occasionally remind it with:

> “Make sure this compiles and is consistent with SwiftLint/SwiftFormat.”

---

## 5. How to phrase this for **Windsurf**

Windsurf has **project-level instructions** and per-request prompts. For project settings, drop in something like:

> - This is a Swift iOS project.
> - The code is checked by `swiftformat .` and `swiftlint` in pre-commit hooks and CI.
> - Do not introduce patterns that will obviously fail these tools:
>   - avoid force unwraps
>   - avoid unused variables
>   - follow existing naming and access control patterns
> - When editing, **localize changes** and keep formatting consistent with `.swiftformat` instead of inventing a new style.

And in the **“code actions”** / “apply refactor” prompts:

> “Apply the change, but keep the file in a state that passes SwiftLint/SwiftFormat given the project configs.”

---

## 6. Optional: give them the actual commands

Also good to tell both tools what commands are “truth”:

> - Local checks: `swiftformat .` and `swiftlint`
> - CI lane: `bundle exec fastlane ios ci`

Then ask for changes like:

> “Write the code so that running `swiftformat .` and `swiftlint` won’t introduce new violations.”

Even though they can’t run the commands, they will optimize for that pattern.

---

## 7. Concrete snippet you can copy into both tools

Here’s a compact, ready-to-paste rule block:

> **Project rules**
> - Language: Swift (iOS).
> - Style tools: **SwiftFormat** and **SwiftLint**, configured by `.swiftformat` and `.swiftlint.yml` in the repo root.
> - All proposed code must:
>   - Compile.
>   - Be compatible with SwiftFormat and SwiftLint (no obvious violations like force unwraps, unused variables, wrong naming, or huge methods).
>   - Match the existing style of the file.
>   - Only edit what is necessary for the task (no wholesale reformatting of unrelated code).
> - Prefer:
>   - `guard let` / `guard` for early exits.
>   - `private` / `fileprivate` where useful.
>   - Clear, descriptive names in `camelCase` for variables/functions and `PascalCase` for types.
> - Do not leave debug prints, TODOs, or commented-out blocks in final answers unless requested.

---

If you want, you can paste your actual `.swiftlint.yml` and `.swiftformat` here and I’ll turn them into a tighter, tool-ready instruction set specifically aligned with your rules.

---

## User

Give me one rule with all this I can copy and paste

---

## Assistant

Here you go, Mr. White — one copy-paste rule block:

> **Project rule: Swift code quality & style**
> - This is a Swift iOS project. All code must compile and respect the repository’s `.swiftlint.yml` and `.swiftformat` configs, which are enforced locally (pre-commit hooks) and in CI via `swiftformat .` and `swiftlint` (and `bundle exec fastlane ios ci` where relevant).  
> - When generating or editing Swift code:
>   - Write it so that running `swiftformat .` and `swiftlint` will not introduce new violations, as far as can be inferred from context.  
>   - Follow standard Swift conventions: `PascalCase` for types, `camelCase` for variables/properties/functions, and clear, descriptive names (no random abbreviations unless the file already uses them).  
>   - Prefer safe patterns: avoid `!` and `try!` unless absolutely necessary; use `guard let` / `guard` for early exits; keep functions reasonably small and focused; avoid deep nesting and dead code; avoid unused variables/arguments.  
>   - Use appropriate access control (`private` / `fileprivate`) to prevent unused symbol warnings and to match the existing file’s structure.  
>   - Match the existing style of the file and the project (spacing, brace style, imports, etc.), assuming it conforms to SwiftLint/SwiftFormat.  
> - Do **not** reformat entire files or unrelated code; limit changes to what is needed for the current task while keeping the file in a state that passes SwiftLint/SwiftFormat.  
> - Do **not** leave debug prints, TODOs, commented-out large blocks, or temporary code in the final answer unless explicitly requested.

---

## User

Does agents.md replace claude.md?

---

## Assistant

Short answer: I can’t see your repo, Mr. White, so I *can’t reliably say* that `agents.md` replaces `claude.md`—but I can tell you how to decide in ~30 seconds and what you *should* do going forward.

### How to tell which one is “source of truth” right now

Run these checks:

1. **Look for an explicit deprecation note**
   - Open `claude.md` and see if it says anything like:
     - “Moved to `agents.md`”
     - “Deprecated” / “Legacy”
   - If yes → `agents.md` is now the source of truth, `claude.md` is only historical.

2. **Check which file is newer / maintained**
   ```bash
   git log --oneline -- agents.md claude.md
   ```
   - If `agents.md` has recent commits and `claude.md` hasn’t moved in a while, treat `agents.md` as primary.
   - If both are active and conflict → you need to explicitly pick one and mark the other as deprecated.

3. **See what the repo points to**
   - Check `README.md`, `CONTRIBUTING.md`, `.github/` workflows, etc.  
   - If they say “follow `agents.md`” → that’s your answer.
   - If some internal docs still reference `claude.md`, you’re in a transition state.

### What I *recommend* you do (to avoid confusion)

If you’re standardizing on **one rules file for all AI tools**, do this:

1. **Make `agents.md` the single source of truth**
   - Put all cross-agent rules there (Claude, Windsurf, ChatGPT, etc.).
   - Add a short “Claude-specific behavior” section inside it if needed.

2. **Turn `claude.md` into a thin shim**
   - Replace its contents with something like:
     > This file is deprecated. All current instructions for Claude and other AI agents live in `agents.md`.  
   - Optionally delete it after a short transition period.

3. **Update any configs that reference `claude.md`**
   - Claude “project instructions” → point them to `agents.md`.
   - Any internal tooling / onboarding docs → same.

---

So: **right now** the only honest answer is “it depends on how your repo authors intended it,” but **going forward** you should absolutely aim for:  

> `agents.md` = canonical AI instructions,  
> `claude.md` = either removed or just a pointer to `agents.md`.

---

## User

How should we lint locally so fast lane matches

---

## Assistant

You want **one source of truth** for linting, Mr. White: the Fastlane lane.  
Everything else (local, hooks, CI) should just call that.

Here’s a concrete setup you can drop in.

---

## 1. Define a single lint lane in Fastlane

In your `Fastfile`:

```ruby
default_platform(:ios)

platform :ios do
  # Pure check – no auto-fix. This is the contract.
  desc "Verify SwiftFormat + SwiftLint"
  lane :lint do
    sh "swiftformat . --lint"
    sh "swiftlint --quiet"
  end

  # Optional: auto-fix lane for devs
  desc "Apply formatting and autocorrect lint"
  lane :fix_style do
    sh "swiftformat ."
    sh "swiftlint --quiet --fix || swiftlint --quiet autocorrect"
  end

  desc "CI lane"
  lane :ci do
    lint
    scan(
      scheme: "YourApp",
      clean: true
    )
  end
end
```

Key idea:

- **`lint`** = the *canonical* “does this pass style?” check.
- **`ci`** calls `lint`, so CI and local lint are identical.
- **`fix_style`** is just a helper for devs; doesn’t define policy.

---

## 2. How to lint locally so it matches Fastlane/CI

**Never** run random `swiftlint`/`swiftformat` flags by hand as “the truth.”  
Instead, always:

```bash
bundle exec fastlane ios lint       # verify (same as CI)
bundle exec fastlane ios fix_style  # optional: auto-fix, then re-run lint
```

If you want a nicer alias:

```makefile
lint:
	bundle exec fastlane ios lint

fix-style:
	bundle exec fastlane ios fix_style
```

Now devs do:

```bash
make fix-style   # or bundle exec fastlane ios fix_style
make lint        # confirm clean
```

And **CI does the same thing** via `fastlane ios ci`.

---

## 3. Make git hooks use the same lane

Your `githooks/pre-commit` (or equivalent) should not reinvent the commands; just call Fastlane:

```bash
#!/usr/bin/env bash
set -euo pipefail

echo "Running Fastlane lint..."
bundle exec fastlane ios lint
```

or, if you want auto-fix on commit:

```bash
#!/usr/bin/env bash
set -euo pipefail

echo "Fixing style via Fastlane..."
bundle exec fastlane ios fix_style

echo "Verifying lint..."
bundle exec fastlane ios lint
```

Now:

- **Local dev**, **pre-commit**, and **CI** all go through the **same Fastlane lane**,  
- So if it passes locally, it passes CI, and the AI isn’t generating code into a different rule set.

---

## 4. Version pinning (to avoid “works on my machine”)

To really lock it in:

- Homebrew: use a `Brewfile` with `brew bundle` on both CI + dev, *or*
- Use **Mint** to pin SwiftLint/SwiftFormat versions and call them via Mint inside the Fastlane lanes.

But even without that, the **“always go through Fastlane”** pattern is the main answer.
