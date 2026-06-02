---
title: "MVP prioritization suggestions"
type: note
created: 2025-08-30
updated: 2025-08-30
source: chatgpt-export
conversation_id: 68b24fcb-489c-832f-b243-6d47de522ec7
message_count: 2
tags: [chatgpt, import]
---
# MVP prioritization suggestions

> Conversation ID: 68b24fcb-489c-832f-b243-6d47de522ec7
> Created: 2025-08-30T01:15:27Z
> Updated: 2025-08-30T01:15:34Z
> Messages: 2

---

## User

Manage links need to go back on the links tab
Dahsboar dis just a welcome message
Phone live preview is on links tab
Settings menu needs to finish the scroll to view and navigation and highlight items.
We need to go back to user menu in the bottom of sidebar and no header bar up top.
Bring back the collapsable sidebar we had before.
Ensure the neon migrations are auto applied correctly.
Ensure we are auto creating neon branches properly and auto killing neon branches properly on branch delete at git. We have GitHub and vercel neon integrations so ensure those are working correctly with our ci and nothing is getting duplicated or conflicting.
Ensure our preview auto promotes to main assuming it passes all check in ci.

---
Organize the above by priority to launch mvp and then suggest other items



---

## Assistant

Here’s how I’d prioritize your list for **MVP launch** vs. **secondary improvements**:

---

## 🔑 MVP Priorities (must-haves to ship)
1. **Links Tab**
   - Put **Manage Links** back on the links tab.  
   - Ensure **Phone Live Preview** is on the links tab.

2. **Dashboard**
   - Simplify to just a **welcome message** (no extra functionality yet).

3. **Sidebar & Navigation**
   - Restore the **collapsible sidebar**.  
   - Move the **user menu to the bottom of the sidebar**.  
   - Remove the **header bar up top**.  
   - Finish **scroll-to-view in settings menu** and ensure navigation highlights correctly.

4. **CI / Neon Integration**
   - Ensure **Neon migrations auto-apply** in CI.  
   - Auto-create Neon branches for previews.  
   - Auto-kill Neon branches when Git branches are deleted.  
   - Verify GitHub + Vercel Neon integrations don’t conflict or duplicate.  
   - Ensure **preview auto-promotes to main** if CI passes.

---

## 🚀 Next-Level Improvements (post-MVP)
- Broaden dashboard beyond welcome message (analytics, quick actions, etc.).  
- Enhance live preview experience (side-by-side, responsive states).  
- Add deeper settings polish (nested sections, advanced options).  
- Future-proof Neon/CI setup with automated monitoring & alerts for branch cleanup failures.  
- Consider feature flags to roll out new sidebar/dashboard changes safely.  

---

Do you want me to draft this into a **linear-style issue breakdown** (tiny, parallelizable tickets) so your AI agents can take them on without stepping on each other?


## See Also
- [[chatgpt/chatgpt_a7x3-holdings-name-suggestions]]
- [[chatgpt/chatgpt_ai-ops-prioritization-strategy-part1]]
- [[chatgpt/chatgpt_ai-ops-prioritization-strategy-part2]]
- [[chatgpt/chatgpt_app-name-suggestions]]
- [[chatgpt/chatgpt_artist-profile-suggestions]]
