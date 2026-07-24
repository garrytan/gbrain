# GBrain MCP Server — Setup Guide for Google Antigravity

A comprehensive guide to installing GBrain, connecting it to Google Antigravity as an MCP server, and avoiding the platform-specific pitfalls that can derail your first session. This guide covers **macOS**, **Linux**, and **Windows**.

---

## Table of Contents

- [1. Prerequisites](#1-prerequisites)
  - [1.1 JavaScript Runtime — Node.js or Bun](#11-javascript-runtime--nodejs-or-bun)
  - [1.2 Install GBrain](#12-install-gbrain)
  - [1.3 Install Ollama and Pull the Embedding Model](#13-install-ollama-and-pull-the-embedding-model)
  - [1.4 Initialize the PGLite Database](#14-initialize-the-pglite-database)
- [2. Antigravity UI Configuration](#2-antigravity-ui-configuration)
  - [2.1 Open the MCP Server Settings](#21-open-the-mcp-server-settings)
  - [2.2 Add the GBrain Server Entry](#22-add-the-gbrain-server-entry)
  - [2.3 Restart and Verify the Connection](#23-restart-and-verify-the-connection)
  - [2.4 Understanding the MCP Traffic Lights](#24-understanding-the-mcp-traffic-lights)
- [3. Handling Multiple Projects](#3-handling-multiple-projects)
- [4. Day-to-Day Operations — Keeping the Brain Updated](#4-day-to-day-operations--keeping-the-brain-updated)
  - [4.1 The Update Workflow](#41-the-update-workflow)
  - [4.2 Quick-Copy Commands](#42-quick-copy-commands)
- [5. Troubleshooting](#5-troubleshooting)
  - [5.1 The PGLite Database Lock](#51-the-pglite-database-lock)
  - [5.2 The Misleading WASM Error on Windows](#52-the-misleading-wasm-error-on-windows)
  - [5.3 Corrupted Database — Factory Reset](#53-corrupted-database--factory-reset)
- [6. Quick Reference](#6-quick-reference)
- [7. Further Reading](#7-further-reading)

---

## 1. Prerequisites

Complete every step in this section **before** opening Antigravity. The order matters — skipping ahead will produce cryptic errors that are difficult to diagnose after the fact.

### 1.1 JavaScript Runtime — Node.js or Bun

GBrain is distributed as an npm package. You need a JavaScript runtime and its associated package manager installed **before** you can install GBrain.

You need **one** of the following:

<table>
<thead>
<tr><th>Runtime</th><th>macOS / Linux</th><th>Windows (PowerShell)</th></tr>
</thead>
<tbody>
<tr>
  <td><strong>Node.js</strong> (with npm)</td>
  <td>

  Download the LTS installer from [nodejs.org](https://nodejs.org/), or use your system package manager:

  ```bash
  # macOS (Homebrew)
  brew install node

  # Debian / Ubuntu
  sudo apt install nodejs npm
  ```

  </td>
  <td>

  ```powershell
  winget install OpenJS.NodeJS
  ```

  Or download the LTS installer from [nodejs.org](https://nodejs.org/). npm is bundled with Node.js.

  </td>
</tr>
<tr>
  <td><strong>Bun</strong></td>
  <td>

  ```bash
  curl -fsSL https://bun.sh/install | bash
  ```

  See [bun.sh](https://bun.sh/) for details.

  </td>
  <td>

  ```powershell
  irm bun.sh/install.ps1 | iex
  ```

  See [bun.sh](https://bun.sh/) for details.

  </td>
</tr>
</tbody>
</table>

After installing, open a **new** terminal and verify your runtime:

```bash
# Node.js
node --version
npm --version

# Bun
bun --version
```

> [!NOTE]
> **You do not need to install PGLite separately.** PGLite is an embedded database engine that ships bundled inside the GBrain package. It is initialized automatically when you run `gbrain init --pglite` in [Section 1.4](#14-initialize-the-pglite-database). No external database software (Postgres, SQLite, etc.) is required.

---

### 1.2 Install GBrain

With your JavaScript runtime in place, install the GBrain CLI globally.

**Using npm:**

```bash
npm install -g gbrain
```

**Using bun:**

```bash
bun install -g gbrain
```

After installation, verify the CLI is on your PATH:

```bash
gbrain --version
```

You should see a version number (e.g., `0.4.2`). If the command is not found, ensure your global package bin directory is on your system PATH and open a new terminal session.

---

### 1.3 Install Ollama and Pull the Embedding Model

GBrain uses [Ollama](https://ollama.com/) to run a local embedding model that powers its vector database. You need Ollama installed and the correct model downloaded **before** initializing the database.

**Step 1 — Install Ollama:**

Download and run the installer for your platform from [https://ollama.com/download](https://ollama.com/download). Once installed, verify:

```bash
ollama --version
```

**Step 2 — Pull the embedding model:**

```bash
ollama pull nomic-embed-text
```

Wait for the download to complete fully. Confirm the model is available:

```bash
ollama list
```

You should see `nomic-embed-text` in the output.

> [!CAUTION]
> **This step is not optional.** If `nomic-embed-text` is not present when GBrain initializes its database for the first time, the initialization will fail with a misleading WASM/EOF crash error. See [Section 5.2](#52-the-misleading-wasm-error-on-windows) for a full explanation of why this happens and how to recover.

---

### 1.4 Initialize the PGLite Database

GBrain stores all of its data in an embedded PGLite database located at `~/.gbrain`. You must explicitly create this database structure before connecting GBrain to any UI client.

```bash
gbrain init --pglite
```

Expected output will confirm that the database schema has been created and the embedding pipeline is functional. If this command succeeds without errors, your external setup is complete.

> [!IMPORTANT]
> If `gbrain init --pglite` fails, do **not** proceed to the Antigravity configuration. Diagnose the failure first — the two most common causes are:
>
> 1. **Ollama is not running.** Start it with `ollama serve` in a separate terminal.
> 2. **The embedding model is missing.** Run `ollama pull nomic-embed-text`. See [Section 1.3](#13-install-ollama-and-pull-the-embedding-model).

---

## 2. Antigravity UI Configuration

With GBrain installed and its database initialized, you can now register it as an MCP server inside Google Antigravity.

### 2.1 Open the MCP Server Settings

Navigate through the Antigravity UI using the following click-path:

```
Settings  →  Customization  →  MCP Servers
```

This opens the MCP server configuration panel, which accepts a JSON object defining each server's launch command and arguments.

---

### 2.2 Add the GBrain Server Entry

In the MCP Servers configuration editor, add the following JSON payload.

**macOS / Linux:**

```json
{
  "mcpServers": {
    "gbrain": {
      "command": "gbrain",
      "args": ["serve"],
      "env": {}
    }
  }
}
```

**Windows:**

```json
{
  "mcpServers": {
    "gbrain": {
      "command": "gbrain.cmd",
      "args": ["serve"],
      "env": {}
    }
  }
}
```

If you already have other MCP servers configured, merge the `"gbrain"` key into your existing `mcpServers` object. Do not create a second top-level `mcpServers` block.

> [!WARNING]
> ### ⚠️ Windows Users — You MUST use `"gbrain.cmd"`
>
> On Windows, globally installed npm and bun packages are shimmed through `.cmd` batch files. Antigravity's MCP client spawns child processes **directly** — it does not invoke a shell — so it cannot resolve the bare command name `"gbrain"` without the `.cmd` extension.
>
> **If you use `"gbrain"` instead of `"gbrain.cmd"` on Windows, the server will silently fail to start.** There will be no error dialog. The MCP panel will simply show a red indicator with no further explanation. This is the single most common setup failure on Windows.
>
> macOS and Linux users should use `"gbrain"` (without the extension) as shown above.

> [!WARNING]
> **The args must be `["serve"]`.**
>
> GBrain exposes its MCP interface through the `serve` subcommand. Using any other argument (e.g., `"mcp"`, `"start"`) will cause the server process to exit immediately after launch.

---

### 2.3 Restart and Verify the Connection

MCP server configuration is read **once at startup**. Saving the JSON alone is not enough — you must restart Antigravity for the changes to take effect.

1. **Fully quit** Antigravity (do not just close the window — exit the application entirely).
2. **Re-launch** Antigravity.
3. Open the **MCP Servers** panel (visible in the sidebar, or via **Settings → Customization → MCP Servers**).
4. Locate **gbrain** in the server list and check its status indicator.

---

### 2.4 Understanding the MCP Traffic Lights

The MCP Servers panel displays a color-coded status indicator next to each registered server:

| Color | Status | What to Do |
|:---:|---|---|
| 🟢 **Green** | **Connected and healthy.** The GBrain server is running, the PGLite database is accessible, and the embedding pipeline is responsive. | Nothing — you are ready to use GBrain tools. |
| 🟠 **Orange** | **Initializing or connecting.** Antigravity has spawned the GBrain process and is waiting for it to complete startup (database warm-up, model loading, etc.). | **Wait.** First launch after a fresh `gbrain init` can take 10–30 seconds. If it stays orange for more than 60 seconds, check that Ollama is running. |
| 🔴 **Red** | **Disconnected or crashed.** The GBrain process either failed to start, exited unexpectedly, or lost its connection. | **Click the red indicator** (or the adjacent error log / refresh icon) to expand the error details. The inline error message will tell you exactly what went wrong. Common causes are documented in [Section 5](#5-troubleshooting). |

> [!TIP]
> If the indicator is red but no error message is visible, click the **refresh icon** next to the server name to force a reconnection attempt. If it fails again, the error details will be populated.

---

## 3. Handling Multiple Projects

A common question from developers who work across several codebases:

> *"Do I need a separate GBrain database for each project?"*

**No.** GBrain uses a single **Global Brain** located at `~/.gbrain`. You do not need separate databases, configuration files, or instances for different projects.

### How It Works

GBrain stores all imported content as **vector embeddings** generated by Ollama's `nomic-embed-text` model. These embeddings encode the semantic meaning of your code and documentation — not just filenames or keywords, but the mathematical representation of what each piece of content is *about*.

When you import multiple projects into the same brain, the embeddings for each project occupy distinct regions of the vector space. There is no cross-contamination. When you ask the agent a question, the vector search naturally retrieves the most semantically relevant content for the context you provide.

**In practice:**

1. Import Project A:
   ```bash
   cd ~/projects/project-a
   gbrain import .
   ```

2. Import Project B:
   ```bash
   cd ~/projects/project-b
   gbrain import .
   ```

3. When chatting in Antigravity, simply tell the agent which project you are working on (e.g., *"I'm working on Project A"*). The vector similarity search will surface the correct architecture, APIs, and documentation without pulling in unrelated content from Project B.

> [!NOTE]
> If your projects share common libraries or conventions, the brain *will* surface shared context — and that's usually a feature, not a bug. It can help the agent apply patterns from one project to another when they are genuinely applicable.

### When to Consider Separate Brains

For most developers, the global brain is sufficient. However, if you are working with highly sensitive codebases that must never be queried in the same session (e.g., competing client projects under NDA), you can configure separate GBrain data directories using the `GBRAIN_HOME` environment variable:

```bash
GBRAIN_HOME=~/.gbrain-client-a gbrain init --pglite
GBRAIN_HOME=~/.gbrain-client-a gbrain import .
```

This is an advanced use case and is not required for normal operation.

---

## 4. Day-to-Day Operations — Keeping the Brain Updated

GBrain does **not** automatically watch your filesystem for changes. It has no file-watcher daemon, no background sync, and no hooks into your editor's save events. When you update your documentation, code, notes, or any other content that you want reflected in the brain, you must **manually trigger an update**.

### 4.1 The Update Workflow

Follow these four steps **exactly and in order** every time you need to refresh the brain. Skipping or reordering steps will cause lock errors, stale imports, or — in the worst case — database corruption.

---

**Step 1 — Fully close Google Antigravity.**

Antigravity holds a persistent PGLite database lock for the entire duration of its session (see [Section 5.1](#51-the-pglite-database-lock)). You must completely quit the application — not minimize it, not close the chat tab, but **fully exit the process** — to release the lock before any CLI write operations will succeed.

---

**Step 2 — Open a fresh terminal.**

Open a brand-new terminal window (Terminal, iTerm, or PowerShell). Do not reuse a terminal session that previously had a hanging or timed-out `gbrain` command — stale process handles from a failed prior attempt can cause permission errors or partial writes on the next run.

---

**Step 3 — Navigate to the exact project folder.**

Change directory to the root of the project or content folder you want to import:

```bash
# macOS / Linux
cd ~/projects/my-project

# Windows (PowerShell)
cd C:\Users\you\projects\my-project
```

> [!WARNING]
> **Run the import from the correct directory.** GBrain's `import` command ingests everything it finds relative to the current working directory. If you run it from the wrong path (e.g., your home directory, `/` or `C:\`), it will crawl and index unrelated system files, polluting your brain's vector database with irrelevant content. Cleaning this up requires a full factory reset ([Section 5.3](#53-corrupted-database--factory-reset)).

---

**Step 4 — Run the import.**

For a single local project:

```bash
gbrain import .
```

For federated or multi-repo setups:

```bash
gbrain sync
```

Wait for the command to complete. You will see progress output as GBrain processes files, generates embeddings, and writes them to PGLite. Once it finishes, re-launch Antigravity — the updated content will be available immediately.

---

### 4.2 Quick-Copy Commands

For convenience, here is the entire update sequence as a single block:

**macOS / Linux:**

```bash
# 1. Ensure Antigravity is fully closed before running this.
# 2. Open a FRESH terminal window.
# 3. Navigate to your project root:
cd ~/projects/my-project

# 4. Import:
gbrain import .

# 5. Re-launch Antigravity when the import completes.
```

**Windows (PowerShell):**

```powershell
# 1. Ensure Antigravity is fully closed before running this.
# 2. Open a FRESH PowerShell window.
# 3. Navigate to your project root:
cd C:\Users\you\projects\my-project

# 4. Import:
gbrain import .

# 5. Re-launch Antigravity when the import completes.
```

---

## 5. Troubleshooting

### 5.1 The PGLite Database Lock

GBrain's embedded PGLite database enforces **single-writer access**. When Antigravity is running, its MCP connection to GBrain holds a persistent lock on the database file for the entire duration of the session.

**What this means in practice:**

If you open a terminal and try to run any write-mode CLI command — such as:

```bash
gbrain import ./my-notes
```

```bash
gbrain sync
```

— the command will **hang indefinitely** and eventually fail with a lock timeout error.

**How to fix it:**

1. **Completely close the Antigravity application.** Minimizing, backgrounding, or closing the chat window is not enough. You must fully quit the process so that the GBrain MCP server child process terminates and releases the database lock.
2. Run your `gbrain import` or `gbrain sync` command.
3. Wait for the command to complete.
4. Re-launch Antigravity.

> [!IMPORTANT]
> Read-only operations (e.g., `gbrain --help`, `gbrain --version`) do **not** require the database lock and can be run while Antigravity is open.

---

### 5.2 The Misleading WASM Error on Windows

**The error you see:**

```
PGLite failed to initialize its WASM runtime (macOS 26.3 WASM bug)
```

This is typically followed by an **EOF crash** and a full stack trace.

**Why it is misleading:**

The error message references a real WASM compatibility bug that exists on macOS 26.3. However, if you are seeing this error **on Windows or Linux**, the cause is entirely different. The macOS-specific error handler is being triggered as a catch-all for any WASM initialization failure, regardless of the actual root cause.

**The actual cause on non-macOS systems:**

The `nomic-embed-text` Ollama model is either missing, Ollama itself is not running, or the embedding pipeline has jammed from a previous interrupted session. During database initialization, GBrain calls the embedding model to process seed data. When that call fails, the failure cascades up through the PGLite WASM layer, which then reports it as a WASM runtime bug.

**How to fix it:**

```bash
# 1. Ensure Ollama is running
ollama serve

# 2. In a separate terminal, pull the model if it is missing
ollama pull nomic-embed-text

# 3. Verify the model is available
ollama list

# 4. Restart Antigravity (or re-run gbrain init --pglite if the database was never created)
```

> [!NOTE]
> If the pipeline jammed (e.g., Ollama was killed mid-embedding during a previous session), simply restarting Ollama with `ollama serve` and re-initializing GBrain will clear the jammed state.

---

### 5.3 Corrupted Database — Factory Reset

In rare cases, the PGLite **Write-Ahead Log (WAL)** can become corrupted. This typically happens when a lock contention issue causes two processes to write to the database simultaneously — for example, if a `gbrain import` command was force-killed while Antigravity was still connected.

**Symptoms of WAL corruption:**

- GBrain starts but immediately crashes with a PGLite consistency error.
- The MCP traffic light goes red with an error mentioning WAL, checkpoint, or page validation.
- `gbrain init --pglite` fails on an existing database with a corruption warning.

**How to perform a factory reset:**

> [!CAUTION]
> This procedure **deletes your existing GBrain database**. All imported content will need to be re-imported. The corrupted copy is preserved as a backup in case you need to attempt manual recovery.

**Step 1 — Fully close Antigravity.**

Ensure no GBrain processes are running.

**macOS / Linux:**

```bash
pkill -f gbrain || true
```

**Windows (PowerShell):**

```powershell
Get-Process -Name "gbrain" -ErrorAction SilentlyContinue | Stop-Process -Force
```

**Step 2 — Rename the corrupted database directory.**

**macOS / Linux:**

```bash
mv ~/.gbrain ~/.gbrain_corrupted
```

**Windows (PowerShell):**

```powershell
Rename-Item -Path "$env:USERPROFILE\.gbrain" -NewName ".gbrain_corrupted"
```

This moves your entire GBrain data directory out of the way. The original data is preserved at `~/.gbrain_corrupted` so you can inspect or attempt recovery later.

**Step 3 — Re-initialize a clean database.**

```bash
gbrain init --pglite
```

**Step 4 — Re-import your content.**

```bash
gbrain import ./path/to/your/content
```

**Step 5 — Re-launch Antigravity.**

Open Antigravity and verify the GBrain MCP traffic light is green.

**Step 6 (optional) — Clean up the backup.**

Once you have confirmed everything is working, you can delete the corrupted backup:

**macOS / Linux:**

```bash
rm -rf ~/.gbrain_corrupted
```

**Windows (PowerShell):**

```powershell
Remove-Item -Path "$env:USERPROFILE\.gbrain_corrupted" -Recurse -Force
```

---

## 6. Quick Reference

| Scenario | Symptom | Fix |
|---|---|---|
| GBrain server won't start (Windows) | Red indicator in MCP panel, no error details | Use `"gbrain.cmd"` (not `"gbrain"`) in MCP config |
| Wrong subcommand in config | Server starts then immediately exits | Set args to `["serve"]` |
| `gbrain import` hangs | Lock timeout error in terminal | Fully quit Antigravity before running CLI writes |
| WASM / EOF crash on init | `PGLite failed to initialize...macOS 26.3...` | Run `ollama pull nomic-embed-text` and ensure Ollama is running |
| Database corruption | WAL / checkpoint / page errors on start | Factory reset: rename `~/.gbrain`, re-init, re-import |
| Orange light won't turn green | Stuck in "initializing" for > 60 seconds | Confirm Ollama is running (`ollama serve`) |
| Brain content is stale | Agent can't find recently added docs/code | Follow the [4-step update workflow](#41-the-update-workflow) |
| Import indexed wrong files | Brain returns irrelevant results | Ran import from wrong directory — factory reset and re-import from correct path |
| Cross-project confusion | Agent mixes up Project A and B context | Tell the agent which project you're working on — vector search handles the rest |

---

## 7. Further Reading

- [GBrain — GitHub Repository](https://github.com/garrytan/gbrain)
- [Ollama — Installation & Models](https://ollama.com/)
- [Model Context Protocol — Specification](https://modelcontextprotocol.io/)
- [PGLite — Embedded Postgres for the Browser & Node.js](https://pglite.dev/)
- [nomic-embed-text — Model Card](https://ollama.com/library/nomic-embed-text)
