---
title: "Building role-based schedule"
type: guide
created: 2025-10-12
updated: 2025-10-12
source: chatgpt-export
conversation_id: 68ec18ac-3dcc-832b-ab54-e9dfff5a3417
message_count: 2
tags: [chatgpt, import, code]
---
# Building role-based schedule

> Conversation ID: 68ec18ac-3dcc-832b-ab54-e9dfff5a3417
> Created: 2025-10-12T21:09:02Z
> Updated: 2025-10-12T21:11:26Z
> Messages: 2

---

## User

{'asset_pointer': 'sediment://file_00000000249c61f786cad2fa6cd28b4c', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 832, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 402232, 'width': 837}
Whats a better way to build this. Im thinking maybe all the roles are on the left and staff are in dropdowns? Then the call times are auto generated based on the roll and how many hours prior to the show time they are needed? What is your thought on how to make this as easy to use.

---

## Assistant

Mr. White — yes: flip it. Make the sheet “rules-driven” so roles drive call times and required headcount, and staff are just slotted in. Here’s a simple, fast setup that stays in plain Google Sheets.

# 1) Tabs & what goes in each
**Events** (one row per show)
- `EventID | Date | PreShift | Doors | Show | Notes`
- Store times as real datetimes (e.g., `=DATE(2025,10,10)+TIME(18,15,0)`).

**Roles & Rules** (catalog)
- `Role | Dept | Anchor ("PRESHIFT","DOORS","SHOW") | Offset_hrs | Duration_hrs | MinNeeded | MaxNeeded | EligibleTags`
    - Example: `Front Bar | Service | DOORS | 1.5 | 5 | 2 | 3 | bartender`
    - This is the only place anyone edits “logic.”

**Staff (Roster)**
- `Staff | Tags | DefaultDept | Availability(optional)`
    - Tags like `bartender, server, dishwasher`. Keep them comma-sep.

**Shifts (the working table) — LONG format**
- Columns:  
  `EventID | Date | Role | Slot# | Call | End | Assigned_Staff`
