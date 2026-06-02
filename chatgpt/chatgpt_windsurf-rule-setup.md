---
title: "Windsurf rule setup"
type: note
created: 2025-08-18
updated: 2025-08-18
source: chatgpt-export
conversation_id: 68a27db8-2e14-832b-aa2e-0c47313cac0a
message_count: 2
tags: [chatgpt, import]
---
# Windsurf rule setup

> Conversation ID: 68a27db8-2e14-832b-aa2e-0c47313cac0a
> Created: 2025-08-18T01:11:48Z
> Updated: 2025-08-18T01:11:59Z
> Messages: 2

---

## User

Check all the docs and stuff on the latest Windsurf, like they just updated it like a week ago. How am I supposed to handle setting up rules? It's not clear. There's an import from Cursor that creates individual rules, but then there's also the global rule file and stuff. I'm just not sure exactly how I'm supposed to be specifying these rules.

---

## Assistant

Certainly, Mr. White.

Here’s a clear breakdown of how Windsurf handles rules, based on recent updates (as of August 2025):

---

##  Windsurf Rules: How to Define and Use Them

### 1. Project-Specific Rules (`.windsurfrules`)
- To define behaviors for individual projects, create a file named `.windsurfrules` at the root of your project.
- This file lets you specify coding guidelines, context, conventions, and preferences that Cascade (Windsurf’s AI agent) should follow.citeturn0search1turn0search13
- Example use cases include enforcing file structure, import paths, naming conventions, validation patterns, etc.citeturn0search13turn0search11
- Note: There's a character limit—approximately 6,000 characters for workspace rules, plus an additional 6,000 for global context.citeturn0search13

### 2. Global Rules (`global_rules.md`)
- These rules apply across all your Windsurf workspaces.
- You define them in a `global_rules.md` file—similar to how Cursor handled global settings.citeturn0search1turn0search16
- They enforce consistent behaviors or coding styles across all projects.

### 3. Importing from Cursor
- You can import file-based rules from Cursor.
- Cursor rules are in `.mdc` files (usually under `.cursor/rules/`). Windsurf can ingest those for consistency if you're migrating.citeturn0search8

### 4. Rules Builder & Prebuilt Templates
- Windsurf offers curated rule templates (e.g., Next.js, React, Tailwind CSS) to jump-start your setup.
- You can find and use these from the Windsurf Rules Directory or within Cascade’s “Rules” panel.citeturn0search7turn0search11
  - Example: React rules might enforce functional components, proper naming, prop validation, etc.citeturn0search7turn0search11

### 5. Setting Rules via Cascade UI
- Within Cascade, go to the Customizations icon (usually in the top-right).
- Under the “Rules” panel, you can add new rules:
  - Use the **+Global** button to define global rules.
  - Use the **+Workspace** or **+Project** button to create project-specific rules.citeturn0search7

---

##  Quick Summary Table

| Rule Type           | File Name / Location     | Scope           | Notes                                                                 |
|--------------------|--------------------------|----------------|-----------------------------------------------------------------------|
| Project-Specific   | `.windsurfrules`         | One project    | ~6k chars; store coding guidelines, context, conventions              |
| Global             | `global_rules.md`        | All projects   | Applies across all workspaces, enforces company-wide preferences     |
| Imported from Cursor | Cursor’s `.mdc` rule files | One project or global | Handy if migrating from Cursor (.cursor/rules/*.mdc)                |
| Prebuilt Templates | Rules Directory / UI     | Project or global | Best practices for popular frameworks (React, Next.js, Tailwind)     |

---

##  How to Proceed

1. **Decide rule scope**:
   - Use `.windsurfrules` for project-level behaviors.
   - Use `global_rules.md` for overarching conventions.

2. **Leverage templates**:
   - Browse the Windsurf Rules Directory or Cascade UI for rule templates.

3. **Import if relevant**:
   - If migrating from Cursor, you can import `.mdc` rule files.

4. **Access via UI**:
   - Use Cascade’s Customizations → Rules panel to manage rules easily.

---

Let me know if you'd like a sample `.windsurfrules` file or want help crafting one tailored to your stack.


## See Also
- [[chatgpt/chatgpt_windsurf-autopilot-setup-part1]]
- [[chatgpt/chatgpt_windsurf-autopilot-setup-part2]]
- [[chatgpt/chatgpt_accelerator-tracking-setup]]
- [[chatgpt/chatgpt_ai-ops-setup-inquiry]]
- [[chatgpt/chatgpt_ai-setup-instructions]]
