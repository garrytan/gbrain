---
title: "App Test Report"
type: note
created: 2026-03-15
updated: 2026-03-15
source: chatgpt-export
conversation_id: 69b6459c-1324-8323-886d-9da8b6fff8be
message_count: 4
tags: [chatgpt, import]
---
# App Test Report

> Conversation ID: 69b6459c-1324-8323-886d-9da8b6fff8be
> Created: 2026-03-15T05:37:38Z
> Updated: 2026-03-15T05:39:02Z
> Messages: 4

---

## User

test this app

---

## Assistant

Mr. White,

Quick UI/QA pass from the current Releases page:

**Likely issues**
- Duplicate page header/content blocks appear in the DOM for **Releases**. This often signals duplicated rendering or hidden layout state that can cause accessibility and focus issues.
- The import status says **“Importing releases from Spotify... 0 imported”** while the table already shows 23 releases. That state may be stale or misleading.
- Two releases show missing metadata:
  - **All This Noise (Remixed)**
  - **All This Noise EP**
  
  Both display **— / —** where popularity/year normally appear.
- The detail pane for **Revival** shows **“Single · 2 tracks · 3 platforms”**, but the new release form supports many platforms. Worth checking whether platform count is accurate and derived correctly.
- The “Add Release” form has no visible validation hints for required fields beyond field presence. High risk for silent failure on empty title/date.
- **Artwork URL** and all platform URL fields need URL validation, normalization, and duplicate handling.
- The release list includes potential duplicate-title cases:
  - **Seaside Heights** appears twice with different slugs/years
  - **Take Me Over** appears in multiple variants/remixes
  
  Worth verifying deduping, search, and sorting behavior.
- Accessibility looks incomplete:
  - many buttons have aria-labels, which is good
  - some controls are generic **“button”** elements with unclear text/state
  - popularity is only exposed as an aria-label, which may be weak for sighted users
- The right-side preview/detail panel appears tied to the selected release, but the cursor is still inside the table. Worth testing selection synchronization and keyboard navigation.

**High-priority test cases**
1. Create release with valid title/date only.
2. Submit empty form and verify inline errors.
3. Paste invalid URLs into platform fields.
4. Create a release with a slug collision.
5. Search for “Seaside Heights” and confirm duplicate handling.
6. Toggle preview on/off and verify selected release stays consistent.
7. Export CSV and verify all 23 rows plus missing-value handling.
8. Refresh during Spotify import and verify loading state resets correctly.
9. Open/copy smart links and confirm slug correctness.
10. Test keyboard-only navigation across table, form, and detail panel.

**Bugs I would log immediately**
- Misleading Spotify import state.
- Missing year/popularity rendering for two releases.
- Possible duplicated layout/sidebar/header render.
- Unclear empty/error states in release creation form.

I can use your browser to actively click through this page and produce a real bug list with repro steps. Would you like me to continue?

---

## User

yes

---

## Assistant

Mr. White,

Here’s a tighter bug list from exercising the Releases view. Each item includes repro steps.

| Issue | Severity | Repro |
|---|---:|---|
| “Seaside Heights” appears twice (2018 slug `/tim/seaside-heights-3`, 2020 slug `/tim/seaside-heights`) without an obvious disambiguation indicator | Medium | Open Releases; scroll down to 2018–2020 entries; observe duplicate titles with different slugs |
| “All This Noise (Remixed)” shows missing year and popularity (displayed as `—`) | Medium | Open Releases; scroll down near 2024; observe “All This Noise (Remixed)” row displays `—` for both year and popularity |
| “All This Noise EP” shows missing year and popularity (displayed as `—`) | Medium | Open Releases; scroll down near 2024; observe “All This Noise EP” row displays `—` for both year and popularity |
| Release type row for “All This Noise EP” is inconsistent (shown as “Single” even though title indicates EP) | Medium | Open Releases; scroll down near 2024; observe “All This Noise EP” row shows “Single” as the type |
| Multiple releases share “Take Me Over” title with versioned slugs (e.g., `/tim/take-me-over-2`) but the UI doesn’t clearly show why they differ (no mix/version tag in the title) | Low | Open Releases; observe first items in list |
| Popularity appears only as an aria-label on a button, which is weak for sighted users (no numeric popularity shown next to entry) | Low | Open Releases; observe entries show no popularity number in visible text despite aria-label being present |
| Release sidebar “Tracks (2)” string renders with spacing anomalies due to JSX text splitting (“Tracks ( 2 )”), which can be confusing | Low | Select a release (e.g., Revival); observe Tracks section header in sidebar |

If you want, I can keep going with: form validation (blank title/date), URL validation (invalid URLs in platform fields), CSV export shape (rows/columns, handling of `—`), search filtering, and preview toggle state persistence.


## See Also
- [[chatgpt/chatgpt_slow-test-files-report]]
- [[chatgpt/chatgpt_audit-report-summary]]
- [[chatgpt/chatgpt_bodyspec-report-summary]]
- [[chatgpt/chatgpt_chat-testing-report]]
- [[chatgpt/chatgpt_de-annual-report-filing]]
