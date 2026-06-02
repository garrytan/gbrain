---
conversation_id: 68b610ab-e860-8331-9523-86fec709f845
created: 2025-09-01
links:
- '[[chatgpt-clusters/coding_web_dev]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: Prevent AI component issues
type: guide
updated: 2025-09-01
---

# Prevent AI component issues

> Conversation ID: 68b610ab-e860-8331-9523-86fec709f845
> Created: 2025-09-01T21:31:24Z
> Updated: 2025-09-01T21:32:45Z
> Messages: 2

---

## User

How do i prevent this shit in the future when having AI code for me:
Now I have a clear picture. Let me move the legacy components
   to the legacy folder:

⏺ Components Analysis Summary:

  ✅ Active Components (Keep):

  1. DashboardLayoutClient
  (app/dashboard/DashboardLayoutClient.tsx) - Main layout
  2. DashboardOverview - /dashboard/overview route
  3. DashboardAnalytics - /dashboard/analytics route
  4. DashboardLinks - /dashboard/links route
  5. DashboardSettings - /dashboard/settings route
  6. DashboardNav - Navigation used in layout
  7. All supporting atoms/molecules/organisms that are imported
   by the above

  ❌ Legacy Components (Move to Legacy):

  1. DashboardClient (975 lines!) - Old single-page app
  approach, replaced by route-based system
  2. DashboardLayout (organism) - Old layout system
  3. DashboardSidebar (organism) - Old sidebar system
  4. DashboardNavItem (molecule) - Old nav item
  5. DashboardButton (atom) - Old button system
  6. DatabaseThemeToggle - Old theme toggle (replaced by
  EnhancedThemeToggle)

  Let me move these to legacy:

...like why does it just make up new components and leave the old ones while changing the app to use the new ones but not killing the old ones?

---

## Assistant

Mr. White — this happens because AIs default to “append, don’t break,” so they invent parallel comps and re-wire callers, leaving corpses. Fix it with hard rails that make “replace + delete” the only acceptable path.

# Do this:

## 1) Canonical component registry (single source of truth)
Create a tiny allow-list and force all UI imports through it.
```ts
// components/registry.ts
export { DashboardLayoutClient } from '@/components/dashboard/layout/DashboardLayoutClient'
export { DashboardNav } from '@/components/dashboard/nav/DashboardNav'
// …only canonical, blessed components here
```
Then block direct imports from subfolders:
```js
// .eslintrc.cjs
module.exports = {
  plugins: ['boundaries','deprecation'],
  settings: {
    'boundaries/elements': [
      { type: 'ui', pattern: 'components/**' },
      { type: 'ui-registry', pattern: 'components/registry' },
    ],
  },
  rules: {
    'boundaries/element-types': [2, {
      default: 'disallow',
      rules: [
        { from: ['**/*'], to: ['ui-registry'] }, // allow imports from registry
        { from: ['**/*'], to: ['ui'] , disallow: true }, // disallow direct UI imports
      ],
    }],
    'deprecation/deprecation': 'error', // fail on @deprecated usage
  }
}
```

## 2) Mandatory deprecation workflow (PR must include deletion or codemod)
Add a PR template that forces the behavior you want.
```md
<!-- .github/pull_request_template.md -->
### Change type
- [ ] Replace existing component(s)  ☐ UI ADR link

### Migration plan (required for component changes)
- [ ] Codemod included updating imports (path below)
- [ ] All old components deleted in this PR
- [ ] Story/visual tests updated

**Codemod command**
```
pnpm codemod:dashboard
```
```

## 3) Ship a codemod that rewrites imports (so replacements are atomic)
```js
// codemods/replace-dashboard-components.js (jscodeshift)
export default function(file, api) {
  const j = api.jscodeshift, r = j(file.source);
  const map = {
    '@/components/dashboard/DashboardClient': '@/components/dashboard/DashboardOverview',
    '@/components/dashboard/layout/DashboardLayout': '@/components/dashboard/DashboardLayoutClient',
    // ...extend as needed
  };
  r.find(j.ImportDeclaration).forEach(p => {
    const old = p.node.source.value;
    if (map[old]) p.node.source.value = map[old];
  });
  return r.toSource();
}
```
```json
// package.json
{
  "scripts": {
    "codemod:dashboard": "jscodeshift -t codemods/replace-dashboard-components.js 'components/**/*.tsx' 'app/**/*.tsx'"
  }
}
```

