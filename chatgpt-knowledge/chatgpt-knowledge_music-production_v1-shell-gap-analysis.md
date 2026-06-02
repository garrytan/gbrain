---
title: "V1 Shell Gap Analysis"
type: guide
created: 2026-05-25
updated: 2026-05-25
source: chatgpt-export
topic: music-production
message_count: 6
tags: [chatgpt, knowledge, music-production]
---
# V1 Shell Gap Analysis

> **Source:** ChatGPT conversation
> **Date:** 2026-05-25T01:04:21Z
> **Messages:** 6
> **Topic:** music-production

## Question

{'asset_pointer': 'sediment://file_00000000db6c71f6a15df1fa849e36d4', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1330, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 1028978, 'width': 2048}
{'asset_pointer': 'sediment://file_0000000073c471f69bca390fc4098684', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1330, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, '

## Answer

Mr. White, gap to close from current shell to V1 shell:

- **Re-add persistent bottom audio player**
  - Fixed bottom bar across the app
  - Waveform visualization
  - Scrubber/playhead
  - Current time + total duration
  - Selected track binding
  - Output/volume icon
  - Expand/fullscreen control

- **Add `Tracks` mode back to Releases**
  - V1 has `Releases 12` and `Tracks 58`
  - Current shell only shows release list + filter
  - Need tab switcher: `Releases / Tracks / +`

- **Rebuild dense track table view**
  - Row numbers
  - Cover thumbnails
  - Track title
  - Featured artist text
  - Metadata columns, at minimum BPM
  - Selected row state
  - Hover/focus state

- **Connect list selection to both right panel and audio player**
  - Clicking a track/release should update the right drawer
  - Selected audio should load into the bottom player
  - Selection should persist while switching right-panel tabs

- **Update right-side detail drawer to V1 structure**
  - Header card with artwork, title, status badge, artist/release metadata
  - Smart-link row
  - Cleaner contained panel styling
  - V1-style tab strip

- **Restore V1 detail tabs**
  - `Overview`
  - `Distribution`
  - `Activity`
  - `Details`

- **Map or merge current tabs**
  - Current `Links` should become or feed into `Distribution`
  - Current `Tasks` should feed into `Activity`
  - Current `Pitch` can remain as a nested action inside `Activity` or a secondary tab
  - Current `+` menu needs clear action parity with V1

- **Build Overview parity**
  - BPM
  - Key
  - Length
  - Smart-link click count
  - 24h / 7d / 30d / 90d / YTD filters
  - Trend percentage
  - Line chart

- **Build Distribution parity**
  - Full provider matrix
  - V1 shows `19/27 live`
  - Provider filter/search
  - Status states: `Live`, `Missing`, `Pending`
  - Streaming provider group
  - More than the current 3-link view

- **Build Activity parity**
  - Open task count
  - Running task state
  - Editorial pitch ready action
  - Smart-link copy action
  - Duplicate release action
  - Open public page action
  - Archive release action

- **Add Details tab content**
  - Release/track metadata
  - ISRC / UPC
  - Credits
  - Genres
  - Release date
  - Territories
  - Distributor state
  - Asset status

- **Fix artwork propagation**
  - Current right header shows initials placeholder while list row has cover art
  - Header should use actual artwork when available
  - Fallback initials only when no artwork exists

- **Restore V1 smart-link presentation**
  - Full smart-link chip
  - Copy button
  - Open/public page button
  - Consistent slug format

- **Resolve sidebar IA gap**
  - V1 artist nav has: `Dashboard`, `Releases`, `Insights`, `Audience`, `Tipping`
  - Current has: `Profile`, `Releases`, `Audience`
  - Need either restore missing artist sections or intentionally remap them

- **Clean up top bar parity**
  - V1 has clear `New release` CTA
  - Current has a blank top-right pill/control
  - Replace with exp

*(Answer truncated — 3866 chars total)*

## Question

{'asset_pointer': 'sediment://file_00000000c23471f5afcc5fa00a8c3f07', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1330, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 839712, 'width': 2048}
{'asset_pointer': 'sediment://file_000000002d4471f59798799a1c264fc7', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1330, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 's

## Answer

Mr. White, updated gap list:

- **Keep all prior release/audio parity items**
  - Persistent bottom audio player
  - Tracks mode
  - Dense track table
  - V1 right-side release drawer
  - Overview / Distribution / Activity / Details tabs
  - Smart-link analytics
  - Full provider matrix
  - Activity/actions module
  - Sidebar/topbar cleanup

- **Unflag all skills/tools for admins by default**
  - Admin users should have every skill/tool enabled without manual flagging
  - Update backend role defaults
  - Update workspace/org seed defaults
  - Update feature-flag fallbacks
  - Update admin permission checks
  - Add regression test: new admin account gets full tool/skill access by default
  - Add migration/backfill for existing admin accounts

- **Fix Mac Electron OAuth buttons**
  - OAuth/connect buttons currently fail to open the external browser
  - Route auth clicks through Electron `shell.openExternal(...)`
  - Verify macOS sandbox/security settings allow external browser launch
  - Ensure auth buttons are real clickable buttons, not blocked by overlay/z-index
  - Confirm callback/deep-link flow returns to app correctly
  - Test all auth providers from the packaged `.app`, not only dev mode
  - Add QA case: click OAuth button → default browser opens → auth completes → app receives callback

- **Fix Mac app icon regression**
  - Current icon is rendering as a square image
  - Restore proper rounded/macOS icon asset
  - Generate correct `.icns` sizes: 16, 32, 64, 128, 256, 512, 1024
  - Add padding/safe-area so the icon matches other macOS app icon sizing
  - Ensure packaged Electron build references the correct `.icns`
  - Clear stale build/cache icon assets
  - Verify in Dock, Finder, Launchpad, Cmd-Tab, and app switcher

- **Fix Tasks page shell parity**
  - V1 task page has compact two-pane layout
  - Current page defaults to a large Kanban/detail experience
  - Need V1-style task list view as primary/default
  - Left task list should occupy fixed column width
  - Right content area should show empty state until a task is selected
  - Persistent bottom audio player should remain visible on Tasks

- **Restore V1 Tasks top navigation**
  - V1 tabs: `All`, `Assigned to me`, `Assigned to Jovie`
  - Current tabs use different casing and counts
  - Add compact segmented tabs with counts
  - Add `New task` CTA in the top-right
  - Restore top-right utility icons: filter/sort/view controls

- **Restore V1 compact task rows**
  - Status circle
  - Task title
  - Due badge
  - Category tag
  - `+n` overflow tag
  - Linked release/track indicator
  - Priority/activity icons
  - Selected row state
  - Completed/cancelled visual states

- **Fix Tasks list-view spacing**
  - Current list view has huge vertical gaps
  - Selected task expands into an oversized card
  - Rows should be compact and consistent height
  - Selection should highlight row only
  - Detail content should live in the right pane, not expand inside the list

- **Fix Tasks board-view lay

*(Answer truncated — 5181 chars total)*

## Question

{'asset_pointer': 'sediment://file_00000000344c722f910e82285aeed339', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 260, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 33433, 'width': 812}
great now in this screenshot i want that menu items tooltip to start on the line no immediatly. write that as a prompt

## Answer

Mr. White, use this prompt:

**Fix sidebar thread tooltip positioning. The tooltip for each menu/thread item should open aligned to the same row as the hovered item, starting on that item’s horizontal line immediately to the right of the sidebar item. Use a `right-start` style placement instead of a centered vertical placement. The tooltip’s top edge should align with the top of the hovered row, with a small horizontal gap from the active pill, and it should not float above, below, or vertically center independently of the row. Apply this consistently to all sidebar thread/menu item tooltips, including active, hover, and focused states.**
