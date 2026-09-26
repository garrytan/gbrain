/**
 * #4525 — remote put_page must SAY that auto-link reconciliation was skipped.
 *
 * The security posture (auto_link/auto_timeline run for trusted local writers
 * only) is by design; the failure was silence: the tool description never
 * mentioned it, and the bare {skipped: 'remote'} response left MCP agents
 * believing their body wikilinks had been reconciled into the graph.
 *
 * Pins: (1) the op description names the remote skip; (2) the skipped
 * response carries an actionable hint; (3) local writes are unchanged (no
 * skip marker).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../src/core/takes-fence.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 240000);

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
}, 120000);

beforeEach(async () => {
  await resetPgliteState(engine);
  resetGateway();
}, 120000);

function makeCtx(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' as const },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
    sourceId: 'default',
    ...overrides,
  };
}

const putPage = operations.find((o) => o.name === 'put_page')!;

const CONTENT = '---\ntitle: Hint Test\n---\n\nSee people/alice-example for context.';

describe('put_page remote auto-link disclosure (#4525)', () => {
  test('tool description names the remote auto-link skip', () => {
    expect(putPage.description).toMatch(/[Rr]emote .*callers/);
    expect(putPage.description).toContain('skipped');
    expect(putPage.description).toContain('GBRAIN_REMOTE_AUTO_LINK=1');
    // #4679: name the async path too (serve maintenance sweep / `gbrain sweep`).
    expect(putPage.description).toContain('sweep');
    // Wave review: only a stdio serve self-sweeps (startup + idle);
    // `gbrain serve --http` never arms one. The disclosure must be per-lane.
    expect(putPage.description).toMatch(/stdio `gbrain serve` sweeps/);
    expect(putPage.description).toMatch(/`gbrain serve --http` does not self-sweep/);
    expect(putPage.description).not.toMatch(/sweep \(startup \+ idle\)/);
  });

  test('remote write reports skipped: remote WITH an actionable hint', async () => {
    const result = (await putPage.handler(
      makeCtx({ remote: true }),
      { slug: 'notes/remote-hint', content: CONTENT },
    )) as { auto_links?: { skipped?: string; hint?: string }; auto_timeline?: { skipped?: string; hint?: string } };
    expect(result.auto_links?.skipped).toBe('remote');
    expect(result.auto_links?.hint).toBeDefined();
    expect(result.auto_links?.hint).toContain('NOT reconciled');
    expect(result.auto_links?.hint).toContain('sweep');
    // Wave review: lane-accurate — HTTP serve callers are told it does NOT self-sweep.
    expect(result.auto_links?.hint).toMatch(/stdio `gbrain serve` sweeps/);
    expect(result.auto_links?.hint).toMatch(/`gbrain serve --http` does not self-sweep/);
    expect(result.auto_links?.hint).not.toMatch(/sweep \(startup \+ idle\)/);
    // Canonical timeline projections commit with the page snapshot.
    expect(result.auto_timeline?.skipped).toBeUndefined();
  }, 120000);

  // #4679: the brain-ops skill (shipped to the exact agents that write over
  // stdio) promised inline auto_links {created, removed, errors} on EVERY
  // put_page — false for every MCP transport since the gate shipped. It must
  // state the remote skip and the sweep that reconciles those edges later.
  test('brain-ops skill Phase 2.5 states the MCP skip + sweep instead of promising inline auto-link', () => {
    const skill = readFileSync(join(import.meta.dir, '..', 'skills', 'brain-ops', 'SKILL.md'), 'utf8');
    expect(skill).not.toContain('No manual `add_link` calls needed for ordinary page writes');
    expect(skill).toContain('skipped');
    expect(skill).toContain('sweep');
    // Wave review: the skill must not promise a startup/idle sweep to HTTP
    // callers — only the stdio serve arms one.
    expect(skill).toMatch(/`gbrain serve --http` does not self-sweep/);
    expect(skill).not.toMatch(/\(at startup and on 10-minute idle ticks\)/);
  });

  // The paste-in template downstream forks copy (UPGRADING_DOWNSTREAM_AGENTS.md)
  // and the enrich skill carried the same inline promise one file over.
  test('downstream-upgrade doc and enrich skill state the MCP skip, not an inline auto_links promise', () => {
    for (const rel of ['docs/UPGRADING_DOWNSTREAM_AGENTS.md', 'skills/enrich/SKILL.md']) {
      const flat = readFileSync(join(import.meta.dir, '..', rel), 'utf8').replace(/\s+/g, ' ');
      expect(flat).not.toContain('MCP response includes `auto_links: { created');
      expect(flat).not.toContain('Verify via the `auto_links` field in the put_page response (`{ created');
      expect(flat).toContain('skipped: "remote"');
      expect(flat).toContain('sweep');
    }
  });

  test('local write does not carry the remote skip marker', async () => {
    const result = (await putPage.handler(
      makeCtx({ remote: false }),
      { slug: 'notes/local-no-skip', content: CONTENT },
    )) as { auto_links?: { skipped?: string } };
    expect(result.auto_links?.skipped).not.toBe('remote');
  }, 120000);

  test('opted-in remote writes publish and reconcile typed links with the page', async () => {
    await withEnv({ GBRAIN_REMOTE_AUTO_LINK: '1' }, async () => {
      await putPage.handler(makeCtx(), {
        slug: 'companies/acme-example',
        content: '---\ntype: company\ntitle: Acme Example\n---\n\nA test company.',
      });
      const created = await putPage.handler(makeCtx({ remote: true }), {
        slug: 'notes/remote-links',
        content: '---\ntype: note\ntitle: Remote Links\n---\n\nAlice works at [Acme](companies/acme-example).',
      }) as { revision: string; auto_links?: { created: number; removed: number; skipped?: string } };
      expect(created.auto_links?.created).toBe(1);
      expect(created.auto_links?.skipped).toBeUndefined();
      expect((await engine.getLinks('notes/remote-links', { sourceId: 'default' })).map(link => [link.to_slug, link.link_type]))
        .toEqual([['companies/acme-example', 'works_at']]);

      const replaced = await putPage.handler(makeCtx({ remote: true }), {
        slug: 'notes/remote-links',
        expected_revision: created.revision,
        content: '---\ntype: note\ntitle: Remote Links\n---\n\nThe link was removed.',
      }) as { auto_links?: { created: number; removed: number } };
      expect(replaced.auto_links?.removed).toBe(1);
      expect(await engine.getLinks('notes/remote-links', { sourceId: 'default' })).toEqual([]);
    });
  }, 120000);

  test('remote extraction cannot resolve private, foreign, or frontmatter endpoints', async () => {
    await withEnv({ GBRAIN_REMOTE_AUTO_LINK: '1' }, async () => {
      await engine.executeRaw("INSERT INTO sources(id,name) VALUES('foreign-example','Foreign example')");
      await putPage.handler(makeCtx(), { slug: 'people/private-example',
        content: '---\ntype: person\ntitle: Private Example\nvisibility: private\n---\n\nPrivate.' });
      await putPage.handler(makeCtx({ sourceId: 'foreign-example' }), { slug: 'companies/foreign-example',
        content: '---\ntype: company\ntitle: Foreign Example\n---\n\nForeign.' });
      const result = (await putPage.handler(makeCtx({ remote: true }), { slug: 'meetings/remote-example',
        content: '---\ntype: meeting\ntitle: Remote Example\nattendees:\n  - people/private-example\n---\n\n[Private](people/private-example) and [[foreign-example:companies/foreign-example]].' })) as { auto_links?: { created: number; unresolved_count: number } };
      expect(result.auto_links?.created).toBe(0);
      expect(await engine.getLinks('meetings/remote-example', { sourceId: 'default' })).toEqual([]);
      expect(await engine.getBacklinks('meetings/remote-example', { sourceId: 'default' })).toEqual([]);
    });
  }, 120000);

  test('remote replacement preserves links to private targets made by a trusted writer', async () => {
    await withEnv({ GBRAIN_REMOTE_AUTO_LINK: '1' }, async () => {
      await putPage.handler(makeCtx(), { slug: 'people/private-example',
        content: '---\ntype: person\ntitle: Private Example\nvisibility: private\n---\n\nPrivate.' });
      const original = await putPage.handler(makeCtx(), { slug: 'notes/existing-private-link',
        content: '---\ntype: note\ntitle: Existing Private Link\n---\n\n[Private](people/private-example).' }) as { revision: string };
      expect((await engine.getLinks('notes/existing-private-link', { sourceId: 'default' })).map(link => link.to_slug))
        .toEqual(['people/private-example']);
      const result = await putPage.handler(makeCtx({ remote: true }), { slug: 'notes/existing-private-link',
        expected_revision: original.revision,
        content: '---\ntype: note\ntitle: Existing Private Link\n---\n\nUpdated note.' }) as { auto_links?: { removed: number } };
      expect(result.auto_links?.removed).toBe(0);
      expect((await engine.getLinks('notes/existing-private-link', { sourceId: 'default' })).map(link => link.to_slug))
        .toEqual(['people/private-example']);
    });
  }, 120000);

  test('remote replacement does not derive or remove links from protected takes', async () => {
    await withEnv({ GBRAIN_REMOTE_AUTO_LINK: '1' }, async () => {
      await putPage.handler(makeCtx(), { slug: 'companies/protected-example',
        content: '---\ntype: company\ntitle: Protected Example\n---\n\nA company.' });
      const original = await putPage.handler(makeCtx(), { slug: 'notes/protected-link',
        content: `---\ntype: note\ntitle: Protected Link\n---\n\n${TAKES_FENCE_BEGIN}\nAlice works at [Acme](companies/protected-example).\n${TAKES_FENCE_END}` }) as { revision: string };
      const before = await engine.getLinks('notes/protected-link', { sourceId: 'default' });
      const result = await putPage.handler(makeCtx({ remote: true }), { slug: 'notes/protected-link',
        expected_revision: original.revision,
        content: '---\ntype: note\ntitle: Protected Link\n---\n\nPublic replacement.' }) as { auto_links?: { skipped?: string; created?: number; removed?: number } };
      expect(result.auto_links?.skipped).toBe('protected_body');
      expect(await engine.getLinks('notes/protected-link', { sourceId: 'default' })).toEqual(before);
    });
  }, 120000);

  test('opt-in reports disabled when the brain turns off automatic links', async () => {
    await withEnv({ GBRAIN_REMOTE_AUTO_LINK: '1' }, async () => {
      await engine.setConfig('auto_link', 'false');
      try {
        const result = await putPage.handler(makeCtx({ remote: true }), {
          slug: 'notes/remote-links-disabled', content: '---\ntitle: Disabled\n---\n\nNo graph extraction.',
        }) as { auto_links?: { skipped: string } };
        expect(result.auto_links?.skipped).toBe('disabled');
      } finally {
        await engine.setConfig('auto_link', 'true');
      }
    });
  }, 120000);

  test('remote meeting writes keep their graph edges directed out from the page', async () => {
    await withEnv({ GBRAIN_REMOTE_AUTO_LINK: '1' }, async () => {
      await putPage.handler(makeCtx(), { slug: 'people/alice-example',
        content: '---\ntype: person\ntitle: Alice Example\n---\n\nA person.' });
      const result = (await putPage.handler(makeCtx({ remote: true }), { slug: 'meetings/remote-attendance',
        content: '---\ntype: meeting\ntitle: Remote Attendance\n---\n\n## Attendees\n\n- [Alice](people/alice-example) attended.' })) as { auto_links?: { created: number; errors: number } };
      expect(result.auto_links).toMatchObject({ created: 1, errors: 0 });
      expect((await engine.getLinks('meetings/remote-attendance', { sourceId: 'default' })).map(link => link.to_slug))
        .toEqual(['people/alice-example']);
      expect(await engine.getBacklinks('meetings/remote-attendance', { sourceId: 'default' })).toEqual([]);
    });
  }, 120000);
});
