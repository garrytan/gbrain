/**
 * GST-731 (Cat 25): a question that names one month bounds think's evidence to that month
 * (PR #5086), and that window must not cost the trajectory block. Two failures at 555b73a8:
 *   - the reading in force when the month opens (the latest one before it) was filtered out,
 *     so "MRR in April" with readings in Jan, Mar and Jun injected nothing;
 *   - the entity page dated outside the month was dropped from the gathered pages, and the
 *     question's noun phrase ("foundry example team") resolves to no entity, so nothing was injected.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runThink, type ThinkLLMClient } from '../src/core/think/index.ts';
import { importFromContent } from '../src/core/import-file.ts';

let engine: PGLiteEngine;

async function seedCompany(slug: string, title: string, readings: Array<[string, string, string, number, string?]>) {
  await importFromContent(engine, slug, `---\ntype: company\ntitle: ${title}\n---\n# ${title}\n\n${title} is a company. Dated metric readings live in the facts index.\n`, { noEmbed: true });
  await engine.executeRaw(`UPDATE pages SET effective_date = '2026-11-01T00:00:00Z' WHERE slug = $1`, [slug]);
  for (const [since, text, metric, value, until] of readings) {
    await engine.executeRaw(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, valid_from, valid_until, source, claim_metric, claim_value)
       VALUES ('default', $1, $2, 'fact', 'private', $3, $4, 'test', $5, $6)`,
      [slug, text, `${since}T00:00:00Z`, until ? `${until}T00:00:00Z` : null, metric, value],
    );
  }
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  await seedCompany('companies/nimbus-example', 'Nimbus Example', [
    ['2026-01-05', 'MRR is $40K', 'mrr', 40000],
    ['2026-03-20', 'MRR is $75K', 'mrr', 75000],
    ['2026-06-12', 'MRR is $130K', 'mrr', 130000],
  ]);
  await seedCompany('companies/foundry-example', 'Foundry Example', [
    ['2026-01-10', 'team is 8 people', 'team_size', 8],
    ['2026-04-15', 'team is 15 people', 'team_size', 15],
  ]);
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

async function thinkPrompt(question: string): Promise<{ user: string; warnings: string[] }> {
  let user = '';
  const client: ThinkLLMClient = {
    create: async (params) => {
      const msg = params.messages[0]?.content;
      user = typeof msg === 'string' ? msg : JSON.stringify(msg);
      return {
        id: 'stub', type: 'message', role: 'assistant', model: 'stub', stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null },
        content: [{ type: 'text', text: JSON.stringify({ answer: 'stubbed answer', citations: [], gaps: [] }) }],
      } as never;
    },
  };
  const result = await runThink(engine, { remote: false, question, client });
  return { user, warnings: result.warnings };
}

describe('runThink: a month named in the question keeps the trajectory', () => {
  test('a month with no reading of its own gets the reading in force when it opens', async () => {
    const { user, warnings } = await thinkPrompt('What was the MRR of Nimbus Example in April 2026?');
    expect(warnings).toContain('WINDOW_FROM_QUESTION');
    expect(user).toContain('<trajectory entity="companies/nimbus-example"');
    expect(user).toContain('2026-03-20');
    expect(user).not.toContain('2026-01-05');
    expect(user).not.toContain('2026-06-12');
    expect(warnings).toContain('WINDOW_EXCLUDED_2_TRAJECTORY_POINTS');
  });

  test('an entity page dated outside the month still routes its trajectory', async () => {
    const { user, warnings } = await thinkPrompt('How big was the Foundry Example team in January 2026?');
    expect(warnings).toContain('WINDOW_FROM_QUESTION');
    expect(user).toContain('<trajectory entity="companies/foundry-example"');
    expect(user).toContain('2026-01-10');
    expect(user).not.toContain('2026-04-15');
  });

  test('a reading whose validity ended before the month opens is not carried in', async () => {
    await seedCompany('companies/lapsed-example', 'Lapsed Example', [
      ['2026-02-01', 'MRR is $20K', 'mrr', 20000, '2026-04-10'],
      ['2026-01-15', 'ARR is $250K', 'arr', 250000],
      ['2026-03-01', 'ARR is $300K', 'arr', 300000, '2026-03-31'],
      ['2026-07-01', 'ARR is $500K', 'arr', 500000],
    ]);
    const { user } = await thinkPrompt('What was the revenue of Lapsed Example in April 2026?');
    expect(user).toContain('<trajectory entity="companies/lapsed-example"');
    expect(user).toContain('2026-02-01');
    expect(user).not.toContain('2026-03-01');
    expect(user).not.toContain('2026-01-15');
    expect(user).not.toContain('2026-07-01');
  });
});
