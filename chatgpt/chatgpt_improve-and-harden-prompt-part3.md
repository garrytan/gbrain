
make sure it also finds every instance of this and similar issues.

Another issue is that I have larger tables, especially in the admin section. They load and look fine for a second or two, and then more rows start loading, causing the table to shift around as different content appears. That’s a major one I want addressed.

Another issue is that some tables have individual columns for a score or status that’s just an icon or a badge. I think they would be better as a right-aligned icon column. For the pills, use linear-style pills that stack when there are a lot of them. If we right-align them, then even with varied-length pills, we can fill the white space in the center of the rows instead of pushing things around.

There’s a lot like that to handle. I need to look at every table, row, or card and ask: Is this the most efficient way to communicate what needs to be communicated here, or can we do something that’s a minor diff but yields a fundamental improvement in how the user views the data, making it more scannable and preventing layout shift? If something should be changed, we should probably do it.


Should I put all of these prompts in the same agent terminal, or in separate workspaces?



Mr. White, I’ll fold your table-specific concerns into the orchestration prompt as a first-class audit category, then answer the workspace setup question directly.


Mr. White, add this as a **table/list/card audit and scannability expansion** to the UI orchestration prompt. It directly covers the large-table loading shift, right-aligned score/status/icon columns, Linear-style pill stacking, and the requirement to find every instance across the app instead of fixing one-off examples. fileciteturn0file0

# Workspace recommendation

Use **separate workspaces / git worktrees**, with one lead terminal coordinating everything.

Best setup:

```text
Workspace 1: Hermes-UI-Orchestrator
- Owns backlog, dispatch, file locks, branch tracking, final prioritization.
- Paste the main orchestration prompt here, plus the addendum below.

Workspace 2: UI-PR-Monitor
- Separate terminal.
- Reviews every PR.
- Blocks design drift, scope creep, missing QA, and hidden functionality changes.

Workspace 3: UI-Visual-Sweep-Agent
- Mostly read-only.
- Continuously finds issues and produces execution briefs.

Workspace 4: Admin Tables / Large Data Surfaces
- Writer workspace.
- Owns admin tables, loading shift, pagination, skeletons, virtualization, row stability.

Workspace 5: Tables / Lists / Cards Scannability
- Writer workspace.
- Owns row/card layout, right-aligned icon/status columns, pills, badges, metadata alignment.

Workspace 6: Menus / Dropdowns / Sidebar Patterns
- Writer workspace.
- Owns menus, hover action visibility, nested menus, ellipsis behavior.

Workspace 7: Tokens / Components
- Writer workspace.
- Owns shared primitives, tokens, row components, table components.
- This one should be serialized carefully because it has high blast radius.
```

Do **not** paste every specialist prompt into the same agent terminal. Put the **main orchestrator prompt** in Aaron’s lead agent terminal, then have that agent dispatch specialist packets. For actual code-writing agents, use separate workspaces or git worktrees so file locks, branches, tests, and PRs stay clean.

Recommended branch/worktree pattern:

```text
../jovie-ui-orchestrator        ui/orchestration
../jovie-ui-admin-tables        ui/admin/stable-large-tables
../jovie-ui-table-scannability  ui/tables/scannability-pass
../jovie-ui-menus               ui/menus/normalization
../jovie-ui-tokens              ui/tokens/component-primitives
../jovie-ui-pr-monitor          read-only or review-only
```

# Add this to the main UI orchestrator prompt

Paste this into the existing prompt under the mission/backlog/table sections.

