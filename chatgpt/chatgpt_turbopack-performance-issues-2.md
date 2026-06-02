---
title: "Turbopack performance issues"
type: note
created: 2026-02-16
updated: 2026-02-16
source: chatgpt-export
conversation_id: 699346c4-4740-832a-9cd3-e26393948bd6
message_count: 2
tags: [chatgpt, import, code]
---
# Turbopack performance issues

**Related:** [[coding_troubleshoot]]

> Conversation ID: 699346c4-4740-832a-9cd3-e26393948bd6
> Created: 2026-02-16T16:33:13Z
> Updated: 2026-02-16T16:33:35Z
> Messages: 2

---

## User

why is turbo pack slow

---

## Assistant

## entity["software","Turbopack","javascript bundler"]

image_group{"layout":"carousel","aspect_ratio":"1:1","query":["Turbopack logo","Next.js Turbopack terminal output","Next.js dev server compiling message","Webpack vs Turbopack comparison graphic"],"num_per_query":1}

Turbopack is designed to be faster than Webpack in dev, but it can feel slow for a few specific, predictable reasons:

### 1) Cold start + cache warm-up
- First run compiles the entire module graph.
- Large monorepos or many dynamic imports amplify this.
- If `.next` or `.turbo` cache gets cleared often (CI, Docker, frequent reinstalls), you lose the speed advantage.

**Fix:** Persist cache between runs and avoid wiping `node_modules` unnecessarily.

---

### 2) Large dependency graph
- Heavy UI libraries (MUI, AntD), icon packs, or deep barrel exports increase graph traversal.
- Poor tree-shaking in certain packages slows incremental rebuilds.

**Fix:**  
- Import submodules directly (`import Button from '@mui/material/Button'`)  
- Remove unused deps  
- Use `next build --profile` to inspect hot modules.

---

### 3) File watching on macOS (especially large repos)
- macOS file system events + many files = slower invalidation.
- Symlink-heavy monorepos (pnpm, turbo repo) worsen it.

**Fix:**  
- Ensure you're on latest Node LTS  
- Avoid massive `dist` folders inside watched dirs  
- Exclude generated folders via config  

---

### 4) Experimental edges
Turbopack (even in 2026) still has edge cases:
- Certain Babel plugins
- Non-standard loaders
- Legacy webpack-specific configs

When it falls back internally, performance drops.

---

### 5) Dev mode vs production expectation
Turbopack optimizes **incremental rebuild speed**, not always initial boot.  
If your complaint is startup time, that’s normal.  
If HMR is slow after edits, that’s abnormal.

---

### 6) TypeScript + ESLint overhead
If you’re running:
- type-checking
- linting
- custom scripts
- large schema validation

Those can be the bottleneck — not Turbopack.

Try disabling type-check during dev:
```bash
NEXT_DISABLE_ESLINT=1 next dev
```

---

## Quick Diagnostic Checklist

1. How long is cold start vs edit refresh?
2. Repo size (how many files)?
3. Monorepo?
4. Using `pnpm` workspaces?
5. Custom webpack config present?

If you give me:
- Repo type (monorepo or not)
- Approx file count
- Cold start time
- Edit refresh time

I’ll pinpoint the bottleneck precisely.


**Topic:** [[chatgpt-clusters/coding_troubleshoot]]


## See Also
- [[chatgpt/chatgpt_turbopack-performance-issues]]
- [[chatgpt/chatgpt_aerial-performance-prep]]
- [[chatgpt/chatgpt_anitta-performance-style]]
- [[chatgpt/chatgpt_app-performance-hardening-skill]]
- [[chatgpt/chatgpt_audit-public-profile-performance]]