- Rows are auto-generated for each `EventID × Role × Slot#` (see #2).
- `Assigned_Staff` is a dropdown filtered to eligible people (see #3).

**Views (read-only)**
- “Day View” pivot that shows `Role → Assigned_Staff, Call, End` for a selected date.
- “People View” that shows each person’s day with conflicts highlighted.

# 2) Auto-generate the rows you need
On **Shifts!A2**, create one row per required slot using a cross-join of Events × Roles and expanding by `MinNeeded`. A robust pattern in Sheets:

```
=ARRAYFORMULA(
  LET(
    ev,  FILTER(Events!A2:E, Events!A2:A<>""),               /* EventID…Show */
    rl,  FILTER(Roles_&_Rules!A2:H, Roles_&_Rules!A2:A<>""), /* Role…MinNeeded */
    ids, INDEX(ev,,1), dates, INDEX(ev,,2),
    roles, INDEX(rl,,1), mins, INDEX(rl,,6),

    ev_rep,  FLATTEN( ids&"♦"&dates&"♦"&TRANSPOSE(SPLIT(REPT(TEXTJOIN("¶",1,roles)&"¶", ROWS(ids)), "¶")) ),
    role_rep, FLATTEN( TRANSPOSE(SPLIT(REPT(TEXTJOIN("¶",1,roles)&"¶", ROWS(ids)), "¶")) ),

    slots,   FLATTEN( IF(mins="",, ROW(INDIRECT("1:"&mins))) ),

    QUERY( SPLIT(
      FILTER( ev_rep&"♦"&role_rep&"♦"&slots, slots<>"" ),
      "♦"
    ), "where Col1<>''", 0)
  )
)
```

Rename the resulting columns to: `EventID | Date | Role | Slot#`.  
(If you’d rather avoid that formula, generate Shifts with a tiny Apps Script once; the rest still works the same.)

Compute **Call** and **End** off rules:

```
/* Call time */
=LET(
  role,   $C2,
  anchor, XLOOKUP(role, Roles_&_Rules!A:A, Roles_&_Rules!C:C),
  offhrs, XLOOKUP(role, Roles_&_Rules!A:A, Roles_&_Rules!D:D),
  pres,   XLOOKUP($A2, Events!A:A, Events!C:C),
  doors,  XLOOKUP($A2, Events!A:A, Events!D:D),
  showt,  XLOOKUP($A2, Events!A:A, Events!E:E),
  ancDT,  SWITCH(anchor,"PRESHIFT",pres,"DOORS",doors,"SHOW",showt),
  ancDT - offhrs/24
)

/* End time */
=LET(
  role,   $C2,
  durhrs, XLOOKUP(role, Roles_&_Rules!A:A, Roles_&_Rules!E:E),
  $E2 + durhrs/24
)
```

# 3) Make the staff dropdown “smart”
Only show eligible, available people who aren’t double-booked at overlapping times.

**Validation range (named `EligibleList`)**:
```
=FILTER(
  Staff!A:A,
  BYROW(Staff!B:B, LAMBDA(r, REGEXMATCH(","&LOWER(r)&",", ","&LOWER(
    XLOOKUP($C2, Roles_&_Rules!A:A, Roles_&_Rules!H:H)
  )&"," ))),                        /* tag match */
  Staff!A:A<>""
)
```

**Exclude overlaps** (optional but powerful). Add another filter term:
```
  COUNTIFS(
    Shifts!$G:$G, Staff!A:A,         /* same person */
    Shifts!$B:$B, $B2,               /* same date */
    Shifts!$E:$E, "<="&$F2,          /* other Call <= this End */
    Shifts!$F:$F, ">="&$E2           /* other End  >= this Call */
  )=0
```

Set **Data validation** on `Shifts!G:G` to “List from a range” → `=EligibleList`.

# 4) Instant over/under staffing & conflicts
- **Headcount vs need** (by role, per event):
  ```
  =COUNTIFS(Shifts!A:A,$A2, Shifts!C:C, $C2, Shifts!G:G, "<>") 
   - XLOOKUP($C2, Roles_&_Rules!A:A, Roles_&_Rules!F:F)   /* MinNeeded */
  ```
  Conditional format the result: red when `<0`, blue when `>0`.

- **Person conflict highlight** on `Shifts!G:G`:
  Custom formula (apply to the whole Assignments table):
  ```
  =COUNTIFS(
    $G:$G, $G2, $B:$B, $B2, $E:$E, "<="&$F2, $F:$F, ">="&$E2
  )>1
  ```

# 5) Why this is easier
- One source of truth for times (Events) and rules (Roles & Rules).
- Adding/changing a role (e.g., “Flex (4:30PM)”) is **one row** in Rules; all call times auto-update.
- Scheduling is just picking names from a filtered dropdown.
- Views are pivots—no manual merging/formatting each day.
- You get automatic over/under counts, overlap detection, and clean totals (hours × rate if you add a `Rate` column on Staff).

# 6) Quick usage flow
1) Enter the date/times on **Events**.  
2) Tweak **MinNeeded/MaxNeeded** on **Roles & Rules**.  
3) Go to **Shifts** → assign names via dropdown.  
4) Print the **Day View**.

If you want, I can draft a minimal template with the formulas wired up to your “Front Bar / Sections / Flex / Chef / Line Cook / Dishwasher / Porter-Expo / Install-Seat-Kitten / Door-Run-Spot” roles so you can drop it into your Drive.


## See Also
- [[chatgpt/chatgpt_automated-role-submission]]
- [[chatgpt/chatgpt_clerk-role-elements]]
- [[chatgpt/chatgpt_job-role-analysis]]
- [[chatgpt/chatgpt_resume-update-bartender-role]]
- [[chatgpt/chatgpt_role-submission-automation]]
