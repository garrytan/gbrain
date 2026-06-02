---
title: "AI Design Review Tools"
type: note
created: 2026-01-30
updated: 2026-01-30
source: chatgpt-export
conversation_id: 697c02ad-7268-832f-902a-7c3f2bc02e62
message_count: 2
tags: [chatgpt, import]
---
# AI Design Review Tools

> Conversation ID: 697c02ad-7268-832f-902a-7c3f2bc02e62
> Created: 2026-01-30T01:00:30Z
> Updated: 2026-01-30T01:00:35Z
> Messages: 2

---

## User

is there a coderabbit for UI/design. like something that will look at a page and say "icons are using 2 differnet sizes) or "dark mode toggle renders correctly but hover state looks jank" and then leave written comments that claude or codex can address?

---

## Assistant

Yes — but it’s not exactly a **CodeRabbit-style “look at a screenshot or live page and generate natural-language UI/design issue comments”** tool yet. What does exist is a mix of **AI-assisted design-review and UX audit tooling** that can help you catch inconsistencies and areas to improve: citeturn0search0turn0search1

### 🧠 AI-assisted UI/UX analysis in design tools  
These won’t fully replace a human designer’s eye, but they *do* scan designs and point out issues (layout, consistency, contrast, UX patterns): citeturn0search0

- **AI Designer Reviewer (Figma plugin)** — analyzes screens for UI/UX issues and produces annotated suggestions on the canvas. It points out things like copy problems, layout inconsistencies, and accessibility concerns. citeturn0search0  
- **Aidentic / UX Pilot** — similar plugins in Figma that provide automated feedback on screens, though depth and accuracy vary. citeturn0search0  
- **AI design review plugins (general)** — a handful of Figma plugins and design tool extensions aim to do automated reviews tied to UX heuristics. citeturn0search1

These tools can flag: poor contrast, alignment issues, inconsistent sizing, missing UI elements, etc., and give you either in-canvas highlights or textual suggestions. citeturn0search0

### 🧪 Automated code/UX testing and audits  
For **actual code/implementation rather than static designs**, you have tools that evaluate rendered pages: citeturn0search35

- **Google Lighthouse** — runs automated audits on web pages for performance, accessibility, best practices. It won’t say “icons are two sizes” like a human, but it *will* highlight accessibility sizing/contrast issues and deviation from standards. citeturn0search35  
- **Usability & UX audit platforms** (Maze, VWO, UXaudit.io mentioned in community discussions) can analyze user behavior and flag friction points. citeturn0search10turn0search11

### ⚠️ What *doesn’t* yet exist  
There’s no mainstream tool that:  
- **Takes a page/screenshot, visually inspects every UI element**, and  
- **Writes detailed natural-language comments on specific design discrepancies** (e.g., “icon sizes differ by 2 px”, “dark-mode hover state feels off”) that are actionable out of the box.  

Academic research (like **Owl Eyes** and **AidUI**) is exploring automated visual UI issue detection and dark pattern recognition, but this isn’t available as a production tool yet. citeturn0academia27turn0academia28

### 🧩 Workflow you *can* build now  
You can approximate what you want by combining:

1. **AI design review plugins** (in Figma/Sketch) to flag UI inconsistencies and get text feedback. citeturn0search0  
2. **Lighthouse / accessibility audits** on deployed UI to catch implementation problems. citeturn0search35  
3. **AI prompt tools (ChatGPT/Claude with screenshot input)** where you feed them screenshots and ask for detailed UI critiques — not automated in a pipeline, but possible manually.

If you want tools that integrate into CI/CD and add comments on pull requests similar to CodeRabbit for *code*, the UX/design ecosystem hasn’t fully produced that yet — but the pieces are emerging.
