/**
 * Wave 13: which files can carry a `quarantine_override`.
 * Protects: a preserving import that carries a write gate keeps the override only
 * when the gate's tier is owner-tier. An unmanaged sync of an owner source keeps
 * it; a lowered (`trust_tier` below operator_curated) or connector source loses it
 * and the gate quarantines the page; the managed sync/import shape (preserve +
 * `ownerGateInput`) does the same, a remote authority included; an unreadable
 * tier fails closed (unit-level: the gate itself refuses such a tier). Internal owner paths that pass no gate are unchanged.
 * Seams: none; PGLite.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent, importFromFile } from '../src/core/import-file.ts';
import { stripGateOwnedMarkers } from '../src/core/import-screen.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { QUARANTINE_OVERRIDE_KEY, quarantineOverrideFor } from '../src/core/quarantine-override.ts';
import { isQuarantined } from '../src/core/quarantine.ts';
import { ownerGateInput } from '../src/core/trust/channel.ts';
import { withEnv } from './helpers/with-env.ts';

const JUNK_BODY = 'Our scraper analysis: the headless browser stopped at a page that said "Cloudflare Ray ID: 8f2a" before any article text.';
const bare = (title: string) => `---\ntitle: ${title}\ntype: note\n---\n\n${JUNK_BODY}\n`;
function withOverride(title: string, path: string): string {
  const o = quarantineOverrideFor(bare(title), path);
  return `---\ntitle: ${title}\ntype: note\n${QUARANTINE_OVERRIDE_KEY}:\n  binding: ${o.binding}\n  cleared_at: '${o.cleared_at}'\n---\n\n${JUNK_BODY}\n`;
}

let engine: PGLiteEngine;
const home = mkdtempSync(join(tmpdir(), 'gbrain-override-tier-'));
const env = { GBRAIN_HOME: home, GBRAIN_AUDIT_DIR: home };
beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  await engine.executeRaw(`INSERT INTO sources(id,name,config) VALUES ('mirror','mirror','{"trust_tier":"agent_written"}'::jsonb),
    ('gh','gh','{"kind":"github","gh_scope":"repos","gh_repos":"acme-example/app"}'::jsonb)`);
}, 120_000);
afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

const page = async (slug: string, sourceId: string) => (await engine.getPage(slug, { sourceId }))!.frontmatter as Record<string, unknown>;

describe('unmanaged file sync', () => {
  for (const [sourceId, kept] of [['default', true], ['mirror', false], ['gh', false]] as const) {
    test(`${sourceId}: a synced file's own override is ${kept ? 'kept' : 'stripped and the gate decides'}`, () => withEnv(env, async () => {
      const dir = join(home, sourceId, 'notes'); mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'scraper.md'), withOverride('Scraper notes', 'notes/scraper.md'));
      await importFromFile(engine, join(dir, 'scraper.md'), 'notes/scraper.md', { noEmbed: true, sourceId });
      const fm = await page('notes/scraper', sourceId);
      expect({ sourceId, override: fm[QUARANTINE_OVERRIDE_KEY] !== undefined, quarantined: isQuarantined(fm) })
        .toEqual({ sourceId, override: kept, quarantined: !kept });
    }));
  }
});

describe('managed sync and import shape (preserveGateMarkers + ownerGateInput)', () => {
  const row = (source_id: string, remote: boolean) => ({ id: '00000000-0000-4000-8000-000000000013', source_id, operation: 'put_page' as const,
    authority: { remote } as never, intent: { kind: 'managed_sync_import' } as never });
  for (const [label, sourceId, remote, kept] of [['owner source', 'default', false, true], ['lowered source', 'mirror', false, false],
    ['connector source', 'gh', false, false], ['remote authority on the owner source', 'default', true, false]] as const) {
    test(`${label}: override ${kept ? 'kept' : 'stripped'}`, () => withEnv(env, async () => {
      const slug = `notes/managed-${label.replaceAll(' ', '-')}`;
      const content = withOverride(`Managed ${label}`, `${slug}.md`);
      const writeGate = await ownerGateInput(engine, row(sourceId, remote), null, `${slug}.md`);
      await importFromContent(engine, slug, content, { noEmbed: true, sourceId, preserveGateMarkers: true, writeGate });
      const fm = await page(slug, sourceId);
      expect({ override: fm[QUARANTINE_OVERRIDE_KEY] !== undefined, quarantined: isQuarantined(fm) }).toEqual({ override: kept, quarantined: !kept });
    }));
  }

  test('an unreadable gate tier fails closed; a preserving path with no gate keeps a current override', () => withEnv(env, async () => {
    const parsed = parseMarkdown(withOverride('Bad tier', 'notes/bad-tier.md'), 'notes/bad-tier.md', { validate: true });
    stripGateOwnedMarkers(parsed, { preserveGateMarkers: true, writeGate: { tier: 'not-a-tier' } });
    expect(parsed.frontmatter[QUARANTINE_OVERRIDE_KEY]).toBeUndefined();
    await importFromContent(engine, 'notes/no-gate', withOverride('No gate', 'notes/no-gate.md'), { noEmbed: true, preserveGateMarkers: true });
    const fm = await page('notes/no-gate', 'default');
    expect({ override: fm[QUARANTINE_OVERRIDE_KEY] !== undefined, quarantined: isQuarantined(fm) }).toEqual({ override: true, quarantined: false });
  }));
});
