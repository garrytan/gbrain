/**
 * Tests for src/core/skillpack/migrate-fence.ts — the one-shot
 * conversion from old (v0.19–v0.32.x) managed-block model to the new
 * scaffold-and-own model.
 *
 * Pins:
 *   - parseFence: recognizes well-formed fence, handles missing/malformed
 *   - resolveFenceSlugs: receipt → row-parsing fallback (F-CDX-8)
 *   - stripFence: removes markers + receipt, preserves rows verbatim
 *   - runMigrateFence: idempotent re-run, dry-run, fence_malformed signal
 */

import { describe, expect, it, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  parseFence,
  resolveFenceSlugs,
  runMigrateFence,
  stripFence,
} from '../src/core/skillpack/migrate-fence.ts';

const created: string[] = [];
afterEach(() => {
  while (created.length) {
    const p = created.pop()!;
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {}
  }
});

function scratchWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), 'sp-mf-ws-'));
  created.push(ws);
  mkdirSync(join(ws, 'skills'), { recursive: true });
  return ws;
}

function scratchGbrain(): string {
  const root = mkdtempSync(join(tmpdir(), 'sp-mf-gbrain-'));
  created.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'cli.ts'), '// stub');
  mkdirSync(join(root, 'skills', 'alpha'), { recursive: true });
  writeFileSync(
    join(root, 'skills', 'alpha', 'SKILL.md'),
    '---\nname: alpha\n---\n# alpha\n',
  );
  mkdirSync(join(root, 'skills', 'beta'), { recursive: true });
  writeFileSync(
    join(root, 'skills', 'beta', 'SKILL.md'),
    '---\nname: beta\n---\n# beta\n',
  );
  writeFileSync(
    join(root, 'openclaw.plugin.json'),
    JSON.stringify(
      {
        name: 'gbrain-test',
        version: '0.33.0-test',
        skills: ['skills/alpha', 'skills/beta'],
        shared_deps: [],
      },
      null,
      2,
    ),
  );
  return root;
}

const FENCE_WITH_RECEIPT = `<!-- gbrain:skillpack:begin -->

<!-- Installed by gbrain 0.32.0 — do not hand-edit between markers. -->
<!-- gbrain:skillpack:manifest cumulative-slugs="alpha,beta" version="0.32.0" -->

| Trigger | Skill |
|---------|-------|
| "alpha trigger" | \`skills/alpha/SKILL.md\` |
| "beta trigger" | \`skills/beta/SKILL.md\` |

<!-- gbrain:skillpack:end -->`;

const RESOLVER_WITH_FENCE = `# RESOLVER

User-owned routing above.

${FENCE_WITH_RECEIPT}

User-owned routing below.
`;

describe('parseFence', () => {
  it('returns null when no fence is present', () => {
    expect(parseFence('# RESOLVER\n\nNo fence here.\n')).toBeNull();
  });

  it('parses a well-formed fence with receipt', () => {
    const parsed = parseFence(RESOLVER_WITH_FENCE);
    expect(parsed).not.toBeNull();
    expect(parsed!.receiptSlugs).toEqual(['alpha', 'beta']);
    expect(parsed!.receiptVersion).toBe('0.32.0');
    expect(parsed!.rowSlugs).toEqual(['alpha', 'beta']);
  });

  it('detects malformed fence (begin without end)', () => {
    const malformed = '# RESOLVER\n<!-- gbrain:skillpack:begin -->\nno end marker';
    const parsed = parseFence(malformed);
    expect(parsed).not.toBeNull();
    expect(parsed!.block).toBe(''); // signals malformed to caller
  });

  it('parses a pre-v0.19 fence with no receipt comment', () => {
    const oldFence = `# RESOLVER
<!-- gbrain:skillpack:begin -->
| "alpha trigger" | \`skills/alpha/SKILL.md\` |
<!-- gbrain:skillpack:end -->
`;
    const parsed = parseFence(oldFence);
    expect(parsed!.receiptSlugs).toBeNull();
    expect(parsed!.rowSlugs).toEqual(['alpha']);
  });
});

