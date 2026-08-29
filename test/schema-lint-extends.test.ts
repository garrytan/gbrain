// #4373 — `gbrain schema lint <child>` and the MCP schema_lint op's
// named-pack branch must lint the MERGED manifest: page types inherited
// through `extends` count as declared, matching validate/use/active (which
// all consume loadActivePack → resolvePack → mergeInheritedManifest).
// Red pre-fix: both named-pack branches fed the raw unmerged manifest to
// runAllLintRules, so inherited types fired the false errors
// link_types_undeclared_page_type / frontmatter_links_undeclared_page_type.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';
import { withEnv } from './helpers/with-env.ts';

const REPO_ROOT = join(import.meta.dir, '..');

const PARENT_YAML = `api_version: gbrain-schema-pack-v1
name: lint-parent
version: 1.0.0
description: ""
gbrain_min_version: 0.38.0
extends: null
borrow_from: []
page_types:
  - name: experience
    primitive: temporal
    path_prefixes:
      - experiences/
    aliases: []
    extractable: false
    expert_routing: false
link_types: []
frontmatter_links: []
takes_kinds:
  - fact
  - take
  - bet
  - hunch
enrichable_types: []
filing_rules: []
`;

// Child declares NO page_types of its own; both references resolve only
// through the parent's 'experience' type.
const CHILD_YAML = `api_version: gbrain-schema-pack-v1
name: lint-child
version: 1.0.0
description: ""
gbrain_min_version: 0.38.0
extends: lint-parent
borrow_from: []
page_types: []
link_types:
  - name: had_experience
    inference:
      page_type: experience
frontmatter_links:
  - page_type: experience
    fields: [related]
    link_type: had_experience
takes_kinds:
  - fact
  - take
  - bet
  - hunch
enrichable_types: []
filing_rules: []
`;

// Control fixture: 'ghost' is declared NOWHERE in the chain, so the
// undeclared error must still fire on the merged manifest (fail-closed).
const CHILD_BAD_YAML = `api_version: gbrain-schema-pack-v1
name: lint-child-bad
version: 1.0.0
description: ""
gbrain_min_version: 0.38.0
extends: lint-parent
borrow_from: []
page_types: []
link_types:
  - name: haunted_by
    inference:
      page_type: ghost
frontmatter_links: []
takes_kinds:
  - fact
  - take
  - bet
  - hunch
enrichable_types: []
filing_rules: []
`;

let tmpHome: string;

function seedPack(name: string, yaml: string): void {
  const dir = join(tmpHome, '.gbrain', 'schema-packs', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pack.yaml'), yaml, 'utf-8');
}

beforeEach(() => {
  _resetPackCacheForTests();
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-lint-extends-'));
  seedPack('lint-parent', PARENT_YAML);
  seedPack('lint-child', CHILD_YAML);
});

afterEach(() => {
  _resetPackCacheForTests();
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* swallow */ }
});

function ctxOf(): OperationContext {
  // schema_lint's named-pack branch never touches the engine (file-plane
  // rules only), so a stub context keeps this hermetic and PGLite-free.
  return {
    engine: null,
    config: {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: true,
  } as unknown as OperationContext;
}

type LintReport = { ok: boolean; errors: Array<{ rule: string }> };

describe('schema_lint op — named pack with extends (#4373)', () => {
  it('treats extends-inherited page types as declared', async () => {
    await withEnv({ GBRAIN_HOME: tmpHome }, async () => {
      const result = await operationsByName.schema_lint!.handler(ctxOf(), { pack: 'lint-child' }) as LintReport;
      const rules = (result.errors ?? []).map((e) => e.rule);
      expect(rules).not.toContain('link_types_undeclared_page_type');
      expect(rules).not.toContain('frontmatter_links_undeclared_page_type');
      expect(result.ok).toBe(true);
    });
  });

  it('still fires undeclared errors for types missing from the whole chain', async () => {
    await withEnv({ GBRAIN_HOME: tmpHome }, async () => {
      seedPack('lint-child-bad', CHILD_BAD_YAML);
      const result = await operationsByName.schema_lint!.handler(ctxOf(), { pack: 'lint-child-bad' }) as LintReport;
      const rules = (result.errors ?? []).map((e) => e.rule);
      expect(rules).toContain('link_types_undeclared_page_type');
      expect(result.ok).toBe(false);
    });
  });
});

describe('gbrain schema lint <pack> CLI — extends (#4373)', () => {
  it('lints the merged manifest: exit 0, no inherited-type errors', () => {
    // bun's spawnSync does NOT inherit process.env mutations, so pass env
    // explicitly (same isolation pattern as test/schema-cli.test.ts).
    const env = {
      ...process.env,
      GBRAIN_DATABASE_URL: '',
      DATABASE_URL: '',
      GBRAIN_HOME: tmpHome,
    };
    const result = spawnSync('bun', ['run', 'src/cli.ts', 'schema', 'lint', 'lint-child', '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      env,
    });
    const report = JSON.parse(result.stdout || '{}') as LintReport;
    const rules = (report.errors ?? []).map((e) => e.rule);
    expect(rules).not.toContain('link_types_undeclared_page_type');
    expect(rules).not.toContain('frontmatter_links_undeclared_page_type');
    expect(result.status).toBe(0);
  });
});
