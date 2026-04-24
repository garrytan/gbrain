---
name: frontmatter-guard
version: 1.0.0
description: |
  Validates and auto-repairs frontmatter YAML on every brain page write.
  Gate that prevents malformed pages from entering the brain. Import
  writeBrainPage() instead of raw writeFileSync for any /data/brain/ write.
triggers:
  - "validate frontmatter"
  - "check frontmatter"
  - "brain lint"
  - "fix frontmatter"
tools:
  - exec
  - read
  - write
mutating: true
---

# Frontmatter Guard

> Every brain write goes through the guard. No exceptions.

## Why This Exists

On 2026-04-24, a brain health audit found 203 pages with malformed frontmatter:
- 111 people pages missing closing `---` (entity detector bug)
- 43 meeting pages with unstructured YAML (ingestion bug)
- 16 files with slug mismatches
- 11 with binary corruption
- 4 with nested quote escaping

All written by our own agents. The guard prevents this class of error.

## The Library

**Location:** `lib/brain-writer.mjs` (in the OpenClaw workspace)

### Core API

```javascript
import { writeBrainPage, validateFrontmatter, autoFixFrontmatter } from '../lib/brain-writer.mjs';

// 1. Validated write (throws on bad frontmatter)
writeBrainPage('/data/brain/people/jane-doe.md', content);

// 2. Validated write with auto-repair
writeBrainPage('/data/brain/people/jane-doe.md', content, { autoFix: true });

// 3. Validate only (no write)
const result = validateFrontmatter(content, { filePath: '/data/brain/people/jane-doe.md' });
// → { ok: true/false, errors: [{ code, message }] }

// 4. Auto-fix only (returns fixed content)
const { content: fixed, fixes } = autoFixFrontmatter(content, { filePath });
```

### What It Validates

| Check | Error Code | Description |
|-------|-----------|-------------|
| Opening `---` | `MISSING_OPEN` | File doesn't start with frontmatter |
| Closing `---` | `MISSING_CLOSE` | No closing delimiter (heading found inside YAML zone) |
| YAML parse | `YAML_PARSE` | js-yaml can't parse the frontmatter block |
| Slug match | `SLUG_MISMATCH` | `slug:` field doesn't match file path |
| Null bytes | `NULL_BYTES` | Binary corruption in content |
| Nested quotes | `NESTED_QUOTES` | `title: "Name "Nick" Last"` pattern |
| Empty frontmatter | `EMPTY_FRONTMATTER` | Frontmatter block is empty |

### What It Auto-Fixes

| Fix | Description |
|-----|-------------|
| Missing `---` | Inserts closing delimiter before first heading |
| Nested quotes in title | `"Name "Nick" Last"` → `'Name "Nick" Last'` |
| Nested quotes in lists | Investor notes with inner quotes → inner singles |
| Bracket titles | `title: [Name` → `title: "Name"` |
| Slug removal | Removes `slug:` field (gbrain derives from path) |
| Null bytes | Strips `\x00` characters |

### Path Guard

```javascript
// This THROWS — path is not under /data/brain/
writeBrainPage('/data/.openclaw/workspace/brain/people/test.md', content);
// Error: writeBrainPage: path is not under /data/brain/
```

This prevents the #1 brain write bug: writing to the workspace `brain/` subdirectory instead of the actual brain repo.

## Pre-Commit Hook

**Location:** `/data/brain/.githooks/pre-commit`

Runs on every `git commit` in the brain repo. Checks staged `.md` files for:
1. Missing closing `---`
2. YAML parse errors (via js-yaml from workspace node_modules)
3. Null bytes

Blocks the commit with actionable errors. Bypass: `git commit --no-verify`.

## Integration Rules for Agents

### When writing a brain page directly (writeFileSync)

**ALWAYS** use `writeBrainPage()` instead:

```javascript
// ❌ BAD — no validation, silent corruption
import { writeFileSync } from 'node:fs';
writeFileSync('/data/brain/people/jane-doe.md', content);

// ✅ GOOD — validates, blocks bad writes
import { writeBrainPage } from '../lib/brain-writer.mjs';
writeBrainPage('/data/brain/people/jane-doe.md', content);
```

### When generating frontmatter in a prompt

Always include the closing `---`:

```markdown
---
title: "Person Name"
type: person
created: 2026-04-24
---

# Person Name
```

### When titles contain special characters

Use single quotes for titles with inner double quotes:

```yaml
# ❌ BAD
title: "Phil Libin's Journey to Finding a "Life's Work""

# ✅ GOOD  
title: 'Phil Libin''s Journey to Finding a "Life''s Work"'

# ✅ ALSO GOOD
title: "Phil Libin's Journey to Finding a Life's Work"
```

### When values contain colons

Always quote values with colons:

```yaml
# ❌ BAD — YAML thinks everything after the colon is a new key
garry_context: Fucking sick coding song — one of Garry's favorites

# ✅ GOOD
garry_context: "Fucking sick coding song — one of Garry's favorites"
```

## Running a Brain-Wide Audit

```bash
cd /data/.openclaw/workspace && node -e "
import { validateFrontmatter } from './lib/brain-writer.mjs';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir, files = []) {
  for (const f of readdirSync(dir)) {
    if (f === '.git') continue;
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, files);
    else if (f.endsWith('.md')) files.push(p);
  }
  return files;
}

let valid = 0, invalid = 0;
for (const file of walk('/data/brain')) {
  const content = readFileSync(file, 'utf8');
  if (!content.startsWith('---')) continue;
  const r = validateFrontmatter(content, { filePath: file });
  if (r.ok) valid++; else invalid++;
}
console.log('Valid:', valid, '| Invalid:', invalid, '| Rate:', (valid*100/(valid+invalid)).toFixed(1) + '%');
"
```

## Batch Auto-Fix

```bash
cd /data/.openclaw/workspace && node -e "
import { validateFrontmatter, autoFixFrontmatter } from './lib/brain-writer.mjs';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
// ... walk function ...
let fixed = 0;
for (const file of walk('/data/brain')) {
  const content = readFileSync(file, 'utf8');
  if (!content.startsWith('---')) continue;
  if (validateFrontmatter(content).ok) continue;
  const result = autoFixFrontmatter(content, { filePath: file });
  if (result.fixes.length > 0 && validateFrontmatter(result.content).ok) {
    writeFileSync(file, result.content);
    fixed++;
  }
}
console.log('Fixed:', fixed, 'files');
"
```

## Upstream Path

Once battle-tested here, the validator moves into gbrain's core:
1. `src/core/frontmatter.ts` — the validation + auto-fix logic
2. Integrated into `putPage()` / `upsertPage()` — every DB write validates
3. `gbrain lint` CLI command — runs the audit
4. `gbrain lint --fix` — runs auto-repair
5. Pre-commit hook ships with `gbrain init`