```text
GLOBAL TABLE / ROW / CARD AUDIT EXPANSION

This UI hardening mission must find every instance of table, row, list, card, badge, pill, status, score, metadata, and admin data-display issues across the app.

The goal is not to fix a single visible example. The goal is to identify the full pattern family, classify every instance, then ship small PRs that resolve the highest-impact instances and consolidate repeated patterns.

Every table, row, list, and card should be evaluated with this question:

Is this the most efficient, stable, and scannable way to communicate this data, or can a minor diff produce a fundamental improvement in how users scan the information while reducing layout shift?

If the answer is yes, create a small PR candidate unless the change would alter product semantics or require a broad redesign.

NEW PRIORITY CLASS: LARGE TABLE LAYOUT SHIFT

Large data tables, especially admin-section tables, are a top-priority UI hardening target.

Known symptom:
- table loads and looks correct for 1-2 seconds
- additional rows/content then load
- row count, row height, column width, badges, pills, icons, or metadata appear later
- the table shifts around after initial paint
- users lose visual position and scanning context

This must be treated as a major UX issue.

Inspect all admin and large-data surfaces for:
- delayed row loading that changes table geometry
- skeletons/placeholders that do not match final row dimensions
- content that appears after hydration and changes column widths
- client-side enrichment that changes row height
- badges/pills/statuses that load after text and push content
- icons that appear late and alter alignment
- pagination/infinite-scroll appends that shift existing rows
- virtualized lists with poor estimated row heights
- images/avatars/icons without reserved dimensions
- async metadata columns that render blank, then expand
- table-layout auto causing columns to resize after late content
- filters/search/sort controls changing table width or row wrapping
- admin tables using different row primitives from product tables

Acceptance standard:
- first stable paint should reserve the final table geometry as much as practical
- existing rows must not jump when more rows or metadata arrive
- column widths should remain stable after loading
- row heights should remain stable for equivalent content density
- skeleton rows should match final row height and basic column structure
- async status, score, badge, pill, icon, and action columns should reserve space
- infinite loading should append without shifting existing visible rows
- virtualization should use stable estimated row heights or measured row management
- loading, loaded, empty, and error states should share compatible layout structure

Preferred fixes:
- stable skeleton rows that match final row dimensions
- reserved icon/status/action column widths
- fixed or constrained column layout where appropriate
- explicit min/max widths for high-variance columns
- stable row-height rules
- stable pill wrapping rules
- stable action-menu reservation or consistent hover-only behavior with reserved space if needed
- defer visual enrichment into already-reserved cells
- move low-information score/status/badge columns into compact right-aligned visual columns
- normalize repeated table components behind shared row/table primitives
- preserve scroll position during appends where applicable

Invalid fixes:
- hiding important content with overflow clipping
- reducing data visibility without a deliberate responsive rule
- arbitrary magic-number patches with no system rationale
- page-specific hacks when a shared row/table primitive should be fixed
- changing data loading semantics when a layout reservation fix is sufficient
- broad table rewrites in one PR

SCANNABILITY AND DATA-DENSITY RULES

Every table/list/card should communicate hierarchy clearly.

Default row structure:
- primary object/title on the left
- supporting context near the primary object when it helps recognition
- quantitative score/status/icon-only signals in compact right-aligned columns
- actions at the far right
- badges/pills aligned predictably and wrapped intentionally
- metadata should form clean vertical scan lines
- repeated information should not jump horizontally between rows

Icon/status/score columns:
- if a column is only an icon, score indicator, status symbol, badge, or short visual signal, prefer a compact right-aligned column
- reserve a consistent width
- align icons/badges visually across rows
- do not let variable text columns push these indicators around
- tooltips or accessible labels should preserve meaning when icons are compact

Pill/badge layout:
- use Linear-style compact pills where appropriate
- pills should stack/wrap cleanly when there are many
- right-align pill groups when doing so improves scanning and uses whitespace efficiently
- varied-length pills should not push primary content or score/status/action columns around
- pill groups should have stable max-width behavior
- long pill labels should truncate or wrap according to a consistent rule
- important badges must never clip
- due/overdue/priority/status pills should appear in predictable positions across equivalent rows

Whitespace usage:
- avoid layouts where the center of the row is empty while the right side is cramped
- use available center whitespace for secondary metadata when it improves scanning
- preserve strong scan lines for repeated columns
- avoid compressing all metadata into one tight cluster when the row has unused space
- avoid row-by-row horizontal drift caused by variable title/date/badge lengths

Minor-diff improvement rule:
- if moving a badge/icon/status/pill into a stable right-aligned column materially improves scanability and does not change product semantics, propose it
- if wrapping/stacking pills creates a more stable row and does not hide information, propose it
- if a shared row/card/table primitive can fix multiple screens safely, prefer that over page-specific patches
- if the change risks broad visual blast radius, create a narrow pilot PR first

GLOBAL INSTANCE DISCOVERY REQUIREMENT

The first wave must create a complete inventory of table/list/card surfaces.

Create and maintain:

UI_TABLE_ROW_CARD_INVENTORY.md

For every table/list/card/data row surface, record:
- route/page
- section or component name
- admin vs product surface
- table/list/card/row type
- source files
- data loading behavior
- loading state type
- row height stability
- column width stability
- pill/badge behavior
- score/status/icon columns
- action-menu behavior
- empty state
- long-content behavior
- responsive behavior
- dark/light sensitivity
- severity
- recommended fix type
- shared primitive candidate
- PR candidate branch
- status: unfixed / queued / fixing / shipped / intentionally deferred

Every discovered issue must end in one of these states:
- shipped fix
- queued PR candidate
- intentionally deferred with reason
- marked acceptable with reason

No silent drop-off.

STATIC DISCOVERY METHODS

Use static searches to find all candidate surfaces.

Search for:
- table primitives
- data table components
- admin table components
- list rows
- cards
- badges
- pills
- status cells
- score columns
- priority badges
- due date badges
- action menus
- ellipsis actions
- skeleton rows
- loading rows
- virtualization
- pagination
- infinite scroll
- empty states

Search examples:
- `<table`
- `DataTable`
- `Table`
- `Column`
- `columns`
- `row`
- `Row`
- `Card`
- `Badge`
- `Pill`
- `Status`
- `Score`
- `Priority`
- `Due`
- `Overdue`
- `Skeleton`
- `loading`
- `isLoading`
- `isFetching`
- `fetchMore`
- `loadMore`
- `virtual`
- `pagination`
- `admin`
- `ellipsis`
- `ActionMenu`
- `DropdownMenu`

Then cross-check against route discovery and browser QA.

VISUAL DISCOVERY METHODS

Use browser QA to inspect representative data states:
- empty table
- loading table
- partially loaded table
- fully loaded table
- many rows
- one row
- long titles
- short titles
- many pills
- no pills
- icon-only status
- badge-only status
- score columns
- hover actions
- selected rows
- narrow viewport
- desktop viewport
- dark mode when relevant
- light mode when relevant

For admin tables specifically:
- load initial page
- wait 1 second
- wait 3 seconds
- observe whether row geometry changes
- sort/filter/search if available
- paginate or load more if available
- verify that existing visible rows do not shift unexpectedly

NEW WORKSTREAM: TABLE / ROW / CARD SCANNABILITY SQUAD

Create a dedicated squad for this.

Responsibilities:
- inventory every table/list/card/row surface
- find all large-table loading-shift issues
- identify repeated inefficient data-display patterns
- identify icon/status/score columns that should become compact right-aligned columns
- identify pill/badge groups that should stack/wrap using Linear-style compact pills
- identify repeated row/card metadata alignment problems
- identify shared row/table/card primitives that should be consolidated
- ship small PRs constantly
- maintain UI_TABLE_ROW_CARD_INVENTORY.md

This squad should work closely with:
- Layout Stability squad
- Design System / Tokens squad
- Release squad
- PR Monitor

TABLE / ROW / CARD BACKLOG PRIORITY

Within tables/lists/cards, rank work in this order:

1. large admin table layout shift after initial load
2. clipped important badges or hidden status information
3. existing rows shifting when async content arrives
4. unstable column widths caused by late-loading content
5. score/status/icon columns that waste space or reduce scanability
6. pill/badge groups that push rows around
7. metadata that jumps horizontally between equivalent rows
8. action menus that inconsistently show/hide or shift row width
9. inconsistent row height, radius, hover, selected, or focus state
10. empty/loading/error state mismatch
11. responsive table/list/card failures
12. dark/light table/list/card mismatches
13. low-risk polish after higher-impact issues are drained

TABLE / ROW / CARD QUALITY GATES

A table/list/card PR is ready only when:

- affected surface is listed in UI_TABLE_ROW_CARD_INVENTORY.md
- user-visible issue is explicit
- root cause is explicit
- fix is minimal
- existing functionality is preserved
- loading state is checked if the surface loads data
- row/column stability is checked if the surface has repeated rows
- long-content and short-content cases are checked
- many-row and one-row cases are checked when practical
- pill/badge behavior is checked if relevant
- icon/status/score alignment is checked if relevant
- hover action behavior is checked if relevant
- desktop viewport is checked
- narrow viewport is checked if layout-sensitive
- dark/light checked if theme-sensitive
- no important data is hidden or clipped
- no new one-off style pattern is introduced
- no unrelated cleanup is bundled
- before/after notes or screenshots exist when browser QA is available

FIRST TABLE/LIST/CARD WAVE REQUIRED

Before patching too broadly, produce:

1. Inventory of all admin tables
2. Inventory of all product tables
3. Inventory of all repeated list/card row components
4. List of surfaces with loading shift
5. List of surfaces with clipped badges/pills
6. List of score/status/icon-only columns
7. List of pill/badge groups that should become compact right-aligned stack/wrap groups
8. List of shared primitives that can fix multiple surfaces
9. First 3-5 smallest PR candidates
10. First large-table layout-shift PR candidate

Do not wait to complete the entire inventory before shipping obvious small fixes. Inventory and shipping should run in parallel with file ownership controls.
```

