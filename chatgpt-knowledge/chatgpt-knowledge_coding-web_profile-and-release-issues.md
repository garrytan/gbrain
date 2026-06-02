---
title: "Profile and Release Issues"
type: guide
created: 2026-04-21
updated: 2026-04-21
source: chatgpt-export
topic: coding-web
message_count: 6
tags: [chatgpt, knowledge, coding-web]
---
**Topic:** [[chatgpt-knowledge/_topics/coding-web]]

# Profile and Release Issues

> **Source:** ChatGPT conversation
> **Date:** 2026-04-21T20:16:54Z
> **Messages:** 6
> **Topic:** coding-web

## Question

Okay I'm gonna list out some issues and I need you to pull them and organize them and then open up well-scoped issues in Linear so on public profiles.
Right now on desktop when you open the right drawer or the menu:
1. The menu on desktop is opening at the bottom of the browser even though the profile is contained in a smaller area.
2. When I click on releases it then expands to a giant drawer even though that's scrolling; it's way too tall.
3. I'm seeing releases that don't have album art and stuff.
There are a couple of things that need to happen there:
1. You need to make sure that if it doesn't have album art it never is allowed to be a published release. We should never have a published release that doesn't have art on it. The minimum requirement should be that it has album art, it has a title, it has an artist set, and it has a release date set. If it doesn't have that, the issue never becomes a published release and is a draft.
2. I don't know why, but somehow on my public profi

## Answer

I’ll break this into focused, copy-ready Linear issues with clear scope, priority, acceptance criteria, and dependencies, separating public-profile work from auth/settings/platform cleanup.

## Answer

Mr. White, here are Linear-ready issues, organized and scoped. I’d create these as separate tickets rather than one giant cleanup issue.

## Epic: Public Profile Releases + Drawer UX

### 1. Fix desktop public profile menu/drawer positioning

**Priority:** P1  
**Area:** Frontend  
**Labels:** `public-profile`, `desktop`, `drawer`, `ui-bug`

**Problem**  
On desktop public profiles, opening the right drawer/menu positions the menu at the bottom of the browser viewport, even when the profile content is constrained to a smaller centered area.

**Expected behavior**  
The drawer/menu should anchor relative to the public profile container, not the full browser viewport.

**Acceptance criteria**
- Desktop menu opens aligned to the profile container.
- Menu does not appear at the bottom of the browser unless the profile container itself is there.
- Behavior works across common desktop viewport sizes.
- No regression to mobile drawer behavior.
- Add visual/test coverage if available for public profile desktop drawer positioning.

---

### 2. Constrain releases drawer height on public profiles

**Priority:** P1  
**Area:** Frontend  
**Labels:** `public-profile`, `releases`, `drawer`, `ui-bug`

**Problem**  
Clicking “Releases” on the public profile expands the drawer into a giant oversized panel. The drawer is too tall even though the releases content is scrollable.

**Expected behavior**  
The releases drawer should have a bounded height and internal scrolling.

**Acceptance criteria**
- Releases drawer has a reasonable max-height on desktop.
- Releases list scrolls inside the drawer.
- Drawer does not exceed the intended profile container/page layout.
- Empty/loading/error states respect the same height constraints.
- Mobile behavior remains usable.

---

### 3. Block publishing releases that are missing required metadata

**Priority:** P0  
**Area:** Backend  
**Labels:** `releases`, `publishing`, `data-integrity`, `public-profile`

**Problem**  
Published releases are appearing publicly without required metadata, including missing album art.

**Required metadata for published releases**
- Album art
- Title
- Artist
- Release date

**Expected behavior**  
A release that is missing any required field must remain a draft and must never appear as a published public release.

**Acceptance criteria**
- Server-side validation prevents publishing when album art, title, artist, or release date is missing.
- Imported/ingested releases missing required metadata are stored as drafts.
- Existing published releases missing required metadata are migrated or corrected so they no longer appear publicly.
- Public profile queries exclude invalid published releases defensively.
- Add tests for publish flow, import flow, and public profile release query.

---

### 4. Dedupe ingested releases by UPC

**Priority:** P0  
**Area:** Backend  
**Labels:** `releases`, `ingestion`, `deduplication`, `data-integrity`

**Problem**  
The same EP has been ingested multiple times and

*(Answer truncated — 17305 chars total)*

## Question

Open up issues in linear for each one of these please 

## Answer

I can map these into separate Linear issues, but there’s no Linear connector exposed here to create them directly. I’ll provide an import-ready CSV fallback so you can bulk import them.

## Answer

Mr. White, I don’t have a Linear connector/action available in this chat, so I couldn’t create the tickets directly in Linear.

I prepared a Linear-import-ready CSV with all **20 scoped issues**. It uses Linear’s documented CSV fields: `Title`, `Description`, `Priority`, `Status`, `Assignee`, `Created`, `Completed`, `Labels`, and `Estimate`. Linear documents imports under **Settings → Administration → Import/Export**, with admin access required, and recommends the CLI importer for CSV imports using the “Linear” CSV option. citeturn322544view0

Files:

- [Download Linear CSV import file](sandbox:/mnt/data/linear_issues_public_profile_auth_cleanup.csv)
- [Download readable Markdown review file](sandbox:/mnt/data/linear_issues_public_profile_auth_cleanup.md)

Priority mapping used:

| Internal priority | Linear priority |
|---|---|
| P0 | Urgent |
| P1 | High |
| P2 | Medium |

All issues are set to `Backlog` with labels for area, feature, and priority.
