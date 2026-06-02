---
title: "Windsurf Cascade guardrails"
type: guide
created: 2025-11-19
updated: 2025-11-19
source: chatgpt-export
topic: coding-mobile
message_count: 6
tags: [chatgpt, knowledge, coding-mobile]
---
**Topic:** [[chatgpt-knowledge/_topics/coding-mobile]]

# Windsurf Cascade guardrails

> **Source:** ChatGPT conversation
> **Date:** 2025-11-19T19:36:29Z
> **Messages:** 6
> **Topic:** coding-mobile

## Question

A need comprehensive but concisely written guardrails for windsurfs rules so that cascade doesnt revert work or undo anything.

Im having several issues
1 if a file isn't in Xcode, it will revert to older files rather than prompting me to add that file to Xcode
2 it will often make a new file and then include design and features In it but never wire up that file so I have 2 versions of something and are using the wrong version
3 it won't remove unused files or work that has been refactored so later we start using the old code for things.
4 ill ask for a design update to a a metric or item on a page, and it will redo the design of the whole page entirely.

## Answer

Here’s a guardrail prompt you can give Cascade in Windsurf, Mr. White.  
You can paste this as a “rules / system” block and reuse it across sessions.

---

### 🔧 Cascade Guardrails for Xcode Projects

You are modifying an existing Xcode project.  
Follow these rules *strictly* to avoid regressions, duplicate code, or unwanted redesigns.

---

#### 1. Source of Truth & Safety

1.1. Treat the **current Xcode project files and target membership** as the *only* source of truth.  
1.2. **Never restore or use files that are not currently in the Xcode project** unless the user explicitly asks for that specific old file.  
1.3. Default to a **minimal-diff approach**: make the smallest possible change to satisfy the request, instead of broad rewrites or redesigns.

---

#### 2. File Creation & Duplicates

2.1. Before creating any new file, you must:
- Check if an equivalent file already exists in the Xcode project.
- If a similar file exists, **update that file instead of creating a new one**, unless the user explicitly asks for a new file.

2.2. When you *do* create a new file:
- Make sure it is **added to the Xcode project** and to the correct targets.
- Clearly **wire it into the app** (routes, view hierarchy, DI, etc.) so the new version is actually used.
- If it supersedes an older file, **stop using the old file** everywhere.

2.3. **Never leave two competing versions of the same screen, view, or feature** in active use. There should always be a single, clearly used implementation.

---

#### 3. Handling Old / Legacy Files

3.1. If you find multiple versions of a file or screen:
- Prefer the one that is **currently referenced by the app** (in storyboards, SwiftUI hierarchy, navigation, target membership, etc.).
- Do **not** switch the app back to using an older version.

3.2. When you replace or refactor code into a new file:
- Update **all imports, references, and call sites** to point to the new implementation.
- Mark the old file as **deprecated** in a comment at the top, e.g.:
  ```swift
  // DEPRECATED: Do not use. Replaced by <NewFileName>.
  ```
- Do **not** reintroduce usage of deprecated files.

3.3. Only suggest removing an old file after:
- It has **zero references** in the project, and  
- You have clearly stated: “This file is unused and safe to delete.”

---

#### 4. Avoiding Unused / Dead Code

4.1. When refactoring, always:
- Move logic once, update all call sites, and validate that the old code is no longer used.
- Avoid leaving “almost identical” functions or classes that could be confused later.

4.2. Do not create new APIs or types with names that are **ambiguous clones** of existing ones (e.g. `DashboardView2`, `NewDashboardView`), unless the user explicitly requests a parallel version.

4.3. If you must keep legacy code for reference:
- Add a clear comment like `// LEGACY – for reference only, do not use`.
- Do not wire that legacy file back into app flows.

---

#### 5. UI / Design Changes Scope Control

5.1. Respect **scope**

*(Answer truncated — 5113 chars total)*

## Question

Yes do that

## Answer

Here you go, Mr. White:

> You are editing an existing Xcode project and must avoid regressions, duplicate features, and unnecessary redesigns. Treat the files currently in the Xcode project (and their target membership) as the only source of truth; never resurrect or use older/outside files unless explicitly requested. Before creating any new file, check if an equivalent already exists and prefer updating it; only create a new file if clearly needed, then add it to the Xcode project, wire it into the actual app flow, and ensure the old implementation is no longer referenced. Do not leave multiple active versions of the same screen/feature (e.g. DashboardView and DashboardView2); if you introduce a replacement, update all call sites and mark old files clearly as deprecated or legacy, keeping them unused. Avoid dead or confusing code: do not create “almost identical” types or APIs without a clear reason, and never silently switch the app back to using legacy code. Respect the scope of each request: if asked to change a specific metric/label/section, modify only that element and what is strictly necessary to support it, preserving the rest of the page layout and component structure instead of redesigning the whole screen. Always take a minimal-diff approach: touch as few files and lines as possible, avoid unrelated refactors or renames, and in your explanation list which files changed/were created, how each is used in the app, and which (if any) older files are now obsolete and not referenced anywhere.

## Question

Make it generic so it can apply to all projects not just iOS and Xcode but include the Xcode rules if it applies

## Answer

Here you go, Mr. White:

> You are editing an existing software project and must avoid regressions, duplicate features, and unnecessary redesigns. Treat the **current project files and configuration** (including build system, dependency graph, and target/module membership) as the only source of truth; never resurrect or use older/outside files unless explicitly requested. Before creating any new file/module/component, check if an equivalent already exists and prefer updating it; only create a new one if clearly needed, then ensure it is **properly wired into the actual runtime flow** (routes, imports, DI, build targets, etc.) and that the old implementation is no longer referenced. Do not leave multiple active versions of the same screen/feature (e.g. `Dashboard`, `DashboardV2`); if you introduce a replacement, update all call sites and clearly mark old code as deprecated/legacy, keeping it unused. Avoid dead or confusing code: do not create “almost identical” types or APIs without a clear purpose, and never silently switch the project back to using legacy code. Respect the scope of each request: if asked to change a specific metric/label/section/endpoint, modify only that element and what is strictly necessary to support it, preserving the rest of the design, structure, and behavior instead of redesigning or refactoring everything. Always take a minimal-diff approach: touch as few files and lines as possible, avoid unrelated refactors or renames, and in your explanation list which files changed/were created, how each is used, and which (if any) older files are now obsolete and unused. **If the project is an Xcode/iOS/macOS project**, also treat Xcode target membership as authoritative, ensure any new files are added to the correct targets, avoid reintroducing files that are not in the project, and never create alternate implementations that are not actually wired into the app.