# Specialist prompt: Admin large-table layout shift agent

Use this as a separate writer workspace.

```text
You are UI-Admin-Table-Stability-Agent for the Jovie codebase.

Your job is to find and fix large-table layout shift, especially in the admin section.

MISSION

Large admin tables currently load and look fine for a second or two, then additional rows/content load and the table shifts around. This is a major UX issue.

Find every admin or large-data table with this behavior. Fix the highest-impact instances in small PRs.

SCOPE

Focus on:
- admin tables
- large product tables
- paginated tables
- infinite-scroll tables
- virtualized lists
- skeleton/loading table states
- rows with async metadata
- rows with late-loading badges, pills, icons, scores, statuses, avatars, or actions

Out of scope:
- changing table business logic
- changing admin permissions
- changing data models
- adding new features
- broad redesigns
- unrelated cleanup

DISCOVERY

Build an inventory of admin and large-data tables.

For each table, record:
- route
- component files
- data source/loading behavior
- initial loading state
- whether rows load in waves
- whether columns resize after load
- whether row height changes after load
- whether badges/pills/icons appear late
- whether skeleton geometry matches final geometry
- severity
- proposed small fix

REPROTOCOL

For each candidate table:

1. Load the page.
2. Observe first paint.
3. Observe after 1 second.
4. Observe after 3 seconds.
5. Observe after all data loads.
6. Check whether existing visible rows move.
7. Check whether columns change width.
8. Check whether row heights change.
9. Check whether scroll position or viewport context is disrupted.
10. Capture before/after notes or screenshots if available.

LIKELY ROOT CAUSES

Investigate:
- skeleton rows that do not match final rows
- blank async cells that later expand
- table-layout auto with high-variance content
- icons/images without reserved dimensions
- badges/pills rendered after text
- row actions appearing late and changing width
- virtualization estimated row height mismatch
- pagination/load-more append behavior
- hydration/client-side enrichment differences
- conditional columns
- late admin-only metadata
- CSS min-width/max-width gaps

PREFERRED FIXES

Use small, targeted fixes:
- reserve cell widths for async icon/status/action columns
- make skeleton rows match final row geometry
- constrain high-variance columns
- stabilize row height where appropriate
- reserve avatar/icon dimensions
- render placeholders with final dimensions
- prevent late-loading badges/pills from changing row geometry
- use compact right-aligned status/icon columns where appropriate
- preserve existing row positions during incremental loads
- normalize through shared table primitives when safe

ACCEPTANCE

A fix is accepted only when:
- the table no longer visibly shifts after initial load
- existing visible rows remain stable as more content loads
- columns remain stable after async metadata appears
- skeleton/loading state matches final geometry closely
- empty, loading, loaded, and many-row states are checked
- functionality is unchanged
- PR is small and scoped

VERIFY

Run relevant lint/typecheck/tests.

Browser QA:
- initial load
- wait 1 second
- wait 3 seconds
- fully loaded
- sort/filter/search if available
- pagination/load more if available
- hover row/actions
- desktop viewport
- narrow viewport if table is responsive
- light/dark if theme-sensitive

OUTPUT

SUMMARY:
INVENTORY UPDATED:
SURFACE:
REPRO:
ROOT CAUSE:
FILES TOUCHED:
FIX:
BEFORE/AFTER:
QA MATRIX:
TESTS:
RISKS:
FOLLOW-UPS:
BRANCH/PR:
```