describe('resolveFenceSlugs', () => {
  it('uses receipt when receipt and rows agree', () => {
    const parsed = parseFence(RESOLVER_WITH_FENCE)!;
    const { slugs, usedRowFallback } = resolveFenceSlugs(parsed);
    expect(slugs).toEqual(['alpha', 'beta']);
    expect(usedRowFallback).toBe(false);
  });

  it('F-CDX-8: falls back to row parsing when receipt is missing', () => {
    const fence = `<!-- gbrain:skillpack:begin -->
| "trigger" | \`skills/legacy-skill/SKILL.md\` |
<!-- gbrain:skillpack:end -->`;
    const parsed = parseFence(fence)!;
    const { slugs, usedRowFallback } = resolveFenceSlugs(parsed);
    expect(slugs).toEqual(['legacy-skill']);
    expect(usedRowFallback).toBe(true);
  });

  it('F-CDX-8: uses union when receipt and rows drift', () => {
    const fence = `<!-- gbrain:skillpack:begin -->
<!-- gbrain:skillpack:manifest cumulative-slugs="alpha,old-removed" version="0.20.0" -->
| "alpha" | \`skills/alpha/SKILL.md\` |
| "beta-new" | \`skills/beta-new/SKILL.md\` |
<!-- gbrain:skillpack:end -->`;
    const parsed = parseFence(fence)!;
    const { slugs, usedRowFallback } = resolveFenceSlugs(parsed);
    expect(slugs).toEqual(['alpha', 'beta-new', 'old-removed']);
    expect(usedRowFallback).toBe(true);
  });
});

describe('stripFence', () => {
  it('removes begin/end markers and the receipt comment', () => {
    const parsed = parseFence(RESOLVER_WITH_FENCE)!;
    const out = stripFence(RESOLVER_WITH_FENCE, parsed);
    expect(out).not.toContain('gbrain:skillpack:begin');
    expect(out).not.toContain('gbrain:skillpack:end');
    expect(out).not.toContain('cumulative-slugs');
    expect(out).not.toContain('Installed by gbrain');
  });

  it('preserves table rows verbatim', () => {
    const parsed = parseFence(RESOLVER_WITH_FENCE)!;
    const out = stripFence(RESOLVER_WITH_FENCE, parsed);
    expect(out).toContain('| "alpha trigger" | `skills/alpha/SKILL.md` |');
    expect(out).toContain('| "beta trigger" | `skills/beta/SKILL.md` |');
  });

  it('preserves text before and after the fence', () => {
    const parsed = parseFence(RESOLVER_WITH_FENCE)!;
    const out = stripFence(RESOLVER_WITH_FENCE, parsed);
    expect(out).toContain('User-owned routing above.');
    expect(out).toContain('User-owned routing below.');
  });
});

