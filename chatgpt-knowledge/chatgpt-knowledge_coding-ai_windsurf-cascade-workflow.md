---
title: "Windsurf Cascade Workflow"
type: guide
created: 2025-12-24
updated: 2025-12-24
source: chatgpt-export
topic: coding-ai
message_count: 6
tags: [chatgpt, knowledge, coding-ai]
---
**Topic:** [[chatgpt-knowledge/_topics/coding-ai]]

# Windsurf Cascade Workflow

> **Source:** ChatGPT conversation
> **Date:** 2025-12-24T22:56:03Z
> **Messages:** 6
> **Topic:** coding-ai

## Question

Extract this prompt and stuff into something we can turn into a workflow in windsurf cascade that will simply first back a list ideas. It should then prompt me what ideas to I like or dont look open a detailed in linear issue for each idea I specify. 

For example it will asks which ida, I answer 2,3 and 5. It creates 3 issues in linear corresponding to those it properly tags and labels them and fill out all info needed. If sub tasks are required it should enter those as well.

Here's the first prompt:
## YOUR ROLE - UI/UX IMPROVEMENTS IDEATION AGENT

You are the **UI/UX Improvements Ideation Agent** in the Auto-Build framework. Your job is to analyze the application visually (using browser automation) and identify concrete improvements to the user interface and experience.

**Key Principle**: See the app as users see it. Identify friction points, inconsistencies, and opportunities for visual polish that will improve the user experience.

---

## YOUR CONTRACT

**Input Files**:
- `proj

## Answer

Mr. White — here’s a **Windsurf Cascade Workflow** version of your prompt that does exactly:

1) **Generate + print a numbered idea list**  
2) **Ask you which numbers to turn into Linear issues**  
3) **Create one Linear issue per selected idea**, with **labels/tags**, **full description**, and **subtasks** (as child issues) when needed.

It’s written as a single markdown workflow file (how Windsurf Workflows are stored/executed). citeturn1view0

---

## 1) Create this workflow file

Save as:

`/.windsurf/workflows/uiux-ideate-then-file-linear.md` citeturn1view0

```md
# uiux-ideate-then-file-linear
Generate UI/UX improvement ideas by visually inspecting the running app, then (only for selected ideas) file detailed Linear issues with labels + subtasks.

---

## Inputs (expected files)
- project_index.json
- ideation_context.json
- graph_hints.json (optional)

## Outputs (created/updated)
- ideation/ui_ux_ideas.json (created)
- ideation/ideation.json (appended if exists, else created)
- ideation/linear_issue_map.json (created/updated)

---

## Step 1 — Load context and find the app URL
Run:

```bash
set -e

echo "== Reading project context =="
cat project_index.json
echo
cat ideation_context.json
echo

echo "== Optional graph hints =="
cat graph_hints.json 2>/dev/null || echo "No graph hints available"

echo "== Dev scripts / config hints =="
cat package.json 2>/dev/null | grep -A5 '"scripts"' || true
cat vite.config.ts 2>/dev/null | head -30 || true
cat next.config.js 2>/dev/null | head -20 || true

echo "== Checking common dev ports =="
lsof -i :3000 2>/dev/null | head -3 || true
lsof -i :5173 2>/dev/null | head -3 || true
lsof -i :8080 2>/dev/null | head -3 || true
```

Decide which URL to visit (prefer a running port):
- http://localhost:3000
- http://localhost:5173
- http://localhost:8080

If none are running, proceed with static analysis (Step 3 fallback).

---

## Step 2 — Visually inspect the app (Puppeteer MCP)
If Puppeteer MCP is available, do:

### 2.1 Landing
<puppeteer_navigate>
url: http://localhost:3000
wait_until: networkidle2
</puppeteer_navigate>

<puppeteer_screenshot>
path: ideation/screenshots/landing_page.png
full_page: true
</puppeteer_screenshot>

### 2.2 Navigation
<puppeteer_screenshot>
path: ideation/screenshots/navigation.png
selector: nav, header, .sidebar
</puppeteer_screenshot>

### 2.3 Interactive state
<puppeteer_click>
selector: button, .btn, [type="submit"]
</puppeteer_click>

<puppeteer_screenshot>
path: ideation/screenshots/interactive_state.png
</puppeteer_screenshot>

### 2.4 Forms (if present)
<puppeteer_screenshot>
path: ideation/screenshots/forms.png
selector: form, .form-container
</puppeteer_screenshot>

### 2.5 Empty states (best-effort)
<puppeteer_screenshot>
path: ideation/screenshots/empty_state.png
</puppeteer_screenshot>

### 2.6 Mobile
<puppeteer_set_viewport>
width: 375
height: 812
</puppeteer_set_viewport>

<puppeteer_screenshot>
path: ideation/screenshots/mobile_view.png
full_page: true


*(Answer truncated — 7809 chars total)*

## Question

We want ideation for multiple categories but we have a prompt for each. We can split the opening issues out seperately.

Give me the whole prompt in marckdwon

## Answer

Mr. White — here’s the **full workflow prompt** in **Markdown**, generalized so it can run **multiple ideation categories (one prompt per category)**, then ask you which ideas to file, and create **Linear issues + subtasks** for the ones you pick.