# Specialist prompt: Table/list/card scannability agent

Use this as a separate writer workspace.

```text
You are UI-Table-List-Card-Scannability-Agent for the Jovie codebase.

Your job is to make every table, list, row, and card more scannable, stable, and efficient with small diffs.

MISSION

Inspect every table/list/card/row surface and ask:

Is this the most efficient way to communicate the data, or can a minor layout/component change make it fundamentally easier to scan while preventing layout shift?

Find every instance where:
- score/status/icon-only columns should become compact right-aligned columns
- pills/badges should use compact Linear-style pills
- pill groups should stack/wrap cleanly
- right-aligned metadata would improve scanning
- varied-length pills are pushing content around
- important badges are clipped
- metadata jumps between rows
- row actions shift layout
- right side is cramped while center space is unused
- cards/lists waste space or obscure hierarchy
- row/card layout differs unnecessarily from equivalent surfaces

SCOPE

Focus on:
- product tables
- admin tables
- task lists/cards
- release lists/cards
- entity lists
- search results
- status/score columns
- badge/pill groups
- metadata rows
- action columns
- hover rows
- selected rows
- shared row/card/table primitives

Out of scope:
- changing data semantics
- changing sorting/filtering logic
- adding new product functionality
- hiding important data
- broad redesigns
- unrelated cleanup

SCANNABILITY TARGETS

Preferred row structure:
- primary title/content on the left
- supporting text close to the title when it helps recognition
- repeated metadata in stable scan lines
- score/status/icon-only signals in compact right-aligned columns
- action menu far right
- pills/badges right-aligned or grouped when that improves scanning
- long pill groups stack/wrap intentionally
- row height stays predictable
- no clipped badges
- no metadata jumping between rows

RIGHT-ALIGNED ICON / STATUS / SCORE COLUMNS

For columns that are mostly icon, status, score, or badge:
- prefer compact right-aligned visual columns
- reserve stable width
- align across rows
- include accessible labels/tooltips where needed
- avoid allowing variable text to push these signals around
- keep the action menu distinct from score/status columns

LINEAR-STYLE PILLS

For pill-heavy rows:
- use compact pills
- stack/wrap when there are many
- preserve readable spacing
- avoid pushing primary content around
- avoid clipping
- truncate or wrap long labels according to the system rule
- use a stable max-width when needed
- right-align the group when it improves scanability and uses row whitespace better

DISCOVERY

Create/update UI_TABLE_ROW_CARD_INVENTORY.md.

For every candidate surface, record:
- route
- component
- issue
- severity
- proposed change
- whether this can be a small PR
- shared primitive opportunity
- status

WORKFLOW

1. Inventory candidate surfaces.
2. Choose one high-impact, small-diff surface.
3. Capture representative examples:
   - long title
   - short title
   - many pills
   - no pills
   - status/score present
   - status/score missing
   - action menu
   - hover state
4. Identify current layout rule.
5. Identify improved layout rule.
6. Patch minimally.
7. Verify representative cases.
8. Ship small PR.
9. Queue related surfaces as follow-ups.

ACCEPTANCE

A PR is accepted only when:
- scanning is materially improved
- row/card geometry is more stable
- no core behavior changes
- important data remains visible
- pills/badges do not clip
- repeated metadata aligns predictably
- right-aligned columns use stable width
- long/short content cases are checked
- many/few pill cases are checked
- hover/action behavior is preserved
- diff is small

VERIFY

Run relevant lint/typecheck/tests.

Browser QA:
- many rows/cards
- one row/card
- long title
- short title
- many pills
- no pills
- score/status present
- score/status missing
- hover action
- selected/highlighted state if relevant
- desktop viewport
- narrow viewport if relevant
- dark/light if theme-sensitive

OUTPUT

SUMMARY:
SURFACE:
CURRENT PROBLEM:
WHY THE NEW LAYOUT IS BETTER:
ROOT CAUSE:
FILES TOUCHED:
FIX:
BEFORE/AFTER:
QA MATRIX:
TESTS:
RISKS:
FOLLOW-UPS:
BRANCH/PR:
```

