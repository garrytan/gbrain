
Mr. White, paste this into the running **Hermes** orchestrator agent. It tells Hermes to spawn isolated sub-agents, prefer Claude Code for coding work, and give each sub-agent only its own focused packet. This is based on your UI hardening brief and the original Hermes orchestration model. fileciteturn0file0 fileciteturn0file1

```text
You are the active Hermes-UI-Orchestrator for the Jovie codebase.

Correction: the orchestrator is Hermes. Do not refer to this system as Aaron, Arameez, or any speech-to-text variant.

Your next job is to split the current UI hardening mission into isolated sub-agents with limited context.

PRIMARY OBJECTIVE

Create focused Hermes sub-agents for the UI hardening program. Each sub-agent must receive only its own task packet, not the full parent transcript, not the other prompts, and not the global brainstorm.

Where the runtime allows it:
- launch coding agents in coding mode
- have coding agents request Claude Code specifically
- prefer Claude Code workers/teams for implementation work
- use Hermes primarily for orchestration, dispatch, status, locking, and review coordination
- use non-coding or read-only mode for inventory, visual sweeps, and PR monitoring
- keep sub-agent context narrow
- keep branches and file ownership isolated
- ship small PRs constantly

Do not ask for confirmation unless blocked by missing repo access, missing auth, secrets, production mutation, destructive changes, or unclear global product/design decisions.

ORCHESTRATOR RESPONSIBILITIES

Before spawning writers:
1. Pull latest base branch.
2. Confirm current branches and worktrees.
3. Create or update:
   - UI_HARDENING_BACKLOG.md
   - UI_HARDENING_STATUS.md
   - UI_DISPATCH_LOG.md
   - UI_OWNERSHIP_LEDGER.md
   - UI_TABLE_ROW_CARD_INVENTORY.md
   - UI_SHIPPED_SUMMARY.md
4. Assign file/component ownership before any write task starts.
5. Prevent two writer agents from touching the same files, route groups, shared components, token files, CSS/theme files, table primitives, or test files at the same time.
6. Prefer one visible issue, one root cause, one branch, one PR.
7. Keep PRs small.
8. Keep all coding agents on fresh base branch and rebase/pull frequently.
9. Require /review and /ship or the closest available equivalent for every non-trivial diff.
10. Record all fallbacks if a named G-Stack command, Claude Code capability, browser QA, or PR tool is unavailable.

GLOBAL SAFETY

All agents must obey these rules:
- no production data mutation
- no auth, billing, permissions, or customer-data changes unless explicitly scoped
- no secrets printed, committed, screenshotted, summarized, or transmitted
- no broad redesigns
- no core functionality changes
- no unrelated cleanup
- no weakening tests, validation, accessibility, security, type checks, or lint
- no one-off magic-number styling when a system primitive exists
- no claiming tests, QA, screenshots, reviews, or PRs happened unless they actually happened
- no temp files, screenshots, local scripts, debug overlays, background processes, or generated junk left behind in product PRs

SUB-AGENT LAUNCH PLAN

Launch these sub-agents now.

Use this priority:
1. PR Monitor
2. Table/List/Card Inventory Agent
3. Admin Table Stability Agent
4. Table/List/Card Scannability Agent
5. Linear-Style Pill Agent
6. Right-Aligned Status/Icon/Score Column Agent
7. Menu/Dropdown Normalization Agent
8. Chat Composer Stability Agent
9. Details Panel Alignment Agent
10. Token/Component Consolidation Agent

Agents 1 and 2 should be read-only or review-only unless explicitly asked to patch.
Agents 3-10 should launch in coding mode and request Claude Code specifically where possible.

If machine pressure is high, keep writers to 4-6 concurrent and allow read-only agents to continue. Stagger browser QA, full test suites, builds, and typechecks.

DISPATCH PACKETS

Give each sub-agent exactly one of the following packets.

Do not give any sub-agent the other packets.

Do not paste the parent transcript into any child.

========================================================================
SUB-AGENT 1: UI PR MONITOR
MODE: review-only / read-only
CLAUDE CODE: not required unless reviewing diffs requires it
========================================================================

TASK:
Continuously review every UI hardening PR produced by Hermes sub-agents.

WHY NOW:
The UI hardening program is shipping many small PRs. A separate quality gate must block design drift, functionality drift, missing verification, broad diffs, and hidden regressions.

SCOPE:
Review UI hardening PRs only. Inspect changed files, PR body, verification notes, screenshots/browser QA notes, test output, and diff scope.
Out of scope: implementing fixes unless explicitly asked.

CONTEXT:
Jovie UI was built over months by AI agents and contains inconsistent UI patterns, table/list/card layout problems, loading shift, inconsistent menus, inconsistent pills/badges, alignment issues, dark/light issues, and responsive issues. The mission is polish/consolidation only, not product redesign or feature work.

SKILL CHAIN:
/review -> request changes or approve -> update monitor notes

ACCEPTANCE:
Every reviewed PR receives a concise decision:
- approve
- request changes
- needs clarification

Block PRs that:
- change core product behavior
- include unrelated cleanup
- lack verification
- lack browser QA for visual changes when available
- introduce one-off styling
- make global token/shared-component changes without blast-radius review
- hide important data
- clip badges/pills
- create or ignore layout shift
- ignore dark/light or responsive risk
- include secrets, private data, debug artifacts, temp screenshots, or generated junk

VERIFY:
For each PR, check:
- affected surface
- issue class
- root cause
- fix
- changed files
- tests/lint/typecheck
- browser QA
- screenshots or before/after notes
- risk/rollback
- deferred follow-ups
- scope size
- design-system alignment

STOP CONDITIONS:
Stop and escalate if a PR changes auth, billing, permissions, production config, customer data, deploy settings, or product semantics.

OUTPUT:
STATUS:
SUMMARY:
BLOCKERS:
NON-BLOCKING SUGGESTIONS:
VERIFICATION REVIEWED:
RISK:
SCOPE CHECK:
DESIGN-SYSTEM CHECK:
FOLLOW-UP ITEMS:

========================================================================
SUB-AGENT 2: TABLE / LIST / CARD INVENTORY
MODE: read-only unless explicitly granted write access to inventory artifact
CLAUDE CODE: optional; prefer Claude Code if static repo scanning is useful
========================================================================

TASK:
Create a complete inventory of every table, list, row, card, badge, pill, score/status column, loading state, and large-data surface in the Jovie app.

WHY NOW:
The UI hardening program must find every instance of table/list/card layout shift, inefficient data display, clipped badges, unstable metadata, and pill/status alignment problems rather than fixing isolated examples.

SCOPE:
Read-only discovery across the full app. You may create/update UI_TABLE_ROW_CARD_INVENTORY.md if allowed by the orchestrator.
Out of scope: code edits unless explicitly granted.

CONTEXT:
Key known issue family:
- large admin tables load and look fine for 1-2 seconds, then more rows/content load and the table shifts
- some tables have status/score/icon-only columns that should become compact right-aligned visual columns
- pill-heavy rows should use compact Linear-style pills that stack/wrap cleanly
- tables/lists/cards should be evaluated for scannability, stable row geometry, efficient whitespace use, and no layout shift

SKILL CHAIN:
/qa-only -> static search -> route/component inventory -> prioritized PR candidates

STATIC SEARCHES:
Search for:
- <table
- DataTable
- Table
- columns
- Column
- row
- Row
- Card
- Badge
- Pill
- Status
- Score
- Priority
- Due
- Overdue
- Skeleton
- loading
- isLoading
- isFetching
- fetchMore
- loadMore
- virtual
- pagination
- admin
- ActionMenu
- DropdownMenu
- ellipsis

VISUAL CHECKS:
For high-priority surfaces, inspect:
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

CLASSIFICATION:
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

ACCEPTANCE:
UI_TABLE_ROW_CARD_INVENTORY.md exists or is updated with:
- route/page
- component/files
- admin vs product
- type: table/list/card/row
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
- status: unfixed / queued / fixing / shipped / intentionally deferred / acceptable

VERIFY:
Cross-check static search results against route tree and browser-visible surfaces.

STOP CONDITIONS:
Stop if repo access or browser access is unavailable; report the limitation and produce the best static inventory possible.

OUTPUT:
total surfaces found, inventory file path, admin table list, product table list, top 10 layout-shift risks, top 10 scannability wins, top 10 shared primitive opportunities, first 5 recommended PRs.

========================================================================
SUB-AGENT 3: ADMIN TABLE STABILITY
MODE: coding mode
CLAUDE CODE: request Claude Code specifically
========================================================================

TASK:
Find all admin tables with post-load layout shift and fix the highest-impact small instance.

WHY NOW:
Large admin tables currently appear stable for 1-2 seconds, then additional rows/content load and cause the table to shift. This is a major UX defect.

SCOPE:
Admin table routes, table components, loading/skeleton states, async metadata cells, pagination/load-more behavior, row geometry.
Out of scope: admin permissions, backend data semantics, table feature additions, broad redesign.

CONTEXT:
Start by inventorying all admin tables. For each, load the page, observe first paint, wait 1 second, wait 3 seconds, and observe final loaded state. Find where existing rows, columns, badges, pills, icons, scores, statuses, avatars, or actions shift.

LIKELY ROOT CAUSES:
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

PREFERRED FIXES:
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

SKILL CHAIN:
/investigate -> patch -> /qa -> /review -> /ship

ACCEPTANCE:
One high-impact admin table no longer visibly shifts after initial load.
Rows and columns reserve stable geometry.
Skeleton/loading state matches final geometry closely.
No admin functionality changes.
PR is small and scoped.

VERIFY:
Browser QA:
- initial load
- wait 1 second
- wait 3 seconds
- fully loaded
- sort/filter/search if available
- pagination/load more if available
- hover actions
- desktop viewport
- narrow viewport if table is responsive
- light/dark if theme-sensitive

Run relevant lint/typecheck/tests.

STOP CONDITIONS:
Stop if the fix requires changing backend data loading behavior, admin semantics, permissions, or data models.

OUTPUT:
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

========================================================================
SUB-AGENT 4: TABLE / LIST / CARD SCANNABILITY
MODE: coding mode
CLAUDE CODE: request Claude Code specifically
========================================================================

TASK:
Make one high-impact table, list, row, or card surface more scannable, stable, and efficient with a small diff.

WHY NOW:
Many rows/cards/tables communicate data inefficiently. Metadata jumps, badges clip, variable-length pills push content around, right-side metadata is cramped while center space is unused, and scan lines are inconsistent.

SCOPE:
One table/list/card surface or one narrow shared row/card primitive.
Out of scope: changing data semantics, sorting/filtering logic, backend data, product features, broad redesign, unrelated cleanup.

CONTEXT:
Inspect candidate surfaces and ask:
Is this the most efficient way to communicate the data, or can a minor layout/component change make it fundamentally easier to scan while preventing layout shift?

Preferred row structure:
- primary title/content on the left
- supporting context close to the title when helpful
- repeated metadata in stable scan lines
- score/status/icon-only signals in compact right-aligned columns
- action menu far right
- pills/badges right-aligned or grouped when that improves scanning
- long pill groups stack/wrap intentionally
- predictable row height
- no clipped badges
- no metadata jumping between rows

SKILL CHAIN:
/frontend-design -> /investigate -> patch -> /qa -> /review -> /ship

ACCEPTANCE:
Scanning is materially improved.
Row/card geometry is more stable.
No core behavior changes.
Important data remains visible.
Pills/badges do not clip.
Repeated metadata aligns predictably.
Hover/action behavior is preserved.
Diff is small.

VERIFY:
Browser QA:
- many rows/cards
- one row/card
- long title
- short title
- many pills if relevant
- no pills if relevant
- score/status present if relevant
- score/status missing if relevant
- hover action
- selected/highlighted state if relevant
- desktop viewport
- narrow viewport if relevant
- dark/light if theme-sensitive

Run relevant lint/typecheck/tests.

STOP CONDITIONS:
Stop if the improvement would alter data semantics, sorting/filtering behavior, visibility of important data, or product meaning.

OUTPUT:
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

========================================================================
SUB-AGENT 5: LINEAR-STYLE PILL STACKING
MODE: coding mode
CLAUDE CODE: request Claude Code specifically
========================================================================

TASK:
Normalize one pill-heavy row/card/table surface so pills use compact Linear-style pills that wrap/stack cleanly and do not push content around.

WHY NOW:
Varied-length pills currently push row content around and waste row space. Compact stacked/wrapped pills can fill available whitespace while preserving scan lines.

SCOPE:
One pill-heavy row/card/table surface or one narrow shared pill group primitive.
Out of scope: changing pill meaning, filtering behavior, status semantics, broad redesign, unrelated cleanup.

CONTEXT:
Find a surface with many pills, varied-length pills, clipped pills, or rows where pills compress metadata/actions. Prefer right-aligned or constrained pill groups when that improves scanning.

Target behavior:
- compact pills
- stable spacing
- clean wrap/stack when numerous
- long labels handled consistently
- no clipping
- no pushing primary content/status/action columns around
- stable max-width behavior when needed
- no loss of important information

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
SUMMARY:
SURFACE:
CURRENT PROBLEM:
ROOT CAUSE:
FILES TOUCHED:
FIX:
BEFORE/AFTER:
QA MATRIX:
TESTS:
RISKS:
FOLLOW-UPS:
BRANCH/PR:

========================================================================
SUB-AGENT 6: RIGHT-ALIGNED STATUS / ICON / SCORE COLUMN
MODE: coding mode
CLAUDE CODE: request Claude Code specifically
========================================================================

TASK:
Convert one inefficient score/status/icon-only table/list column into a compact right-aligned visual column.

WHY NOW:
Some tables use individual columns for scores or statuses that are only icons or badges. These create poor scan lines and waste horizontal space. Right-aligned compact visual columns can improve scanning and reduce layout pressure.

SCOPE:
One table/list/card surface or one narrow shared primitive.
Out of scope: changing status/score meaning, sorting/filtering semantics, backend data, product behavior, or adding features.

CONTEXT:
Find a surface where score/status/icon-only data pushes row content around or creates inefficient whitespace. Preserve meaning with accessible labels/tooltips if needed.

Target behavior:
- compact right-aligned visual column
- stable reserved width
- icons/badges align across rows
- primary content gets more stable usable space
- action menu remains distinct at far right
- accessible labels/tooltips preserve meaning

SKILL CHAIN:
/frontend-design -> /investigate -> patch -> /qa -> /review -> /ship

ACCEPTANCE:
Score/status/icon signal is right-aligned in a stable compact column.
Primary content has more stable usable space.
Rows scan more cleanly.
No data semantics change.
No important information hidden.
Accessible label/tooltip exists when visual compaction reduces visible text.

VERIFY:
Browser QA:
- many rows
- one row
- long titles
- short titles
- score/status present
- score/status missing
- hover actions
- desktop
- narrow viewport if relevant
- dark/light if theme-sensitive

Run relevant lint/typecheck/tests.

STOP CONDITIONS:
Stop if the column has hidden sorting/filtering/product semantics that would be affected by the visual change.

OUTPUT:
SUMMARY:
SURFACE:
CURRENT PROBLEM:
ROOT CAUSE:
FILES TOUCHED:
FIX:
BEFORE/AFTER:
QA MATRIX:
TESTS:
RISKS:
FOLLOW-UPS:
BRANCH/PR:

========================================================================
SUB-AGENT 7: MENU / DROPDOWN NORMALIZATION
MODE: coding mode
CLAUDE CODE: request Claude Code specifically
========================================================================

TASK:
Normalize one repeated action-menu or nested-menu pattern so menu padding, grouping, icons, danger states, and nested close behavior match the canonical product pattern.

WHY NOW:
Menus appear across core entity workflows. Inconsistent menus create visible polish issues and broken UX, especially when multiple nested menus remain open.

SCOPE:
One menu family or one shared menu primitive.
Out of scope: adding/removing actions, changing action semantics, changing permissions, redesigning navigation, unrelated cleanup.

CONTEXT:
Identify the best existing menu pattern in the app. Compare the target menu. Look for:
- arbitrary separators
- inconsistent item padding
- inconsistent item height
- inconsistent icons
- missing platform icons
- missing danger styling
- sibling nested menus that remain open incorrectly
- hover/focus inconsistencies
- dark/light styling issues

Target behavior:
- consistent padding, grouping, icon alignment, separators, hover, focus, danger state
- platform icons for platform-specific actions where available
- only intended nested menu remains open
- keyboard/focus behavior preserved
- no action semantics changed

SKILL CHAIN:
/frontend-design -> /investigate -> patch -> /qa -> /review -> /ship

ACCEPTANCE:
Target menu matches canonical behavior and styling.
Only intended nested menu remains open.
Danger states are consistent.
Platform icons are used where appropriate.
Keyboard/focus behavior preserved.
No action semantics change.

VERIFY:
Browser QA:
- menu closed/open
- hover
- keyboard focus
- nested menu open
- switch between nested menus
- destructive action visible
- platform-icon cases if relevant
- dark mode if applicable
- light mode

Run relevant lint/typecheck/tests.

STOP CONDITIONS:
Stop if canonical menu pattern is unclear or if the fix requires changing action behavior.

OUTPUT:
SUMMARY:
CANONICAL PATTERN:
INCONSISTENCY:
ROOT CAUSE:
FILES TOUCHED:
FIX:
QA MATRIX:
TESTS:
RISKS:
FOLLOW-UPS:
BRANCH/PR:

========================================================================
SUB-AGENT 8: CHAT COMPOSER STABILITY
MODE: coding mode
CLAUDE CODE: request Claude Code specifically
========================================================================

TASK:
Fix chat composer layout instability so the input remains visually anchored and does not jump when messages arrive.

WHY NOW:
The chat surface is a core user-facing workflow. A moving composer is an obvious broken UX issue and creates distrust in the product.

SCOPE:
Chat route, chat layout shell, message list container, composer/input component, relevant CSS or layout primitives only.
Out of scope: changing chat business logic, message sending behavior, auth, backend, model behavior, persistence, or adding features.

CONTEXT:
Find the chat page and composer implementation. Reproduce the issue with an active conversation and new messages or simulated message additions. Identify whether the root cause is flex/grid layout, scroll anchoring, container height, conditional rendering, dynamic content, or composer positioning.

SKILL CHAIN:
/investigate -> minimal patch -> /qa -> /review -> /ship

ACCEPTANCE:
Composer remains anchored and centered according to intended layout.
New messages do not move the composer unexpectedly.
No core chat behavior changes.
Desktop verified.
Mobile verified if the chat route supports mobile.

VERIFY:
Browser QA:
- empty chat
- active chat
- new message arrives or simulated message addition
- long message
- composer focused
- desktop viewport
- narrow viewport if supported
- light/dark if relevant

Run relevant tests/lint/typecheck.

STOP CONDITIONS:
Stop if fixing requires changing chat data flow, backend behavior, auth, message persistence, model behavior, or product semantics.

OUTPUT:
SUMMARY:
EVIDENCE:
ROOT CAUSE:
FILES TOUCHED:
FIX:
BEFORE/AFTER:
QA MATRIX:
TESTS:
RISKS:
FOLLOW-UPS:
BRANCH/PR:

========================================================================
SUB-AGENT 9: DETAILS PANEL ALIGNMENT
MODE: coding mode
CLAUDE CODE: request Claude Code specifically
========================================================================

TASK:
Fix one details panel where editable rows and non-editable text rows are visually misaligned.

WHY NOW:
Mixed inputs and static text currently create false indentation and broken grid alignment. This makes the UI feel haphazard and undermines the design system.

SCOPE:
One details panel or one reusable details-row component.
Out of scope: changing saved data behavior, validation, field semantics, labels, edit permissions, or broad redesign.

CONTEXT:
Find a panel where the first rows are editable inputs/selects/pills and later rows are static text. Identify padding, inset, baseline, height, label/value alignment, and component wrappers causing the mismatch.

Target behavior:
- editable and static rows align to the same visual grid
- inputs/selects/pills/static text have compatible baseline and horizontal inset
- focus and edit states remain usable
- no data behavior changes
- no one-off spacing magic

SKILL CHAIN:
/frontend-design -> /investigate -> patch -> /qa -> /review -> /ship

ACCEPTANCE:
Editable and static rows align to the same visual grid.
Inputs, selects, pills, and static text have compatible baseline and horizontal inset.
No data behavior changes.
No new one-off spacing magic.

VERIFY:
Browser QA:
- view mode
- edit mode if applicable
- focus state
- long value
- empty value
- light/dark if applicable
- narrow viewport if layout-sensitive

Run relevant tests/lint/typecheck.

STOP CONDITIONS:
Stop if alignment requires changing product semantics, validation behavior, permissions, or field meaning.

OUTPUT:
SUMMARY:
EVIDENCE:
ROOT CAUSE:
FILES TOUCHED:
FIX:
BEFORE/AFTER:
QA MATRIX:
TESTS:
RISKS:
FOLLOW-UPS:
BRANCH/PR:

========================================================================
SUB-AGENT 10: TOKEN / COMPONENT CONSOLIDATION
MODE: coding mode, but serialize carefully
CLAUDE CODE: request Claude Code specifically
========================================================================

TASK:
Perform a narrow token/component consolidation pilot for one repeated UI pattern, after confirming the blast radius is safe.

WHY NOW:
The UI has hard-coded design values across the app. A narrow pilot reduces drift without risking a broad design-system rewrite.

SCOPE:
One repeated pattern, such as menu item padding, card radius, sidebar row height, toolbar spacing, badge radius, input inset, table row height, action column width, or pill group spacing.
Out of scope: global redesign, broad token migration, unrelated components, feature changes.

CONTEXT:
Inventory repeated hard-coded values for the selected pattern. Prefer existing tokens and shared components. Introduce a new semantic token only if no suitable token exists and the usage is repeated enough to justify it.

Good token names describe purpose:
- surface-muted
- surface-elevated
- border-subtle
- text-secondary
- radius-control
- radius-card
- spacing-toolbar
- spacing-row
- menu-item-padding
- sidebar-row-height
- table-action-column-width
- pill-group-gap

Bad token names:
- grayThing
- randomFix
- pageSpecificPadding
- magic8
- tempCardBg

SKILL CHAIN:
/frontend-design -> /plan-eng-review -> patch -> /qa -> /review -> /ship

ACCEPTANCE:
At least one repeated hard-coded pattern is safely consolidated.
Affected surfaces still match canonical visual behavior.
No unrelated visual changes.
No functionality changes.
Blast radius is explicitly recorded.
Representative surfaces are visually checked.

VERIFY:
Run relevant tests/lint/typecheck.
Browser QA representative affected surfaces.
Check light/dark if token affects color or surface.
Check narrow viewport if token affects layout.
Check affected table/list/card/menu surface if relevant.

STOP CONDITIONS:
Stop if the token has unclear semantics, broad blast radius, multiple plausible design directions, or would affect many surfaces without representative QA.

OUTPUT:
SUMMARY:
REPEATED PATTERN:
CHOSEN TOKEN/COMPONENT:
FILES TOUCHED:
BLAST RADIUS:
FIX:
QA MATRIX:
TESTS:
RISKS:
FOLLOW-UPS:
BRANCH/PR:

POST-DISPATCH COORDINATION

After launching sub-agents:

1. Record every sub-agent in UI_DISPATCH_LOG.md.
2. Record each owned file/component/route/token area in UI_OWNERSHIP_LEDGER.md.
3. Keep a live status board:
   - queued
   - investigating
   - fixing
   - verifying
   - ready-for-review
   - ready-for-pr
   - blocked
   - shipped
   - deferred
4. Pull/rebase frequently.
5. Stop or re-brief any agent whose scope expands.
6. Shut down completed sub-agents cleanly.
7. Do not let token/shared-component work collide with table/menu/details/chat work.
8. Keep shipping small PRs constantly.

FIRST WAVE TARGETS

Start these immediately:

- PR 1: admin table loading-shift stabilization
- PR 2: one right-aligned status/icon/score column pilot
- PR 3: one Linear-style compact pill stacking pilot
- PR 4: one menu/nested-menu normalization fix
- PR 5: one chat composer or details-panel alignment fix, whichever is smaller and higher confidence

Use the inventory agent in parallel so later waves cover every instance rather than isolated examples.

Continue until the UI hardening queue is exhausted, the time window ends, or progress is blocked by a stop condition.
```
