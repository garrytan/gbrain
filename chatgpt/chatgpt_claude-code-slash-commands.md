---
conversation_id: 6914df43-e0b0-8320-9844-744db64f6bca
created: 2025-11-12
links:
- '[[chatgpt-clusters/coding_ai_ml]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: Claude Code slash commands
type: note
updated: 2025-11-12
---

# Claude Code slash commands

**Related:** [[coding_ai]]

> Conversation ID: 6914df43-e0b0-8320-9844-744db64f6bca
> Created: 2025-11-12T19:26:02Z
> Updated: 2025-11-12T19:26:37Z
> Messages: 2

---

## User

claude code slash commands

---

## Assistant

Here’s a concise overview of how slash commands work in entity["software", "Claude Code", 0] (by entity["organization", "Anthropic", 0]) — how to use them, how to build your own, and when they’re handy.  

---

### ✅ What are slash commands  
Slash commands are prompt-shortcuts you type in the chat with Claude Code, beginning with `/`, to trigger a pre-defined workflow or instruction. citeturn0search7turn0search0turn0search4turn0search6  
There are two kinds:  
- **Built-in commands** (e.g., `/help`, `/clear`) for controlling the Claude Code session. citeturn0search0turn0search6  
- **Custom commands** you define (via Markdown files) that encode repetitive workflows or templates. citeturn0search4  

---

### 🛠 How you build your own  
1. **Decide the scope**  
   - *Project commands*: saved in your project under `.claude/commands/`, shared via version control. citeturn0search0turn0search7  
   - *Personal commands*: saved in your home folder `~/.claude/commands/`, available in all projects for you. citeturn0search4  

2. **Create a Markdown file** — name it like `my-command.md`. Example content:  
   ```md
   Perform the security review for: $ARGUMENTS
   ```  
   Here `$ARGUMENTS` captures whatever you pass after `/my-command`. citeturn0search7  

3. **Optional frontmatter metadata** (YAML at top of the .md file) for things like description, model, argument hints. citeturn0search7turn0search0  

4. **Invocation**:  
   In the chat you type:  
   ```  
   /my-command some input  
   ```  
   And Claude will run the prompt you defined, substituting “some input” for `$ARGUMENTS`. citeturn0search4  

---

### 📋 Example built-in commands  
Here are some useful built-in ones:  
- `/clear` — clear the conversation history. citeturn0search0  
- `/help` — list available commands. citeturn0search0  
- `/context` — visualise current context usage (token/space). citeturn0search0  
- `/export [filename]` — export the current chat to a file or clipboard. citeturn0search0  

---

### 🎯 When to use slash commands vs other tools  
- Use slash commands when you have **frequent, repeatable workflows** (e.g., “review code”, “create new component”, “generate blog post”) that you want to invoke quickly. citeturn0search4turn0search7  
- If your workflow is **complex**, involves many steps, integrations or logic, then a more full-blown Skill or automation strategy may be better (vs just a single Markdown prompt). citeturn0search0turn0search7  

---

### 🔍 Key limitations & remarks  
- These commands are primarily for tasks within Claude Code / your local dev context. They aren’t built for broadly automating lots of external business systems (without extra integrations). citeturn0search7turn0search4  
- Custom commands must be added via files (Markdown) and saved in the correct folder. If you don’t set them up correctly they won’t show up.  
- The `$ARGUMENTS` placeholder is the basic mechanism; you may also use positional placeholders depending on version. citeturn0search2  
- Because they reduce repeated prompt-text you send, they help to reduce token usage and keep your context cleaner. citeturn0search4  

---

If you like, Mr. White, I can **send you a template repository** (with some ready slash commands) for Claude Code that you can customise. Would you like that?


**Topic:** [[chatgpt-clusters/coding_ai]]