# Specialist prompt: global table/list/card inventory agent

Use this as a read-only or mostly read-only agent. It should feed the orchestrator.

```text
You are UI-Table-Inventory-Agent for the Jovie codebase.

Your job is to find every table, row, list, card, badge, pill, score/status column, and large-data surface that may need UI hardening.

You are primarily read-only. Do not patch unless explicitly granted write access.

MISSION

Create a full inventory so the UI hardening program does not fix one example while missing the rest of the product.

DISCOVERY TARGETS

Find:
- all admin tables
- all product tables
- all repeated list rows
- all repeated card rows
- all task cards/rows
- all release cards/rows
- all entity list rows
- all search result rows
- all score/status/icon-only columns
- all badge/pill-heavy rows
- all table/list/card loading states
- all skeleton table rows
- all virtualized or paginated views
- all infinite-scroll views
- all row action menus
- all hover-only action surfaces
- all empty states

STATIC SEARCHES

Search for:
- `<table`
- `DataTable`
- `Table`
- `columns`
- `Column`
- `row`
- `Row`
- `Card`
- `Badge`
- `Pill`
- `Status`
- `Score`
- `Priority`
- `Due`
- `Overdue`
- `Skeleton`
- `loading`
- `isLoading`
- `isFetching`
- `fetchMore`
- `loadMore`
- `virtual`
- `pagination`
- `admin`
- `ActionMenu`
- `DropdownMenu`
- `ellipsis`

VISUAL CHECKS

For each high-priority surface, inspect:
- initial loading state
- loaded state
- many rows
- one row
- empty state
- long text
- short text
- many pills
- no pills
- status/score/icon columns
- hover actions
- selected state
- desktop
- narrow viewport if relevant
- dark/light if relevant

CLASSIFICATION

Classify each surface:

A. Large-table layout shift
B. Clipped badge/pill
C. Metadata alignment drift
D. Inefficient score/status/icon column
E. Pill group should stack/wrap
F. Action menu visibility inconsistency
G. Loading/skeleton geometry mismatch
H. Responsive failure
I. Dark/light mismatch
J. Acceptable / no action

OUTPUT FILE

Create or update:

UI_TABLE_ROW_CARD_INVENTORY.md

Format:

SURFACE:
ROUTE:
COMPONENT/FILES:
TYPE:
ADMIN/PRODUCT:
ISSUE CLASS:
SEVERITY:
EVIDENCE:
LOADING BEHAVIOR:
CURRENT LAYOUT:
RECOMMENDED CHANGE:
SHARED PRIMITIVE OPPORTUNITY:
SUGGESTED PR SIZE:
RISK:
STATUS:
FOLLOW-UP:

FINAL OUTPUT

Return:
1. Total surfaces found
2. Admin table list
3. Product table list
4. Top 10 layout-shift risks
5. Top 10 scannability wins
6. Top 10 shared primitive opportunities
7. First 5 recommended small PRs
```

