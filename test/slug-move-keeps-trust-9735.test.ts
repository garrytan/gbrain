/**
 * #9735: a slug move re-keys a page and its facts without authoring text, so both keep their stored trust tier
 * whatever tier the mover declares (or none).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withWriteTrust } from '../src/core/persistence/context.ts';
import type { WriteTrust } from '../src/core/persistence/context.ts';

describe('#9735 slug move keeps trust tiers (pglite)', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });
  afterAll(async () => { await engine.disconnect(); });

  async function tiers(slug: string): Promise<{ page: string | null; fact: string | null }> {
    const [p] = await engine.executeRaw<{ t: string }>('SELECT trust_tier AS t FROM pages WHERE slug = $1', [slug]);
    const [f] = await engine.executeRaw<{ t: string }>('SELECT trust_tier AS t FROM facts WHERE entity_slug = $1', [slug]);
    return { page: p?.t ?? null, fact: f?.t ?? null };
  }

  async function scenario(name: string, mover: WriteTrust | null): Promise<{ page: string | null; fact: string | null }> {
    const from = `people/${name}`;
    const to = `people/${name}-2`;
    const agent: WriteTrust = { tier: 'agent_written', origin: null };
    await engine.transaction(tx => withWriteTrust(tx, agent, async () => {
      await tx.putPage(from, { type: 'person', title: name, compiled_truth: `${name} body` });
      await tx.insertFact({ fact: `${name} likes tea`, kind: 'fact', entity_slug: from, source: 'test', visibility: 'private' }, { source_id: 'default' });
    }));
    expect(await tiers(from)).toEqual({ page: 'agent_written', fact: 'agent_written' });
    await engine.transaction(tx => mover
      ? withWriteTrust(tx, mover, () => tx.updateSlug(from, to))
      : tx.updateSlug(from, to));
    return tiers(to);
  }

  test('an owner-tier mover does not raise the page or its facts', async () => {
    expect(await scenario('alice-owner', { tier: 'operator_curated', origin: null })).toEqual({ page: 'agent_written', fact: 'agent_written' });
  });

  test('a mover with no declared tier does not lower the page or its facts', async () => {
    expect(await scenario('alice-undeclared', null)).toEqual({ page: 'agent_written', fact: 'agent_written' });
  });
});
