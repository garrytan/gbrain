---
title: "Sync with MacroFactor"
type: note
created: 2025-11-21
updated: 2025-11-21
source: chatgpt-export
conversation_id: 6920e620-0748-8328-97d5-216471ffd1b4
message_count: 2
tags: [chatgpt, import]
---
# Sync with MacroFactor

> Conversation ID: 6920e620-0748-8328-97d5-216471ffd1b4
> Created: 2025-11-21T22:22:36Z
> Updated: 2025-11-21T22:23:11Z
> Messages: 2

---

## User

Is it possible for us to sync with macro factor to pull in a users current diet phase and goals?

---

## Assistant

Mr. White, **today there isn’t a public MacroFactor API you can sync to for pulling a user’s “diet phase” or goal settings directly.** MacroFactor’s official integrations are limited to platform health pipes (Apple Health / Google Health Connect, and formerly Fitbit) for *data exchange like nutrition totals and weight*, not their coaching state or program metadata. citeturn0search2turn0search22turn0search8  
And the community is still asking for a public API, which implies one isn’t available. citeturn0search1

**What *is* possible instead:**

1. **User-driven Data Export (workable, but not “live sync”)**  
   MacroFactor lets users export spreadsheets (granular CSVs). citeturn0search3  
   In those exports, the “Program Settings” file includes their calorie/macro targets over time and related program fields. citeturn0search0  
   So you could:
   - Ask users to export and upload/share that file.
   - Parse it to infer current phase (cut/bulk/maintain) and targets.
   - Re-import on your side.

   **Limitations:** manual step; only as current as last export; you’d need to map MF’s schema to your own.

2. **Health-platform bridge (live-ish, but *only totals*)**  
   If your app reads Apple Health / Health Connect, you can pull **consumed calories/macros** and weight that MF writes there. citeturn0search11turn0search8  
   **But:** those platforms don’t carry MF’s *goal type, rate-of-loss, program phase, or coaching settings*, so you can’t reconstruct “diet phase and goals” reliably from them alone.

3. **Partner / private integration**  
   If you want true syncing of coaching state, you’d need a **business partnership** with Stronger By Science / MacroFactor for a private API or data-sharing agreement. Nothing public exists to build against right now. citeturn0search2turn0search3

**Bottom line:**  
- **Live automatic sync of diet phase + goals:** not possible with public tools.  
- **Best practical path now:** user export → you ingest “Program Settings” + targets, or pull only nutrition totals via Apple Health/Health Connect.

If you want, tell me what your product needs specifically (e.g., just current target calories/macros vs. explicit “cut/bulk/maintain” labels), and I’ll sketch a clean ingestion mapping from the MF export + a fallback logic.
