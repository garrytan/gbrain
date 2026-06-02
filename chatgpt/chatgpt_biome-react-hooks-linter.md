---
title: "Biome React Hooks Linter"
type: note
created: 2026-01-23
updated: 2026-01-23
source: chatgpt-export
conversation_id: 6973cb16-b8a0-8332-b80f-76ce98351571
message_count: 2
tags: [chatgpt, import, code]
---
# Biome React Hooks Linter

> Conversation ID: 6973cb16-b8a0-8332-b80f-76ce98351571
> Created: 2026-01-23T19:25:11Z
> Updated: 2026-01-23T19:25:45Z
> Messages: 2

---

## User

biome react hooks

---

## Assistant

“Biome React Hooks” isn’t a React runtime or a set of hook implementations—it’s about **linting rules in the Biome toolchain that enforce correct React hook usage** in your codebase. Biome itself is a Rust-based **formatter + linter toolchain** meant to replace ESLint/Prettier, not a React library. citeturn0search5

### What Biome does with React Hooks

Biome doesn’t provide its own hook functions like `useState` or `useEffect`—those come from React. Instead, **Biome’s linter has built-in rules that check whether your React hook usage follows React’s Rules of Hooks**: citeturn0search0turn0search2

- **`useHookAtTopLevel`** – flags hooks called conditionally or not at the top of a component function. Hooks must be called unconditionally and in the same order on every render (same rule React enforces). citeturn1search4  
- **`useExhaustiveDependencies`** – checks that dependency arrays for hooks like `useEffect`, `useMemo`, and others include all variables used inside the hook callback (prevents stale closures and logic bugs). citeturn1search6

These are **lint rules** (static analysis), not runtime features. You configure them in your `biome.json` file under linter rules, similar to how ESLint’s `eslint-plugin-react-hooks` works. citeturn1search1

### How to use with a React project

1. **Install Biome** in your project (e.g., via npm/yarn). citeturn0search5  
2. Create/adjust `biome.json` to enable recommended rules or specifically your hook rules:  
   ```json
   {
     "linter": {
       "rules": {
         "correctness": {
           "useHookAtTopLevel": "error",
           "useExhaustiveDependencies": "error"
         }
       }
     }
   }
   ```  
   (Biome lint will then warn/error when you violate hook rules.)
3. Run `biome lint` or `biome check` as part of CI or pre-commit workflows.

### Summary

- **Biome itself is a linter + formatter**, not a React library. citeturn0search5  
- The “React Hooks” support in Biome comes from **linting rules that enforce correct React hook usage**, similar to ESLint’s rules. citeturn0search0  
- These rules help maintain best practices with hooks (top-level calls, exhaustive deps), but they don’t replace or implement React hooks themselves. citeturn0search2

If you need examples of those lint rules in action or how they compare to ESLint’s hook rules, I can provide them.


**Topic:** [[chatgpt-clusters/coding_web_dev]]
