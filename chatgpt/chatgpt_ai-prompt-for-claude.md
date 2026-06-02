---
title: "AI prompt for Claude"
type: note
created: 2025-08-23
updated: 2025-08-23
source: chatgpt-export
conversation_id: 68aa2144-4524-832f-80d0-368d6332c8c9
message_count: 2
tags: [chatgpt, import]
---
# AI prompt for Claude

> Conversation ID: 68aa2144-4524-832f-80d0-368d6332c8c9
> Created: 2025-08-23T20:15:02Z
> Updated: 2025-08-23T20:15:08Z
> Messages: 2

---

## User

Hey, I got a run and I want to give Claude a big task to knock out while I'm gone. I basically want it to go through the entire codebase and look for anything that is less than optimal or less than rock-solid stability and performance in terms of our onboarding flow. So homepage performing great, creator profiles showing up great, public profiles for creators showing up great, showing up in the feature creator bar on the homepage. Those pages showing up and loading quickly and not throwing any errors, no console errors underneath these pages. Then the onboarding flow working from creating an account, running through the entire onboarding, picking your handle, and then after picking your handle it actually validating whether or not the handle is available or not, and then allowing you to continue to the next step and then showing you the dashboard and getting to the nice clean dashboard. We want to make sure that all of this works with no console errors, no 404 pages, no problems whatsoever. We want all of the unit tests to be working, we want all of the E2E tests to be working, we want all of the linting to be error free, we want to be able to run all of our tests, we want storybooks, stories, not throwing any errors. And then once all of this is done, we want to open up a PR and push it so that our CI then picks it up to be merged back into the main preview branch. So give me a concise AI prompt for that. Don't be too elaborate with specifics, allow Claude some freedom to decide how to handle tasks. Just kind of give it the guideline for what's possible and the end result that we need.

---

## Assistant

Here’s a concise prompt you can hand to Claude to run with while you’re gone:  

---

**Prompt for Claude:**  
Go through the entire codebase and ensure the onboarding flow and core pages are rock-solid in terms of stability and performance. This includes:  

- Homepage, creator profiles, and public profiles load fast with no console errors, 404s, or broken assets.  
- Featured creator bar works correctly.  
- Onboarding flow works end-to-end: account creation → handle selection → handle validation → dashboard access. No errors, clean transitions.  
- All unit tests, E2E tests, linting, and storybook stories pass without errors.  
- Once everything is stable, open a PR so CI can pick it up and merge back into the preview branch.  

Your task is to identify and fix anything less than optimal. Be thorough, aim for clean, error-free, production-ready quality.  

---

Want me to also write you a **Linear issue template** so Claude can auto-file this as a project with sub-issues, or do you just want the raw prompt?
