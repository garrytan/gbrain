---
title: "Davinci Resolve MCP"
type: guide
created: 2026-04-27
updated: 2026-04-27
source: chatgpt-export
conversation_id: 69eeaacc-7c90-83e8-963d-89920e182c68
message_count: 6
tags: [chatgpt, import, code, long-form]
---
# Davinci Resolve MCP

> Conversation ID: 69eeaacc-7c90-83e8-963d-89920e182c68
> Created: 2026-04-27T00:16:13Z
> Updated: 2026-04-27T00:56:56Z
> Messages: 6

---

## User

davinci resolve mcp?

---

## Assistant

I’ll check current DaVinci Resolve MCP options, treating MCP as Model Context Protocol, and separate official support from community integrations and practical control paths.

---

## Assistant

Yes, Mr. White — **DaVinci Resolve MCP exists**.

The strongest current option looks like **`samuelgursky/davinci-resolve-mcp`**, a third-party MCP server that lets AI clients such as Claude, Cursor, Windsurf, Claude Code, and VS Code/Copilot control DaVinci Resolve through natural-language commands. Its README claims full coverage of the Resolve Scripting API, with **26/27 compound tools by default** and **342 granular tools** for power users. It was tested against **DaVinci Resolve Studio 19.1.3** and lists a latest release of **v2.1.0 on March 16, 2026**. citeturn675320view0turn889999view1

**Key catch:** the main repo requires **DaVinci Resolve Studio 18.5+**, Python **3.10–3.12**, and Resolve’s setting **Preferences → General → “External scripting using” → Local**. The repo states the free edition does not support external scripting. citeturn889999view0

What it can do: create/load projects, inspect projects, import media, manage media pools, create timelines, manipulate clips/markers, switch Resolve pages, configure renders, export timelines, and work with Fusion comps/nodes. The repo gives examples like “List all projects,” “Create a new timeline,” “Add a marker,” “Set up a ProRes render,” and “Create a Fusion composition.” citeturn889999view1

Basic install flow:

```bash
git clone https://github.com/samuelgursky/davinci-resolve-mcp.git
cd davinci-resolve-mcp
python install.py
```

Then connect it from your MCP client. The installer says it can configure clients including Claude Desktop, Claude Code, Cursor, VS Code/Copilot, Windsurf, Cline, Roo Code, Zed, Continue, and others. citeturn889999view2

There are lighter alternatives, such as `apvlv/davinci-resolve-mcp`, which supports project management, timeline operations, media import, Fusion helpers, page navigation, and arbitrary Python/Lua execution. citeturn675320view1

Security note: this class of MCP can execute Resolve actions and, in some implementations, arbitrary Python/Lua. MCP tools are designed so models can invoke external systems, and the MCP spec recommends keeping humans in the loop for tool invocations. citeturn163607view1

For practical use: **use the Samuel Gursky repo if you have Resolve Studio; expect friction on the free version.**

---

## User

and then i saw theres osmething lets you use chrome and pick elements and chat with claude code in the browsser? also whats gstack broswer sidebar do?

---

## Assistant

I’ll verify both tools, separate the Chrome element-picker/Claude Code workflow from GStack’s sidebar, and map what each actually does.

---

## Assistant

Mr. White, you are probably seeing **three different things** that overlap:

| Tool | What it is | Best use |
|---|---|---|
| **Claude in Chrome / Claude Code Chrome integration** | Official Anthropic browser automation for Claude Code. Claude can open Chrome/Edge tabs, click, type, read DOM/console logs, use your logged-in browser state, and test/debug web apps. It is currently beta and requires Claude Code plus the Chrome extension. citeturn161833view0turn220147view0 | Let Claude Code test your app in a real browser. |
| **Claude Code Browser / element picker tools** | Third-party extensions that let you point at a page element and send that element/context to Claude Code. One Chrome Web Store listing says: “Point at page elements and let Claude Code fix them,” with element picker, DOM tree, and streaming chat. citeturn161833view4 | “This button/div/card is wrong — fix this exact thing.” |
| **GStack browser sidebar** | Part of Garry Tan’s `gstack` Claude Code setup. It gives Claude Code a persistent browser plus a Chrome side panel/chat where a child Claude instance can browse, click, extract, screenshot, and stream progress back. citeturn220147view5turn797875view0 | More agentic QA/design review/web automation from inside the browser. |

### The “pick elements and chat with Claude Code in the browser” thing

The closest match is **Claude Code Browser**, a Chrome extension whose listing says it provides **visual web debugging with an element picker, DOM tree, and streaming chat**. It is useful when you are working on a frontend and want to click the exact UI element that needs changing, then tell Claude Code what to do. citeturn161833view4

There is also **Claude Element Inspector**, a VS Code extension plus Chrome companion extension. Its flow is: open your project in VS Code, install the Chrome extension, press **Alt+P**, click an element, view its tag/classes/styles/selector, then send a natural-language instruction to Claude Code. citeturn161833view5

Another related one is **Web to MCP**, which lets you select a website component and send its DOM structure, computed CSS, screenshot, and context into Claude Code through MCP. That is more for copying/recreating UI patterns from websites than debugging your own app. citeturn161833view6

### What GStack’s browser sidebar does

GStack is broader. It gives Claude Code a **persistent Chromium browser** and a bunch of opinionated workflows for founders/engineering teams: office-hours, planning review, design review, QA, code review, shipping, etc. The browser piece runs as a long-lived local Chromium daemon so Claude does not lose tabs, cookies, or login state between commands. citeturn220147view5

The **GStack browser sidebar** has two layers:

1. **Observer/control UI**  
   It shows a live feed of browser commands, command status, refs, and overlays on the page. After a `$B snapshot`, it shows clickable/referenceable `@ref` elements, so Claude can say things like `$B click @e3`. citeturn797875view3

2. **Sidebar agent chat**  
   You can type into the Chrome side panel, and GStack spawns a child Claude process with the current page context. That child Claude can run browse commands like snapshot, click, fill, extract table data, and take screenshots. It has `Bash`, `Read`, `Glob`, and `Grep`, but GStack says it withholds `Edit` and `Write` in that sidebar agent, making it file-read-only by design. citeturn797875view0

Examples from GStack’s docs include: “Take a snapshot and describe what you see,” “Click the Login button, fill in the credentials, and submit,” “Go through every row in this table and extract the names and emails,” and “Navigate to Settings > Account and screenshot it.” citeturn797875view0

### Practical recommendation

For your use case:

- **Frontend vibe-coding / exact UI edits:** try **Claude Code Browser** or **Claude Element Inspector**.
- **Claude Code testing your app like a QA agent:** use **official Claude in Chrome** first.
- **Founder/operator workflow with browser QA, planning, reviews, and agentic browsing:** use **GStack**.
- **Copying UI inspiration from other websites into Claude Code:** use **Web to MCP**.

The main caution: browser agents can see logged-in pages and perform actions. Use them on local/staging apps first, and be careful on Gmail, Stripe, admin panels, production dashboards, or anything with sensitive customer data.
