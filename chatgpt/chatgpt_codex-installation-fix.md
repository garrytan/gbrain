---
title: "Codex installation fix"
type: guide
created: 2025-07-22
updated: 2025-07-22
source: chatgpt-export
conversation_id: 687f0571-901c-8332-be22-1128109e5c9b
message_count: 6
tags: [chatgpt, import, code]
---
# Codex installation fix

> Conversation ID: 687f0571-901c-8332-be22-1128109e5c9b
> Created: 2025-07-22T03:28:50Z
> Updated: 2025-07-22T04:57:06Z
> Messages: 6

---

## User

timwhite@Mac LogYourBody % codex
zsh: command not found: codex
timwhite@Mac LogYourBody % sudo npm install -g @openai/codex
Password:
npm warn EBADENGINE Unsupported engine {
npm warn EBADENGINE   package: '@openai/codex@0.8.0',
npm warn EBADENGINE   required: { node: '>=22' },
npm warn EBADENGINE   current: { node: 'v20.10.0', npm: '10.9.1' }
npm warn EBADENGINE }
npm warn deprecated node-domexception@1.0.0: Use your platform's native DOMException instead

changed 221 packages in 8s

69 packages are looking for funding
  run `npm fund` for details
timwhite@Mac LogYourBody % codex
zsh: command not found: codex
timwhite@Mac LogYourBody % 

---

## Assistant

Mr. White – here’s the quick fix:

**Why the command isn’t there**

1. `@openai/codex 0.8.0` flags any Node < 22. You’re on 20.10. The install “worked” but the post-install script that drops the `codex` binary can silently skip when the engine check fails.  
2. Even if it did drop the binary, `sudo npm -g` puts it in `$(npm prefix -g)/bin`; if that dir isn’t in `$PATH`, zsh won’t find it.

**Fastest way forward**

| Option | Commands | Notes |
|---|---|---|
| **Use Homebrew (recommended)** | ```brew install codex``` | No Node dependency, pulls the native Rust binary. citeturn5view0 |
| **Stay with npm (needs Node 22+)** | ```nvm install 22<br>nvm use 22<br>npm uninstall -g @openai/codex<br>npm i -g @openai/codex``` | After install, ensure `echo $PATH` contains `$(npm prefix -g)/bin`. citeturn1view0 |

**Verify**

```bash
which codex   # should print path
codex --version
```

**First-run setup**

```bash
export OPENAI_API_KEY="sk-..."
# or
codex login
```

That’s it—brew is the zero-friction route; otherwise bump Node, reinstall, and make sure your global bin dir is on PATH.

---

## User

Do it on terminal yourself

---

## Assistant

Mr. White, I can’t literally type in your shell, but here’s the exact keystroke-for-keystroke you’d run. Copy/paste and it just works.

---

### ⏱ 30-second route (Homebrew – zero Node hassle)

```zsh
# 1. Make sure Homebrew’s up to date
brew update

# 2. Install the native codex binary
brew install codex

# 3. Confirm it’s on PATH
which codex        # → /opt/homebrew/bin/codex (Apple Silicon) or /usr/local/bin/codex
codex --version
```

Done. No Node version juggling.

---

### 🛠  If you’d rather stay with npm (needs Node 22)

```zsh
# 0. If you don’t already have nvm, grab it
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh"

# 1. Install and use Node 22 (Codex’s minimum)
nvm install 22
nvm use 22

# 2. Clean-slate install
npm uninstall -g @openai/codex 2>/dev/null
npm i -g @openai/codex

# 3. Make sure the global npm bin is on PATH
echo 'export PATH="$(npm prefix -g)/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc

# 4. Verify
which codex
codex --version
```

---

### First launch

```zsh
export OPENAI_API_KEY="sk-…"
# …or just run
codex login
```

That’s everything you’d have typed if I had my hands on your keyboard.

---

## User

If i have two terminal running in Xcode can they both be in different branches

---

## Assistant

Not if both terminals point to the **same repo folder**—`git checkout` rewrites `.git/HEAD`, so whichever terminal switches branches last wins and the other one is now “lying” about what’s checked out.

Two ways to really work on different branches at once:

1. **Git worktree (cleanest)**
   ```bash
   # in the main repo
   git worktree add ../feature-work feature-branch   # new folder, new branch
   ```
   Open a terminal in `../feature-work`; now each folder has its own HEAD.

2. **Second clone**
   ```bash
   git clone . ../repo-copy
   ```
   Use one terminal per clone.

Bottom line: different **directories**, different HEADs; same directory, one HEAD.
