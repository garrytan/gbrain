/**
 * Wave 13 PR1: file repair and reconcile import with
 * `preserveGateMarkers` and no write gate, so before this fix they kept a file's
 * own `quarantine_override` whatever the source's tier. Protects: both paths keep
 * the override only when the source's owner tier is owner-tier; a lowered source
 * loses it (repair then refuses the file as an overlay). Unit-level: `overrideTier` present but unreadable strips it.
 * Seams: none; PGLite.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { stripGateOwnedMarkers } from '../src/core/import-screen.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { QUARANTINE_OVERRIDE_KEY, quarantineOverrideFor } from '../src/core/quarantine-override.ts';
import { prepareRepairPublication, repairScreenConfig } from '../src/core/persistence/file-repair.ts';
import { prepareReconcileResult } from '../src/core/persistence/reconcile-prepare.ts';
import { reconcileCanonical } from '../src/core/persistence/reconcile-merge.ts';
import type { ReconcileState } from '../src/core/persistence/reconcile-state.ts';
import { withEnv } from './helpers/with-env.ts';

const JUNK_BODY = 'Our scraper analysis: the headless browser stopped at a page that said "Cloudflare Ray ID: 8f2a" before any article text.';
const bare = (title: string) => `---\ntitle: ${title}\ntype: note\n---\n\n${JUNK_BODY}\n`;
function withOverride(title: string, path: string): string {
  const o = quarantineOverrideFor(bare(title), path);
  return `---\ntitle: ${title}\ntype: note\n${QUARANTINE_OVERRIDE_KEY}:\n  binding: ${o.binding}\n  cleared_at: '${o.cleared_at}'\n---\n\n${JUNK_BODY}\n`;
}

let engine: PGLiteEngine;
const home = mkdtempSync(join(tmpdir(), 'gbrain-override-repair-'));
const env = { GBRAIN_HOME: home, GBRAIN_AUDIT_DIR: home };
beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  await engine.executeRaw(`INSERT INTO sources(id,name,config) VALUES ('mirror','mirror','{"trust_tier":"agent_written"}'::jsonb)`);
}, 120_000);
afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

describe('file repair publication', () => {
  // A lowered source's repair stores the page without the override, which differs from the file, so it refuses as an overlay.
  for (const [sourceId, kept] of [['default', true], ['mirror', false]] as const) {
    test(`${sourceId}: a repaired file's own override is ${kept ? 'kept' : 'not published'}`, () => withEnv(env, async () => {
      const content = withOverride('Repair notes', 'notes/repair.md');
      const publication = await prepareRepairPublication(engine, { sourceId, slug: 'notes/repair', sourcePath: 'notes/repair.md', path: 'notes/repair.md', root: home,
        content, snapshot: null, base: null, ...await repairScreenConfig(engine, sourceId) });
      const fm = publication.status === 'ready' ? publication.ready.parsedPage.frontmatter : {};
      expect({ sourceId, status: publication.status, override: fm[QUARANTINE_OVERRIDE_KEY] !== undefined })
        .toEqual({ sourceId, status: kept ? 'ready' : 'overlay', override: kept });
    }));
  }
});

describe('reconcile result', () => {
  for (const [sourceId, kept] of [['default', true], ['mirror', false]] as const) {
    test(`${sourceId}: a reconciled page's override is ${kept ? 'kept' : 'stripped'}`, () => withEnv(env, async () => {
      const slug = 'notes/reconcile';
      await importFromContent(engine, slug, withOverride('Reconcile notes', `${slug}.md`), { sourceId, noEmbed: true, preserveGateMarkers: true, sourcePath: `${slug}.md` });
      const snapshot = (await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true }))!;
      expect(snapshot.page.frontmatter[QUARANTINE_OVERRIDE_KEY]).toBeDefined();
      const state = { path: `${slug}.md`, snapshot, file: reconcileCanonical(snapshot.page, snapshot.tags), originSourcePath: null,
        pins: { source_id: sourceId, slug, assessment_at: new Date().toISOString() } } as unknown as ReconcileState;
      const prepared = await prepareReconcileResult(engine, state, []);
      expect(prepared.ready).toBeDefined();
      expect({ sourceId, override: prepared.ready!.parsedPage.frontmatter[QUARANTINE_OVERRIDE_KEY] !== undefined }).toEqual({ sourceId, override: kept });
    }));
  }
});

test('an overrideTier that is present but unreadable strips the override', () => {
  for (const overrideTier of [undefined, 'not-a-tier', 'agent_written']) {
    const parsed = parseMarkdown(withOverride('Tier notes', 'notes/tier.md'), 'notes/tier.md');
    stripGateOwnedMarkers(parsed, { preserveGateMarkers: true, overrideTier });
    expect({ overrideTier, override: parsed.frontmatter[QUARANTINE_OVERRIDE_KEY] !== undefined }).toEqual({ overrideTier, override: false });
  }
  const owner = parseMarkdown(withOverride('Tier notes', 'notes/tier.md'), 'notes/tier.md');
  stripGateOwnedMarkers(owner, { preserveGateMarkers: true, overrideTier: 'user_confirmed' });
  expect(owner.frontmatter[QUARANTINE_OVERRIDE_KEY]).toBeDefined();
});
