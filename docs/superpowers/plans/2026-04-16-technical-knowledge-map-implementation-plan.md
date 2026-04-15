# Technical Knowledge Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement RFC `docs/rfcs/2026-04-15-technical-knowledge-map-rfc.md` by adding first-class `system` / `codemap` support, technical-query guidance, and a codemap-ingest skill without changing the storage schema.

**Architecture:** Keep the runtime surface small. Extend existing page/frontmatter types so `system` pages and `codemap` data are valid and round-trip safely through import/serialization. Then update the agent-facing docs and skills so technical concept lookups follow the same brain-first loop as people/company lookups.

**Tech Stack:** Bun, TypeScript, gray-matter, markdown skills, existing import pipeline and test suite.

---

## File Map

### Core runtime files

- Modify: `src/core/types.ts` — add `system` page type and typed codemap interfaces
- Modify: `src/core/markdown.ts` — infer `system` from `/systems/` paths and preserve codemap/system frontmatter round-trips

### Skills and docs

- Create: `skills/codemap-ingest/SKILL.md`
- Create: `skills/codemap-ingest/templates/system-page.md`
- Create: `skills/codemap-ingest/templates/concept-codemap-page.md`
- Modify: `skills/manifest.json`
- Modify: `skills/query/SKILL.md`
- Modify: `docs/GBRAIN_AGENT_RULES.md`
- Modify: `docs/GBRAIN_SKILLPACK.md`
- Modify: `docs/guides/brain-agent-loop.md`
- Modify: `docs/guides/brain-first-lookup.md`
- Modify: `docs/guides/entity-detection.md`
- Modify: `docs/guides/repo-architecture.md`

### Tests

- Modify: `test/markdown.test.ts`
- Modify: `test/import-file.test.ts`

---

### Task 1: Add `system` / `codemap` core support

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/core/markdown.ts`
- Test: `test/markdown.test.ts`
- Test: `test/import-file.test.ts`

- [ ] **Step 1: Write the failing tests**

Add tests that prove:
- `parseMarkdown('', 'systems/llvm.md').type` resolves to `system`
- `parseMarkdown()` preserves nested `codemap` frontmatter entries
- `serializeMarkdown()` round-trips `repo`, `build_command`, `test_command`, and `codemap`
- `importFromContent()` sends `type: 'system'` and structured `codemap` through `putPage`

```ts
test('infers system type from systems directory', () => {
  expect(parseMarkdown('', 'systems/llvm.md').type).toBe('system');
});

test('preserves codemap frontmatter through parse and serialize', () => {
  const parsed = parseMarkdown(`---
type: concept
title: Fusion
codemap:
  - system: systems/pytorch
    pointers:
      - path: torch/_inductor/fx_passes/group_fusion.py
        symbol: group_fusion_passes()
        role: Finds fusible FX subgraphs
        verified_at: 2026-04-15
---

Compiled truth.
`);

  const serialized = serializeMarkdown(
    parsed.frontmatter,
    parsed.compiled_truth,
    parsed.timeline,
    { type: parsed.type, title: parsed.title, tags: parsed.tags },
  );

  expect(parseMarkdown(serialized).frontmatter.codemap).toEqual(parsed.frontmatter.codemap);
});
```

- [ ] **Step 2: Extend the shared types**

Update `src/core/types.ts` so the contract knows about technical knowledge maps:

```ts
export type PageType =
  | 'person'
  | 'company'
  | 'deal'
  | 'yc'
  | 'civic'
  | 'project'
  | 'concept'
  | 'source'
  | 'media'
  | 'system';

export interface CodemapPointer {
  path: string;
  symbol?: string;
  role: string;
  verified_at?: string;
  stale?: boolean;
}

export interface CodemapEntry {
  system: string;
  pointers: CodemapPointer[];
  vocabulary?: string;
}

export interface SystemEntryPoint {
  name: string;
  path: string;
  purpose: string;
}