describe('runMigrateFence', () => {
  it('nothing_to_migrate when no fence is present', () => {
    const ws = scratchWorkspace();
    writeFileSync(join(ws, 'skills', 'RESOLVER.md'), '# fresh resolver\n');

    const result = runMigrateFence({ targetWorkspace: ws });
    expect(result.status).toBe('nothing_to_migrate');
  });

  it('nothing_to_migrate when no resolver file exists', () => {
    const ws = scratchWorkspace();
    const result = runMigrateFence({ targetWorkspace: ws });
    expect(result.status).toBe('nothing_to_migrate');
  });

  it('fence_stripped: writes new content + reports slugs', () => {
    const ws = scratchWorkspace();
    writeFileSync(join(ws, 'skills', 'RESOLVER.md'), RESOLVER_WITH_FENCE);

    const result = runMigrateFence({ targetWorkspace: ws });
    expect(result.status).toBe('fence_stripped');
    expect(result.fenceSlugs).toEqual(['alpha', 'beta']);

    const rewritten = readFileSync(result.resolverFile!, 'utf-8');
    expect(rewritten).not.toContain('gbrain:skillpack:begin');
    expect(rewritten).toContain('| "alpha trigger" | `skills/alpha/SKILL.md` |');
  });

  it('idempotency: re-run after migration is a no-op', () => {
    const ws = scratchWorkspace();
    writeFileSync(join(ws, 'skills', 'RESOLVER.md'), RESOLVER_WITH_FENCE);

    runMigrateFence({ targetWorkspace: ws });
    const result2 = runMigrateFence({ targetWorkspace: ws });
    expect(result2.status).toBe('nothing_to_migrate');
  });

  it('dry-run: returns plan but does not write', () => {
    const ws = scratchWorkspace();
    writeFileSync(join(ws, 'skills', 'RESOLVER.md'), RESOLVER_WITH_FENCE);
    const before = readFileSync(join(ws, 'skills', 'RESOLVER.md'), 'utf-8');

    const result = runMigrateFence({ targetWorkspace: ws, dryRun: true });
    expect(result.status).toBe('fence_stripped');
    expect(result.dryRun).toBe(true);
    expect(readFileSync(join(ws, 'skills', 'RESOLVER.md'), 'utf-8')).toBe(before);
  });

  it('fence_malformed: signals when begin marker has no end', () => {
    const ws = scratchWorkspace();
    writeFileSync(
      join(ws, 'skills', 'RESOLVER.md'),
      '<!-- gbrain:skillpack:begin -->\nno end\n',
    );

    const result = runMigrateFence({ targetWorkspace: ws });
    expect(result.status).toBe('fence_malformed');
  });

  it('copies missing skill dirs additively when gbrainRoot is set', () => {
    const ws = scratchWorkspace();
    const gbrainRoot = scratchGbrain();
    writeFileSync(join(ws, 'skills', 'RESOLVER.md'), RESOLVER_WITH_FENCE);

    // Pre-create alpha/ on host (already present); leave beta missing.
    mkdirSync(join(ws, 'skills', 'alpha'), { recursive: true });
    writeFileSync(join(ws, 'skills', 'alpha', 'SKILL.md'), '# pre-existing\n');

    const result = runMigrateFence({ targetWorkspace: ws, gbrainRoot });
    expect(result.skillsAlreadyPresent).toContain('alpha');
    expect(result.skillsCopied).toContain('beta');
    expect(existsSync(join(ws, 'skills', 'beta', 'SKILL.md'))).toBe(true);
    // alpha's pre-existing content preserved (additive only).
    expect(readFileSync(join(ws, 'skills', 'alpha', 'SKILL.md'), 'utf-8')).toBe(
      '# pre-existing\n',
    );
  });

  it('preserves user-added rows whose slug is not in the bundle (no copy attempt)', () => {
    const ws = scratchWorkspace();
    const gbrainRoot = scratchGbrain();
    const fenceWithUserRow = `<!-- gbrain:skillpack:begin -->
<!-- gbrain:skillpack:manifest cumulative-slugs="alpha,user-extra" version="0.20.0" -->
| "alpha trigger" | \`skills/alpha/SKILL.md\` |
| "user-extra trigger" | \`skills/user-extra/SKILL.md\` |
<!-- gbrain:skillpack:end -->
`;
    writeFileSync(join(ws, 'skills', 'RESOLVER.md'), fenceWithUserRow);

    const result = runMigrateFence({ targetWorkspace: ws, gbrainRoot });
    expect(result.skillsCopied).toContain('alpha');
    expect(result.skillsCopied).not.toContain('user-extra'); // not in bundle
    // The row for user-extra survives in the rewritten resolver.
    expect(readFileSync(result.resolverFile!, 'utf-8')).toContain(
      '| "user-extra trigger" | `skills/user-extra/SKILL.md` |',
    );
  });
});
