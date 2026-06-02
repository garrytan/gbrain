---
title: "Repo cleanup prompt"
type: guide
created: 2025-09-16
updated: 2025-09-16
source: chatgpt-export
conversation_id: 68c9bd49-5650-8331-b51a-c9173116edb6
message_count: 2
tags: [chatgpt, import, code, long-form]
---
# Repo cleanup prompt

> Conversation ID: 68c9bd49-5650-8331-b51a-c9173116edb6
> Created: 2025-09-16T19:40:58Z
> Updated: 2025-09-16T19:42:37Z
> Messages: 2

---

## User

Currently, my repository has a ton of components living in our jovi folder. But they're inconsistent in their naming conventions. Some are title case, some are loan case, some are hyphens, some don't. Some have test coverage, some don't. Some have storybook coverage, some don't. Then we have components living in a components folder, and then within that an atoms folder. But then we also have a components-dashboard-atoms, then we have a components-dashboard-molecules, then we have components-dashboard-organisms. But then we have a components-auth folder, and some things are atomic design, some things are not. We have inconsistencies, we have whatever. We have naming conventions and organization inconsistencies. And continually throughout refactor, we keep breaking the tailwind configuration, and then I have to spend a lot of time getting that back in. Which is proving difficult to do every time. I think it's just because it keeps writing weird stuff into the globals.css file, and we also keep having that living in two different locations. And, you know, we're just generally, you know, that's our situation. I just want a prompt that I can put into Windsurf or Cloud Code to tell it to just start fixing all of this. And I would probably... Yeah.

---

## Assistant

Got it, Mr. White. Here’s a single “repo-janitor” prompt you can drop into Windsurf or Claude Code to standardize structure, fix naming, and harden Tailwind/global CSS so it stops breaking.

---

# Prompt: Jovie Repo Cleanup & Tailwind Stabilization (One-Shot)

You are an AI refactor bot. Apply the following end-state and deliverables to the current repo **safely**, opening small PRs per step. Do not ask questions—decide sanely and proceed. If something is ambiguous, pick the simplest solution that matches the rules below.

## Objectives (acceptance criteria)
1. **Single source of truth for styles**: exactly one `globals.css` (or `app/globals.css` for Next.js app dir) and one Tailwind config. No duplicates anywhere.
2. **Tailwind v4 stable**: minimal config; CSS loads; no ghost configs; no duplicate PostCSS configs; purge/content paths correct for our tree; dev/build succeed.
3. **Component system normalized**:
   - Atomic design used consistently: `atoms/`, `molecules/`, `organisms/`, plus `layout/`, `icons/`, `forms/`, `primitives/`.
   - Feature-scoped components live under `src/features/<feature>/components/...` (e.g., `auth`, `dashboard`, `profile`).
   - Shared UI lives under `src/components/...` (atoms→organisms).
4. **Naming is consistent**:
   - **Directories**: `kebab-case`.
   - **React components**: **PascalCase** file & symbol (e.g., `Button.tsx`).
   - **Hooks**: `useThing.ts`.
   - **Stories**: `*.stories.tsx` colocated.
   - **Tests**: `*.test.tsx` colocated.
5. **Imports fixed**: All moved/renamed files have updated imports. No broken paths.
6. **Quality gates**: ESLint + TS pass; Storybook runs; unit tests green; Tailwind builds; CI job added to prevent regressions.
7. **Generators**: Add a code generator (Plop or Hygen) for new components with test + story scaffolds that follow the rules.
8. **Docs**: `CONTRIBUTING.md` + `architecture/COMPONENTS.md` + `architecture/STYLES.md` explaining the rules and how to add new components without breaking Tailwind.

## Target file/folder layout
Use **one** of these, based on whether we’re using Next.js app dir:

```
src/
  app/                 # Next.js app router (if present)
    globals.css        # the ONE global stylesheet
  components/          # shared, reusable UI
    atoms/
    molecules/
    organisms/
    layout/
    icons/
    forms/
    primitives/
  features/
    auth/
      components/{atoms,molecules,organisms}
    dashboard/
      components/{atoms,molecules,organisms}
    profile/
      components/{atoms,molecules,organisms}
  hooks/
  lib/
  styles/              # optional for tokens/partials (NOT another globals)
  types/
```

Remove/merge the old scattered folders:
- `jovi/`, `components-dashboard-atoms`, `components-dashboard-molecules`, `components-dashboard-organisms`, `components-auth`, duplicate `components/atoms` trees, etc. Consolidate into the structure above.

## Tailwind v4 stabilization (Next.js)
1. Ensure **exactly one** Tailwind entry in `globals.css`:
   ```css
   @import "tailwindcss";
   @config "../tailwind.config.ts"; /* adjust relative path if needed */
   ```
   (If using app dir, `app/globals.css` is the single import point via `app/layout.tsx`.)
