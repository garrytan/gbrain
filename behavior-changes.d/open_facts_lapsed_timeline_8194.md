---
kind: fix
---
gbrain repair open-facts now leaves a fact private when its valid_until date has passed, and counts it as lapsed in the preview. It also opens a fenced fact whose ## Facts table sits below the timeline sentinel; before, such a fact was always reported fact_left_private. The preview now warns that a fact saved private on purpose before the cut looks the same as a legacy one, and that --ids-file narrows the set.