```md
# AUTO-BUILD — MULTI-CATEGORY IDEATION → SELECT → LINEAR ISSUES

You are an agent in the Auto-Build framework. You will run ideation across multiple categories, each category having its own prompt/spec. Your job is to:
1) Generate ideas per category (as JSON)
2) Print a numbered list of ideas (across all categories)
3) Ask the user which idea numbers to file
4) Create a detailed Linear issue for each selected idea (plus subtasks when needed)

**Key Principle:** Be concrete, reference real files, and prefer changes that improve user impact.

---

## INPUTS

**Input Files (required unless missing):**
- `project_index.json` — project structure / tech stack
- `ideation_context.json` — existing features, roadmap items, kanban tasks

**Input Files (optional):**
- `graph_hints.json` — historical successes/failures/duplicates
- `ideation/ideation.json` — prior ideation output (if exists)

---

## OUTPUTS

Create/update these:
- `ideation/<category>_ideas.json` (one per category, e.g. `ui_ux_ideas.json`)
- `ideation/ideation.json` (append into appropriate arrays)
- `ideation/linear_issue_map.json` (mapping idea → Linear issue IDs/URLs)

---

## GLOBAL RULES (APPLIES TO ALL CATEGORIES)

1) **Avoid duplicates**
   - Use `ideation_context.json`, `ideation/ideation.json` (if exists), and `graph_hints.json` (if exists).
2) **Be specific**
   - Identify where in the UI/code the issue exists and what exact change to make.
3) **Reference evidence**
   - Prefer screenshot paths (if visual inspection is possible). Otherwise cite code locations.
4) **Affected components must be real**
   - Use actual file paths when possible.
5) **Output must be valid JSON**
   - IDs must be unique across the entire run.

---

## IDEA OBJECT CONTRACT (UNIFIED)

Each idea MUST match this structure (category-specific fields may be added, but not removed):

```json
{
  "id": "cat-001",
  "type": "category_name",
  "title": "Short descriptive title",
  "description": "What the improvement does",
  "rationale": "Why this improves UX / product goals",
  "category": "subtype|bucket|enum_for_this_category",
  "severity": "low|medium|high",
  "effort": "low|medium|high",
  "user_impact": "low|medium|high",
  "affected_components": ["path/to/File.tsx"],
  "screenshots": ["ideation/screenshots/example.png"],
  "current_state": "Description of current state",
  "proposed_change": "Specific change to make",
  "acceptance_criteria": [
    "Bullet 1",
    "Bullet 2"
  ],
  "subtasks": [
    {
      "title": "Action-oriented subtask title",
      "description": "What to do",
      "affected_components": ["path/to/File.tsx"],
      "acceptance_criteria": ["..."]
    }
  ],
  "status": "draft",
  "created_at": "ISO timestamp"
}
```

**Notes**
- `id` 

*(Answer truncated — 20212 chars total)*

## Question

The prompt Igave you originally was from autoclaved. Since we're making a windsurf workflow from it it won't have access to all the autoclaved specific features. So you need to extract just the prompt stuff and put it in. It WILL have access to puppeteer mcp.

## Answer

Mr. White — got it. Below is the **extracted, Windsurf-ready** version of your **UI/UX Ideation Agent prompt**, with **all Autoclaved-specific dependencies removed** (no `project_index.json`, no `ideation_context.json`, no Graphiti/`graph_hints.json`, no “append to ideation.json” contract). It **assumes you DO have Puppeteer MCP** and normal repo filesystem access.

Copy/paste this as the workflow prompt (Markdown):

```md
# UI/UX Improvements Ideation Agent (Windsurf + Puppeteer MCP)

You are a UI/UX Improvements Ideation Agent. Your job is to **visually inspect the running web app** using Puppeteer MCP, identify **concrete UI/UX improvements**, and produce a **structured list of actionable ideas**.

## Core principles
1. **Actually look at the app** (screenshots + interaction states).
2. **Be specific** (name the UI surface, what’s wrong, and the exact change).
3. **Tie to evidence** (screenshot paths and/or component file paths).
4. **Prefer existing patterns** (reuse design tokens, component variants, conventions).
5. **Prioritize user impact** (high friction first; quick wins welcome).

---

## Output requirements

### A) Print a numbered list (for user selection)
After ideation, print a compact numbered list:

1) uiux-001 — <Title> [usability|accessibility|performance|visual|interaction]  
2) uiux-002 — ...  
...

### B) Write a JSON file
Write ideas to: `ideation/ui_ux_ideas.json`

Each idea MUST match this schema:

```json
{
  "id": "uiux-001",
  "type": "ui_ux_improvements",
  "title": "Short descriptive title",
  "description": "What the improvement does",
  "rationale": "Why this improves UX",
  "category": "usability|accessibility|performance|visual|interaction",
  "affected_components": ["src/components/Component1.tsx"],
  "screenshots": ["ideation/screenshots/landing_page.png"],
  "current_state": "Description of what exists now",
  "proposed_change": "Specific change to make",
  "user_benefit": "How users benefit",
  "severity": "low|medium|high",
  "effort": "low|medium|high",
  "user_impact": "low|medium|high",
  "acceptance_criteria": [
    "Bullet 1",
    "Bullet 2"
  ],
  "subtasks": [
    {
      "title": "Action-oriented subtask title",
      "description": "What to do",
      "affected_components": ["src/components/Component1.tsx"],
      "acceptance_criteria": ["..."]
    }
  ],
  "status": "draft",
  "created_at": "ISO timestamp"
}
```

Notes:
- `id` must increment: `uiux-001`, `uiux-002`, ...
- `affected_components` must be real paths when possible (best-effort).
- `screenshots` must include real screenshot paths captured during the run.
- Use `subtasks` only when the work naturally breaks into multiple steps.

---

## Phase 0 — Determine the app URL (Windsurf environment)

Try these URLs in order until one loads:
- `http://localhost:3000`
- `http://localhost:5173`
- `http://localhost:8080`

If none load, stop and report: “No running dev server detected on common ports.”

(You may optionally run a quick port check in ter

*(Answer truncated — 8405 chars total)*
