---
title: "Effective automation prompt"
type: note
created: 2025-11-21
updated: 2025-11-21
source: chatgpt-export
conversation_id: 6920d27b-f210-832b-a95c-ca34a8439bb0
message_count: 4
tags: [chatgpt, import]
---
# Effective automation prompt

> Conversation ID: 6920d27b-f210-832b-a95c-ca34a8439bb0
> Created: 2025-11-21T20:59:03Z
> Updated: 2025-11-21T21:00:29Z
> Messages: 4

---

## User

look at this site and discover the most effective prompt to have chatgpt agent mode go through the site and follow as many creators as possible

---

## Assistant

Mr. White — here’s the reality: this site requires *button interactions*, scrolling, pagination, and login-dependent actions (like pressing **Follow** repeatedly). So the best prompt is one that:

- tells the agent what the objective is,
- tells it how to identify the targets,
- tells it to loop across pages,
- tells it how to detect completion,
- and tells it what to do if something fails.

You also want to avoid vague instructions — agents perform better with structure.

---

### **Most Effective Prompt:**

Use this exact phrasing:

---

**Prompt:**

> You are in automation mode. Your task is to follow as many creators as possible on this website.  
>   
> **Goal:** Click every visible **Follow** button on the page.  
>   
> **Process:**  
> 1. Scroll to the top of the page and scan for any button labeled **Follow** or **Followed**.  
> 2. For each visible **Follow** button that is not already marked as **Followed**, click it once.  
> 3. After completing the visible area, scroll down until no new follow buttons appear.  
> 4. If there are pagination controls (numbers or Next/→ arrows), click the next page and repeat the process.  
>   
> **Rules:**  
> - Do not click a button labeled **Followed**.  
> - Avoid reloading the page unless necessary.  
> - If a popup appears, close it and continue.  
> - Continue until no additional pages or follow buttons remain.  
>   
> When finished, confirm: “No more creators available to follow.”

---

### **Reason this works:**

✔ It tells the agent exactly what counts as a target.  
✔ It instructs it to navigate, not just click.  
✔ It handles pagination and prevents loops.  
✔ It defines a stopping condition.

---

If you'd like, I can also optimize it further depending on which agent system you're using (OpenAI Agent, browser-based agent, Auto-GPT style, etc.).

Would you like:

- **A version optimized for OpenAI’s Autonomous Actions**
- **A Click-by-Click Macro format**
- **A fully looped automation script (JS / Tampermonkey)**  
- **Or a shorter version optimized for mobile agent sessions?**

---

## User

A version optimized for OpenAI’s Autonomous Actions but also we want to optimize for least clicks so finding a dicoverpage or input the url and incrementing it (they use an incremental userid pattern) etc. 

---

## Assistant

Mr. White — here’s the best *agent-style automation prompt* tailored specifically for **OpenAI Autonomous Actions**, designed to minimize clicks by exploiting predictable URL patterns, pagination, and follow-button scanning.

This format gives the agent a **goal, strategy hierarchy, fallback logic, loop structure, and stopping check** — which is what makes autonomous agents behave reliably.

---

## **Optimized Automation Prompt (Copy + Use)**

> **Objective:** Systematically follow as many creators as possible on `app.hellothematic.com`.  
> 
>   
> **Primary Action:** Follow any user that is not already marked as "Followed".
> 
> ---
> 
> ### **Execution Strategy**
> 
> **1. Establish Navigation Rules**
> - Start at the creator discovery page: `https://app.hellothematic.com/discover#creators`.
> - If redirected or logged out, return to this URL after login.
> 
> **2. Detect Follow Targets**
> - A valid follow button is labeled exactly **"Follow"** (not "Followed").
> - For every visible "Follow" button, click once.
> 
> **3. Page-Wide Sweep**
> - Scroll from top to bottom and repeat scanning until no new "Follow" buttons appear.
> 
> **4. Pagination / Bulk Navigation**
> - If a numbered pagination selector exists, navigate sequentially through pages: `1 → 2 → 3 → …` until no more pages exist.
> - If there is a “Next” button instead of numbers, click it until it becomes disabled or disappears.
> 
> **5. URL Pattern Optimization**
> - If user profiles follow an incremental structure (example format):
>   `https://app.hellothematic.com/user/<ID>`
> - Attempt sequential navigation by incrementing ID values in batches of 10 at a time (e.g., 1000 → 1010 → 1020).
> - At each visited profile:
>   - Scan the page for a "Follow" button and click if available.
>   - Skip if "Followed" is already present.
> 
> **6. Loop Behavior**
> - Repeat scanning + following + pagination until:
>   - The system detects **no remaining Follow buttons** across all reachable pages.
> 
> ---
> 
> ### **Safety & Error Handling**
> - If a click fails or a modal blocks progress, close the modal and retry once.
> - If stuck on a page for more than 60 seconds, navigate back to the main discovery URL and continue.
> - Do not click "Unfollow" buttons.
> 
> ---
> 
> ### **Completion Condition**
> When no additional "Follow" buttons can be discovered via:
> - scrolling,
> - pagination,
> - or incremental URL traversal,
> 
> return the message:
> 
> **“All available creators have been followed.”**

---

## **Why This Version Is Effective**

✔ **Compatible with autonomous agents** (explicit rules, loops, exit conditions).  
✔ **Reduces clicks** by using sequential URL brute-discovery instead of only UI browsing.  
✔ **Prevents re-clicking or unfollowing** by name-matching only `"Follow"`.  
✔ **Self-recovering** if stuck, logged out, or modal-blocked.  

---

## Next Step Options

If you want, I can also generate:

- **A JavaScript bookmarklet version** to run without agent mode  
- **A Tampermonkey auto-follow script**  
- **A JSON-formatted task for the OpenAI Actions API**

---

Would you like one of those as well, Mr. White?


## See Also
- [[chatgpt/chatgpt_ci-automation-prompt]]
- [[chatgpt/chatgpt_admin-dashboard-prompt]]
- [[chatgpt/chatgpt_agent-mode-prompt]]
- [[chatgpt/chatgpt_ai-engineering-agent-prompt-part1]]
- [[chatgpt/chatgpt_ai-engineering-agent-prompt-part2]]
