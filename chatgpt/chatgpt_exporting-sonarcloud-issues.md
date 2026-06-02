---
title: "Exporting SonarCloud Issues"
type: note
created: 2025-12-30
updated: 2025-12-30
source: chatgpt-export
conversation_id: 69538296-ec80-8325-a255-163dbe5c4021
message_count: 2
tags: [chatgpt, import, code]
---
# Exporting SonarCloud Issues

**Related:** [[coding_troubleshoot]]

> Conversation ID: 69538296-ec80-8325-a255-163dbe5c4021
> Created: 2025-12-30T07:43:25Z
> Updated: 2025-12-30T07:43:39Z
> Messages: 2

---

## User

HOW DO I EXPORT THESE?

---

## Assistant

Mr. White,

**SonarCloud does not offer a native “Export issues” button in the UI.** You have three practical options:

---

## Option 1 — SonarCloud Web API (best, scalable)
Use the Issues API to export all filtered issues as JSON, then convert to CSV.

**Steps**
1. Create a SonarCloud token  
   *Account → Security → Generate Token*
2. Call the Issues API with your filters (security, open, project).

**Example**
```bash
curl -u YOUR_TOKEN: \
"https://sonarcloud.io/api/issues/search?projectKeys=JovieInc_Jovie&statuses=OPEN,CONFIRMED&impactSoftwareQualities=SECURITY&ps=500"
```

- Paginate with `p=` (page) if results >500.
- Convert JSON → CSV using `jq`, Python, or Excel/Sheets.

This is the **only way to get a complete, repeatable export**.

---

## Option 2 — Browser CSV workaround (small lists only)
- Select all issues
- Use **Bulk Change → Assign / Set Severity** (any action)
- Copy table data manually or via browser extensions

⚠️ Fragile and not reliable for audits.

---

## Option 3 — GitHub Security tab (partial)
If GitHub integration is enabled:
- Some workflow issues appear under **Security → Code scanning**
- Exportable, but **incomplete** (not all Sonar issues sync)

---

## Recommendation
If this is for **security review, compliance, or investor diligence**:
- Use **Option 1 (API)**  
- Export → CSV → track remediation status over time

If you want, I can:
- Generate the exact API URL with all your current filters applied, **or**
- Give you a 10-line Python script that outputs a clean CSV.


**Topic:** [[chatgpt-clusters/coding_troubleshoot]]
