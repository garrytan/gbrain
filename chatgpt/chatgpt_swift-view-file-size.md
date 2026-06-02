---
conversation_id: 6875b27a-09f8-8007-9a92-aa2213d4c2cc
created: 2025-07-15
links:
- '[[chatgpt-clusters/coding_mobile]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
title: Swift view file size
type: note
updated: 2025-07-15
---

# Swift view file size

**Related:** [[coding_mobile]]

> Conversation ID: 6875b27a-09f8-8007-9a92-aa2213d4c2cc
> Created: 2025-07-15T01:44:26Z
> Updated: 2025-07-15T01:44:37Z
> Messages: 2

---

## User

How big should swift view files be?

---

## Assistant

In Swift (especially SwiftUI), view files should be **as small and focused as possible**. Follow these general rules:

---

### ✅ Ideal Swift View File Size Guidelines:

- **1 file = 1 logical view**  
  A file should represent a *single UI concept*, like `ProfileHeaderView.swift` or `PostCard.swift`.

- **Aim for under 200 lines**  
  If it's approaching 300+ lines, it's likely doing too much or has deeply nested logic.

- **Break down nested views**  
  If you find yourself nesting multiple `VStack`/`HStack`/`ZStack`s deeply, extract subviews into private components or separate files.

- **Use file-per-component for reuse**  
  If a subview might be reused elsewhere, give it its own file.

---

### 🚩 Red flags that a view file is too big:

- You’re scrolling constantly to find a section.
- You’re managing more than ~3–4 subviews inside the main `body`.
- You’re adding multiple `@State` or `@ObservedObject` properties that apply to different parts of the view.
- Navigation logic, business logic, and UI layout are all mixed.

---

### 🧠 Rule of Thumb:

> **If you can't describe the purpose of the view in one sentence, it's probably too big.**

Want help breaking one down? Drop it in and I’ll split it cleanly.


**Topic:** [[chatgpt-clusters/coding_mobile]]