# Add these first-wave dispatch packets

Give these to child agents immediately.

## 1. Admin table loading shift inventory and first fix

```text
TASK:
Find all admin tables with post-load layout shift and fix the highest-impact small instance.

WHY NOW:
Admin tables are large data surfaces. They currently appear stable for 1-2 seconds, then additional rows/content load and cause the table to shift. This is a major UX defect.

SCOPE:
Admin table routes, table components, loading/skeleton states, async metadata cells, pagination/load-more behavior, row geometry.
Out of scope: admin permissions, backend data semantics, table feature additions, broad redesign.

CONTEXT:
Start by inventorying all admin tables. For each, load the page, observe first paint, wait 1 second, wait 3 seconds, and observe final loaded state. Find where existing rows, columns, badges, pills, icons, or actions shift.

SKILL CHAIN:
/investigate -> patch -> /qa -> /review -> /ship

ACCEPTANCE:
One high-impact admin table no longer shifts after initial load.
Rows and columns reserve stable geometry.
Skeleton/loading state matches final geometry closely.
No admin functionality changes.

VERIFY:
Browser QA:
- initial load
- wait 1 second
- wait 3 seconds
- fully loaded
- sort/filter/search if available
- pagination/load more if available
- hover actions
Run relevant lint/typecheck/tests.

STOP CONDITIONS:
Stop if the fix requires changing backend data loading behavior or admin semantics.

OUTPUT:
summary, admin table inventory update, evidence, root cause, files touched, before/after verification, risks, follow-ups, branch/PR.
```