export interface SystemFrontmatter {
  repo?: string;
  language?: string[];
  build_command?: string;
  test_command?: string;
  key_entry_points?: SystemEntryPoint[];
}
```

- [ ] **Step 3: Update markdown type inference**

Teach `parseMarkdown()` to infer `system` from `/systems/` and keep all nested frontmatter intact.

```ts
function inferType(filePath?: string): PageType {
  if (!filePath) return 'concept';

  const lower = ('/' + filePath).toLowerCase();
  if (lower.includes('/systems/') || lower.includes('/system/')) return 'system';
  if (lower.includes('/people/') || lower.includes('/person/')) return 'person';
  // existing mappings stay unchanged
  return 'concept';
}
```

- [ ] **Step 4: Run focused tests to verify RED -> GREEN**

Run:

```bash
bun test test/markdown.test.ts test/import-file.test.ts
```

Expected:
- initial run fails on missing `system` inference / missing codemap coverage
- final run passes cleanly

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts src/core/markdown.ts test/markdown.test.ts test/import-file.test.ts
git commit -m "feat: add technical knowledge map core types"
```

---

### Task 2: Add `codemap-ingest` skill and templates

**Files:**
- Create: `skills/codemap-ingest/SKILL.md`
- Create: `skills/codemap-ingest/templates/system-page.md`
- Create: `skills/codemap-ingest/templates/concept-codemap-page.md`
- Modify: `skills/manifest.json`

- [ ] **Step 1: Write the failing manifest/skill visibility expectation**

Add a test or verification expectation that the manifest exposes the new skill and keeps JSON valid.

```bash
bun --print "JSON.parse(require('node:fs').readFileSync('skills/manifest.json', 'utf8')).skills.map(s => s.name)"
```

Expected after implementation:
- output includes `codemap-ingest`

- [ ] **Step 2: Write the codemap-ingest skill**

The skill must cover:
- repo/system exploration
- drafting a `system` page
- drafting concept pages with `codemap`
- lazy pointer verification
- link creation and sync-after-write discipline

```md
# Codemap Ingest Skill

Build a technical knowledge map for a codebase or cross-system concept.

## Workflow

1. Read the repo README, top-level tree, and build/test commands.
2. Create or update `systems/<slug>.md`.
3. Identify cross-cutting concepts and create/update `concepts/<slug>.md` with `codemap`.
4. Verify each pointer with targeted grep/read before saving.
5. Add typed links (`implements`, `depends_on`, `layer_of`, `extends`, `contradicts`) and sync.
```

- [ ] **Step 3: Add reusable templates**

Create template files that agents can copy with minimal edits.

```md
---
type: system
title: "<System Title>"
repo: "<repo url>"
language: ["<language>"]
build_command: "<build command>"
test_command: "<test command>"
---

## Architecture Summary
...
```

```md
---
type: concept
title: "<Concept Title>"
codemap:
  - system: "systems/<system>"
    pointers:
      - path: "<relative/path>"
        symbol: "<symbol>"
        role: "<role>"
        verified_at: "<YYYY-MM-DD>"
---
```

- [ ] **Step 4: Register the new skill**

Update `skills/manifest.json`:

```json
{
  "name": "codemap-ingest",
  "path": "codemap-ingest/SKILL.md",
  "description": "Build system pages and codemap-backed technical concept maps"
}
```

- [ ] **Step 5: Verify manifest + file presence**

Run:

```bash
bun --print "const m=JSON.parse(require('node:fs').readFileSync('skills/manifest.json','utf8')); m.skills.find(s => s.name === 'codemap-ingest')"
test -f skills/codemap-ingest/SKILL.md
test -f skills/codemap-ingest/templates/system-page.md
test -f skills/codemap-ingest/templates/concept-codemap-page.md
```

- [ ] **Step 6: Commit**

```bash
git add skills/manifest.json skills/codemap-ingest
git commit -m "feat: add codemap ingest skill and templates"
```

---

### Task 3: Update query flow and agent documentation for technical brain-first lookup

