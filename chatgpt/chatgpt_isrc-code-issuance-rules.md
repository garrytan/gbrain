---
title: "ISRC Code Issuance Rules"
type: note
created: 2026-04-22
updated: 2026-04-22
source: chatgpt-export
conversation_id: 69e8ea87-15bc-83e8-876e-39807ab624c8
message_count: 2
tags: [chatgpt, import]
---
# ISRC Code Issuance Rules

> Conversation ID: 69e8ea87-15bc-83e8-876e-39807ab624c8
> Created: 2026-04-22T15:34:50Z
> Updated: 2026-04-22T15:35:05Z
> Messages: 2

---

## User

can we as a non distributor issues isrc codes on behalf of saas users if we have a prefix?

---

## Assistant

Yes—with conditions.

If you hold a valid **ISRC registrant prefix** issued by your national agency (in the U.S., typically via entity["organization","RIAA","Recording Industry Association of America"]), you are allowed to assign ISRCs. However, issuing them “on behalf of SaaS users” changes the compliance requirements.

### What is allowed
- You can assign ISRCs using your prefix **as the registrant**.
- Your SaaS users can be treated as clients whose recordings you are registering.
- Many labels and service providers operate this way.

### Key constraints
1. **You remain the registrant of record**  
   The ISRC embeds your prefix, meaning *you* are legally the entity responsible for the registration data.

2. **No resale of the prefix itself**  
   You cannot give users sub-prefixes or imply they own the ISRC namespace. They are not the registrant—you are.

3. **Accurate metadata responsibility**  
   You must ensure each ISRC is tied to correct, unique recording metadata (artist, title, version, year, etc.). Duplicate or incorrect assignments violate ISRC standards.

4. **One ISRC per unique recording**  
   If your SaaS allows edits, remasters, or alternate versions, each qualifying change may require a new ISRC.

5. **Clear terms with users**  
   Your platform should explicitly state:
   - You assign ISRCs under your prefix  
   - You are the registrant  
   - Users are licensors/content providers, not ISRC owners  

### When this becomes problematic
- If your SaaS is effectively acting like a distributor at scale, you may run into classification issues depending on how rights, delivery, and royalties are handled.
- If users expect to “own” their ISRCs independently of your system, your model will conflict with ISRC governance rules.

### Practical structure
Most SaaS platforms that do this position themselves as:
- A **service provider/label-like entity**, not just software
- With backend rights management and metadata control

### Bottom line
You can issue ISRCs to your SaaS users using your prefix, but only if:
- You remain the registrant
- You maintain full control and responsibility over assignment and data integrity
- You do not transfer or sublicense your prefix

If you want users to fully control their own ISRCs, they need to obtain their own prefix directly from their national agency.


## See Also
- [[chatgpt/chatgpt_google-search-isrc-number]]
- [[chatgpt/chatgpt_isrc-song-information]]
- [[chatgpt/chatgpt_musicfetch-isrc-matching-explained]]
- [[chatgpt/chatgpt_ada-gym-accessibility-rules]]
- [[chatgpt/chatgpt_bikini-rules-in-maldives]]