## 2. Right-aligned icon/status/score columns pilot

```text
TASK:
Convert one inefficient score/status/icon-only table/list column into a compact right-aligned visual column.

WHY NOW:
Some tables use individual columns for scores or statuses that are only icons or badges. These create poor scan lines and waste horizontal space. Right-aligned compact visual columns can improve scanning and reduce layout pressure.

SCOPE:
One table/list/card surface or one narrow shared primitive.
Out of scope: changing status/score meaning, sorting/filtering semantics, backend data, or adding features.

CONTEXT:
Find a surface where score/status/icon-only data pushes row content around or creates inefficient whitespace. Preserve meaning with accessible labels/tooltips if needed.

SKILL CHAIN:
/frontend-design -> /investigate -> patch -> /qa -> /review -> /ship

ACCEPTANCE:
Score/status/icon signal is right-aligned in a stable compact column.
Primary content has more stable usable space.
Rows scan more cleanly.
No data semantics change.
No important information hidden.

VERIFY:
Browser QA:
- many rows
- long titles
- short titles
- score/status present
- score/status missing
- hover actions
- desktop
- narrow viewport if relevant
Run relevant lint/typecheck/tests.

STOP CONDITIONS:
Stop if the column has hidden sorting/filtering/product semantics that would be affected by the visual change.

OUTPUT:
summary, surface, current problem, root cause, fix, files touched, before/after, verification, risks, follow-ups, branch/PR.
```

## 3. Linear-style pill stacking pilot

```text
TASK:
Normalize one pill-heavy row/card/table surface so pills use compact Linear-style pills that wrap/stack cleanly and do not push content around.

WHY NOW:
Varied-length pills currently push row content around and waste row space. Compact stacked/wrapped pills can fill available whitespace while preserving scan lines.

SCOPE:
One pill-heavy row/card/table surface or one narrow shared pill group primitive.
Out of scope: changing pill meaning, filtering behavior, status semantics, or broad redesign.

CONTEXT:
Find a surface with many pills, varied-length pills, clipped pills, or rows where pills compress metadata/actions. Prefer right-aligned or constrained pill groups when that improves scanning.

SKILL CHAIN:
/frontend-design -> /investigate -> patch -> /qa -> /review -> /ship

ACCEPTANCE:
Pills are compact.
Pills wrap/stack intentionally when numerous.
Pills do not clip.
Pills do not push primary content, status columns, or action columns around.
Long and short pill labels are handled consistently.
No functionality changes.

VERIFY:
Browser QA:
- many pills
- one pill
- no pills
- long pill labels
- short pill labels
- long row title
- short row title
- hover action
- desktop
- narrow viewport if relevant
- dark/light if theme-sensitive
Run relevant lint/typecheck/tests.

STOP CONDITIONS:
Stop if the change would alter filtering/status semantics or hide important information.

OUTPUT:
summary, surface, current problem, root cause, fix, files touched, before/after, verification, risks, follow-ups, branch/PR.
```