**Files:**
- Modify: `skills/query/SKILL.md`
- Modify: `docs/GBRAIN_AGENT_RULES.md`
- Modify: `docs/GBRAIN_SKILLPACK.md`
- Modify: `docs/guides/brain-agent-loop.md`
- Modify: `docs/guides/brain-first-lookup.md`
- Modify: `docs/guides/entity-detection.md`
- Modify: `docs/guides/repo-architecture.md`

- [ ] **Step 1: Add technical query guidance to `skills/query/SKILL.md`**

Insert a new section covering:
- concept/system detection
- codemap-first orientation
- lazy verification when `verified_at` is stale
- update-on-discovery behavior

```md
## Technical Concept Queries

When the user asks how a mechanism works across systems:

1. `gbrain search "<concept>"`
2. If a concept page has `codemap`, read compiled truth first.
3. Use the listed pointers for targeted repo navigation.
4. If a central pointer is older than 30 days, verify and update it.
5. If no codemap exists, explore code and then write one back.
```

- [ ] **Step 2: Extend the agent rules**

Update `docs/GBRAIN_AGENT_RULES.md` so Section 3 explicitly includes:
- technical concept mentions
- system/repo mentions
- cross-system questions
- destination examples for `brain/systems/{slug}.md`

```md
### Technical Concept Mentions

In addition to people/company/deal entities, detect:

| Signal | Destination |
|--------|-------------|
| User asks "how does X work" | `brain/concepts/{x-slug}.md` |
| User mentions a system/repo | `brain/systems/{system-slug}.md` |
| User asks cross-system question | Check all relevant concept + system pages |
| Agent discovers code pattern | Update or create concept page with codemap |
```

- [ ] **Step 3: Add technical knowledge map guidance to the skillpack and guides**

Update the skillpack and guides so they consistently say:
- brain-first now applies to technical/codebase questions
- `systems/` is a valid brain directory
- technical maps are orientation layers, not replacements for grep

```md
## Section 19: Technical Knowledge Maps

### 19.1 System Pages
- architecture summary
- key entry points
- component map
- key abstractions
- build/test commands

### 19.2 Concept Pages with Codemap
- one entry per system
- path + symbol + role + verified_at
- vocabulary mapping

### 19.3 Maintenance Discipline
- verify pointers lazily
- mark stale, don't delete
- update compiled truth when cross-system understanding changes
```

- [ ] **Step 4: Verify docs mention the new surface area**

Run:

```bash
rg -n "codemap|technical knowledge map|systems/|technical concept" docs skills
```

Expected:
- all target docs contain the new technical knowledge map guidance

- [ ] **Step 5: Commit**

```bash
git add skills/query/SKILL.md docs/GBRAIN_AGENT_RULES.md docs/GBRAIN_SKILLPACK.md docs/guides/brain-agent-loop.md docs/guides/brain-first-lookup.md docs/guides/entity-detection.md docs/guides/repo-architecture.md
git commit -m "docs: add technical brain-first knowledge map guidance"
```

---

### Task 4: Repository verification

**Files:**
- Verify only

- [ ] **Step 1: Run targeted unit tests**

```bash
bun test test/markdown.test.ts test/import-file.test.ts
```

Expected:
- PASS

- [ ] **Step 2: Run the broader unit suite that exercises the shared core**

```bash
bun test
```

Expected:
- PASS

- [ ] **Step 3: Run E2E tests with the required DB lifecycle**

```bash
source ~/.zshrc 2>/dev/null || true
docker run -d --name gbrain-test-pg \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=gbrain_test \
  -p 5435:5432 pgvector/pgvector:pg16
docker exec gbrain-test-pg pg_isready -U postgres
DATABASE_URL=postgresql://postgres:postgres@localhost:5435/gbrain_test bun run test:e2e
docker stop gbrain-test-pg && docker rm gbrain-test-pg
```

Expected:
- Tier 1 E2E passes
- if Tier 2 prerequisites exist, skill tests also pass

- [ ] **Step 4: Capture final diff summary**

Run:

```bash
git status --short
git diff --stat
```

- [ ] **Step 5: Report residual gaps explicitly**

If any validation step is skipped or fails, record:
- exact command
- failure reason
- whether it is a code issue or environment issue
