---
title: "Clean Up Prompt"
type: note
created: 2026-01-29
updated: 2026-01-29
source: chatgpt-export
conversation_id: 697bc55b-763c-8332-ac47-6ab39a4ef640
message_count: 2
tags: [chatgpt, import]
---
# Clean Up Prompt

> Conversation ID: 697bc55b-763c-8332-ac47-6ab39a4ef640
> Created: 2026-01-29T20:38:54Z
> Updated: 2026-01-29T20:39:20Z
> Messages: 2

---

## User

clean up this prompt                                                                        
 ▐▛███▜▌   Claude Code v2.1.23                                         
▝▜█████▛▘  Sonnet 4.5 · Claude Max                                     
  ▘▘ ▝▝    ~/Documents/GitHub/TBF/Jovie                                
                                                                       
───────────────────────────────────────────────────────────────────────
❯ pull in sentry issues from last 24 hours and all sonar issues (all   
  of them). then sort them into batches. do the quick wind first so    
  whatever is going to eliminate the largest number of issues the      
  fastest. then crate a giant taks list with all the issues. and       
  begin running through them. after each large batch run /verify and   
  /simplify followed by /pr with auto merge on. then when you get to   
  zero run issues left run /clean. run as long as you have to. do not  
  stop. ask any questions up front to prevent stopping                 
───────────────────────────────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+Tab to cycle)   ⧉ 52 lines selected  































---

## Assistant

Here’s a clean, tight version with corrected spelling, clear sequencing, and unambiguous instructions:

---

**Task**

1. Pull all **Sentry issues from the last 24 hours** and **all Sonar issues**.
2. Combine and **group issues into batches**.
3. **Prioritize quick wins first** — actions that eliminate the **largest number of issues in the least time**.
4. Create a **single comprehensive task list** covering all issues.
5. Execute tasks batch by batch:
   - After each major batch, run:
     - `/verify`
     - `/simplify`
     - `/pr` with **auto-merge enabled**
6. Continue until **zero issues remain**.
7. Once all issues are resolved, run `/clean`.
8. **Run continuously without stopping** until completion.
9. **Ask all clarification questions up front** to avoid interruptions later.

---

If you want, I can also produce:
- a **more aggressive version** (less validation, faster merges), or  
- a **safer version** (extra verification gates before auto-merge).