## 4. Complete table/list/card inventory

```text
TASK:
Create a complete inventory of every table, list, row, card, badge, pill, score/status column, loading state, and large-data surface.

WHY NOW:
The UI has repeated data-display issues. The hardening program must find every instance and fix pattern families instead of isolated examples.

SCOPE:
Read-only discovery across the full app.
Out of scope: code edits unless explicitly granted.

CONTEXT:
Search statically and inspect routes visually where possible. Prioritize admin tables, large product tables, task lists/cards, release lists/cards, entity lists, search results, and shared row/card/table primitives.

SKILL CHAIN:
/qa-only -> static search -> inventory -> prioritized PR candidates

ACCEPTANCE:
UI_TABLE_ROW_CARD_INVENTORY.md exists and includes all discovered surfaces with classification, severity, likely files, recommended fix, and status.
Top small PR candidates are ranked.

VERIFY:
Cross-check static search results against route tree and browser-visible surfaces.

STOP CONDITIONS:
Stop if repo access or browser access is unavailable; report the limitation and produce the best static inventory possible.

OUTPUT:
total surfaces found, inventory file, admin table list, product table list, top 10 layout-shift risks, top 10 scannability wins, top 10 shared primitive opportunities, first 5 recommended PRs.
```

# How I’d sequence it

Run this order:

```text
1. Main orchestrator starts and owns locks.
2. Inventory agent maps all table/list/card surfaces.
3. Admin table agent starts fixing the worst loading-shift issue immediately.
4. Scannability agent starts one right-aligned score/status/icon pilot.
5. Pill agent starts one compact stacked-pill pilot.
6. PR monitor reviews every PR.
7. Token/component agent only touches shared primitives after the first pilots prove the pattern.
```

The safest first PRs are usually:

```text
PR 1: Admin table skeleton/row geometry stabilization
PR 2: One right-aligned status/icon column pilot
PR 3: One compact pill-group wrapping pilot
PR 4: One clipped badge fix in task/release rows
PR 5: Shared row/action-column primitive after pilots validate the pattern
```

Use the same **orchestrator prompt + addendum** in the lead terminal. Use the specialist prompts in separate workspaces or have the orchestrator dispatch them as child-agent packets.


All right, I have the orchestrator agent running, and it’s executing the prompts you sent me, but I haven’t split up the other agents yet. This is the Arameez agent, and it can spin up its own sub-agents with limited context so they can focus on a specific coding task. You can specify that they launch in coding mode, and then we can have those sub-agents request Claude code specifically so we maximize Claude code usage rather than burning through the Arameez APIs.

I want you to give me one prompt now that instructs the Arameez orchestrator agent that’s running to create those sub-agents and give each one of them those prompts. It will give each sub-agent just that prompt so they don’t have the context of the other prompts.

to be clear i mean hermes agent. the text speach stuff keeps messing that up and calling it aaron or arameez


Mr. White, paste this into the already-running Hermes orchestrator as a dispatcher addendum. It creates isolated coding sub-agents and directs them to request Claude Code where appropriate.


**Topic:** [[chatgpt-clusters/code_review]]


## See Also
- [[chatgpt/chatgpt_improve-and-harden-prompt-part1]]
- [[chatgpt/chatgpt_improve-and-harden-prompt-part2]]
- [[chatgpt/chatgpt_improve-and-harden-prompt-part4]]
- [[chatgpt/chatgpt_improve-prompt-request]]
- [[chatgpt/chatgpt_audit-and-harden-prompt]]