2. Keep **one** `tailwind.config.ts` at repo root (or web app root in monorepo). Minimal example:
   ```ts
   import type { Config } from 'tailwindcss'
   export default {
     content: [
       './src/**/*.{js,ts,jsx,tsx,mdx}',
       './app/**/*.{js,ts,jsx,tsx,mdx}',
       './components/**/*.{js,ts,jsx,tsx,mdx}',
     ],
     theme: { extend: {} },
     plugins: [],
   } satisfies Config
   ```
   - Remove any other Tailwind configs.
3. Ensure **one** `postcss.config.js` at the same root as `tailwind.config.ts`:
   ```js
   module.exports = { plugins: { tailwindcss: {}, autoprefixer: {} } }
   ```
   - Delete duplicates; update build scripts to reference this root.
4. In Next.js, import `./app/globals.css` **once** in `app/layout.tsx`. Delete any duplicate global imports elsewhere.
5. Add a script `pnpm tailwind:check`:
   - Verifies only one `globals.css`.
   - Greps for other `@import "tailwindcss"` and fails if found outside `app/globals.css`.
   - Greps for additional `tailwind.config.*` and fails if more than one.

## Naming & codemods
- Rename all component files in UI/feature trees to **PascalCase.tsx** with default-exported PascalCase symbol.
- Convert folders to `kebab-case`.
- Replace spaces/underscores with hyphens.
- Disallow hyphenated component filenames (use PascalCase files; hyphens are for folders).
- Write a codemod (jscodeshift or ts-morph) to:
  - Update all import paths after moves/renames.
  - Normalize `export default` + named exports where appropriate.
  - Add missing `index.ts` barrels only for **atoms** and **icons** (avoid deep wildcard barrels elsewhere to keep tree-shaking obvious).

## Storybook & tests
- Ensure Storybook v8+ runs: `pnpm storybook`.
- For each component lacking coverage:
  - Create minimal `*.stories.tsx` with primary example.
  - Create `*.test.tsx` using Vitest/RTL (or Jest/RTL if repo uses Jest).
- Add CI to run: `typecheck`, `lint`, `test`, `build`, `storybook:build`.

## ESLint/Prettier guardrails
- Enforce naming/import style:
  - `unicorn/filename-case`: PascalCase for `*.tsx` components; kebab-case for folders.
  - `import/order` with groups and alphabetize.
  - Ban default exports for hooks; allow for components.
- Add an **import alias**:
  - `@/components/*` → `src/components/*`
  - `@/features/*` → `src/features/*`
  - Update `tsconfig.json` `paths`, fix all imports to use these.

## Generators
- Add **Plop** with prompts:
  - **UI Component** (shared) → chooses atom/molecule/organism; creates `ComponentName.tsx`, `ComponentName.stories.tsx`, `ComponentName.test.tsx`, and optional `index.ts`.
  - **Feature Component** → chooses feature & atomic tier; same files under `src/features/<feature>/components/...`.
- Plop ensures PascalCase, colocated tests/stories, and adds a TODO comment for accessibility notes.

## Safety & rollout plan
1. **PR 1 – Tailwind/Styles:** dedupe `globals.css`, fix `tailwind.config.ts`, `postcss.config.js`, update imports, add `tailwind:check` script.
2. **PR 2 – Folder merge:** move/merge legacy folders into target layout; keep **shim re-exports** temporarily to avoid breaking imports; CI green.
3. **PR 3 – Codemods:** apply renames + import rewrites; remove shims; CI green.
4. **PR 4 – Lint rules + Paths:** enforce naming/imports; fix offenders; CI green.
5. **PR 5 – Storybook/tests:** scaffold missing coverage for top 30 most-used components; ensure `storybook:build` and tests pass.
6. **PR 6 – Generators + Docs:** add Plop; add `CONTRIBUTING.md`, `architecture/COMPONENTS.md`, `architecture/STYLES.md`.

## Scripts to add (pnpm)
```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "lint": "eslint .",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run --reporter=default",
    "storybook": "storybook dev -p 6006",
    "storybook:build": "storybook build",
    "tailwind:check": "node scripts/tailwind-guard.js"
  }
}
```

### `scripts/tailwind-guard.js` (generate)
- Fail if more than one `globals.css` contains `@import "tailwindcss"`.
- Fail if more than one `tailwind.config.*` exists.
- Fail if `globals.css` is imported outside `app/layout.tsx` (scan for `import './globals.css'`).

## Deliverables
- The 6 PRs above, each with a concise checklist of changes and “How to verify” steps.
- A final summary comment listing:
  - Files moved/renamed counts.
  - Components standardized.
  - Missing stories/tests added.
  - Tailwind guard output = PASS.
  - Follow-ups (if any) with issue links.

**Now run the plan. If any step fails CI, fix it within the same PR and proceed. Keep commits small and messages explicit.**


**Topic:** [[chatgpt-clusters/code_review]]