## 4) CI guards that **fail** if leftovers exist
Use dead-code + unused-export scanners and enforce zero-tolerance on new orphans.

```json
// package.json
{
  "scripts": {
    "check:knip": "knip --reporter=codeowners",
    "check:tsprune": "ts-prune --error",
    "check:dep": "depcheck --json",
    "check:ui": "pnpm check:knip && pnpm check:tsprune && pnpm check:dep"
  },
  "devDependencies": { "knip":"^5", "ts-prune":"^0.10", "depcheck":"^1.4", "jscodeshift":"^0.14" }
}
```

```yaml
# .github/workflows/ui-guard.yml
name: UI Guard
on:
  pull_request:
    paths:
      - 'components/**'
      - 'app/**'
jobs:
  guard:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - run: pnpm i --frozen-lockfile
      - run: pnpm check:ui
```

### Optional: Danger rule to enforce “add→delete” symmetry
```js
// dangerfile.js
import { danger, fail, warn } from 'danger'

const addedComponents = danger.git.created_files.filter(f => f.startsWith('components/') && f.endsWith('.tsx'))
const deletedComponents = new Set(danger.git.deleted_files)

if (addedComponents.length && !danger.github.pr.body.includes('codemod:dashboard')) {
  warn('Added UI without codemod. Include **codemod:dashboard** section in PR.')
}
for (const f of addedComponents) {
  if (f.includes('/legacy/')) continue
  const basename = f.split('/').pop()
  const guessOld = `components/legacy/${basename}`
  if (!deletedComponents.has(guessOld)) {
    warn(`Consider deleting legacy counterpart for ${basename} (expected ${guessOld}).`)
  }
}
```

## 5) “No shadow systems” rule for tokens/variants
For files like `card-tokens.ts`, test that all used class tokens resolve to **existing keys** so AIs can’t invent `vg-separator`-type ghosts.
```ts
// tests/tokens.spec.ts
import { cardTokens } from '@/components/dashboard/tokens/card-tokens'
const classKeyRegex = /(?:rounded-(?:lg|xl|2xl)|shadow-(?:sm|md|lg)|border-(?:subtle|accent)\/\d+|bg-surface-(?:1|2|3)|p-(?:4|6|8))/g

test('variants only use defined token keys', () => {
  Object.values(cardTokens.variants).forEach(str => {
    const classes = String(str).split(/\s+/)
    for (const c of classes) {
      // Add explicit allow list per your design system
      expect(c).toMatch(classKeyRegex)
    }
  })
})
```
Run in CI so made-up classes fail fast.

## 6) Lightweight ADR (5 minutes)
Require a 1-pager for any component replacement:
```
/docs/adr/00xx-dashboard-navigation.md
- Why replace?
- What is the new canonical import (registry export)?
- Migration notes & codemod included? (Y/N)
- Deletions included? (list)
```

## 7) CODEOWNERS + branch rules
Make `components/**` require your review.
```
# CODEOWNERS
/components/* @timwhite
```
And in GitHub rulesets, make `UI Guard` + `Test` mandatory on `preview` and `production`. Disable merges if checks aren’t green.

## 8) Developer ergonomics (so the “right way” is the easy way)
- Snippet in your Claude.md: “When creating or editing a component, **export it via `components/registry.ts`** and run `pnpm codemod:dashboard`, then delete originals.”
- Repo script:
```json
"scripts": {
  "ui:replace": "pnpm codemod:dashboard && git add -A && pnpm check:ui"
}
```

---

### TL;DR policy to paste in your repo
1) **All UI imports go through `components/registry.ts`.**  
2) **Replacing a component requires a codemod + deletion in the same PR.**  
3) **CI fails** on dead code/unused exports/unknown token classes.  
4) **PR template & Danger** enforce the checklist.  
5) **CODEOWNERS** gate UI changes.  

Do these and the AI can’t quietly fork your UI—if it tries, CI blocks it until the legacy is removed.


**Topic:** [[chatgpt-clusters/coding_web_dev]]
