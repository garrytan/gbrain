---
conversation_id: 6972cc61-ca28-8328-b86a-ab085b412ece
created: 2026-01-23
links:
- '[[chatgpt-clusters/coding_ai_ml]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: Upgrade Claude CLI
type: note
updated: 2026-01-23
---

# Upgrade Claude CLI

> Conversation ID: 6972cc61-ca28-8328-b86a-ab085b412ece
> Created: 2026-01-23T01:18:26Z
> Updated: 2026-01-23T06:28:40Z
> Messages: 2

---

## User

upgrade claude cli

---

## Assistant

Here’s how to upgrade the **Claude CLI (Claude Code)** tool:

### 1) Try the built-in update command  
In your terminal run:  
```bash
claude update
```  
Then verify with:  
```bash
claude --version
```  
If it shows the latest, you’re updated. citeturn0search10turn0search15

### 2) If update fails or doesn’t bump the version  
Some installations (especially via npm) don’t auto-upgrade properly. In that case you’ll need to reinstall manually:

- **Homebrew (macOS/Linux):**
  ```bash
  brew upgrade claude-code
  ```
- **Windows (Winget):**
  ```powershell
  winget upgrade Anthropic.ClaudeCode
  ```
- **npm global reinstall (all platforms):**
  ```bash
  npm install -g @anthropic-ai/claude-code
  ```
After reinstalling, check the version again with `claude --version`. citeturn0search6

### 3) Notes & troubleshooting
- The built-in auto-update isn’t always reliable on every install type. Manual reinstall often fixes stuck versions. citeturn0search2
- If you see a message about “already up to date” but version is old, that’s a known issue with some installers. Manual reinstall resolves it. citeturn0search2

If you share how you installed it originally (npm, brew, winget, or script), I can tailor exact commands.


**Topic:** [[chatgpt-clusters/coding_ai]]
