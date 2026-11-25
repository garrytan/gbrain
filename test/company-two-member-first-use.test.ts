/**
 * Roadmap PR 2 (uc: company first use with two members): the brain-layout block tells the agent to save a decision
 * the whole team should know into company/ with its readers named, and that path works for two members on a repo-less
 * brain (in-memory PGLite; Postgres too when DATABASE_URL is set), through stdio servers bound to each member.
 *
 * 1. Protects: alice-example saves a team decision naming both members as readers and a private note naming only
 *    herself; bob-example reads and finds the decision and never sees the note.
 * 2. Fails when: the block drops the readers line, a member's private note reaches the other member through get_page
 *    or search, or a named reader cannot find the decision.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { addMember } from '../src/core/access/members.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { COMPANY_SOURCE, LAYOUT_VERSION, renderLayoutBlock } from '../src/commands/setup-brain-layout.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const DECISION = 'company/decisions/2026-11-25-pricing-tiers';
const NOTE = 'company/notes/alice-example-draft';
const DECISION_CANARY = 'decisionmarkerqv';
const NOTE_CANARY = 'privatenotemarkerqv';

test('the company layout block names the readers line', () => {
  const block = renderLayoutBlock('claude-code', 'user', null, 'company');
  expect(block).toContain('Save a decision the whole team should know into company/ with its readers named (readable_by: [<member>, ...] in its frontmatter); a company/ page without readable_by is readable by everyone who can read the company source.');
  expect(block).not.toContain('private by default');
  expect(renderLayoutBlock('claude-code', 'user', null, 'personal')).not.toContain('readable_by');
  expect(LAYOUT_VERSION).toBe(4);
});

for (const kind of testBackends()) {
  describe(`company first use with two members (${kind}, repo-less)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;

    const as = async (member: string, op: string, params: Record<string, unknown>) => {
      const out = await dispatchToolCall(engine, op, params, { remote: true, transport: 'stdio', sourceId: COMPANY_SOURCE, stdioMember: member });
      return { isError: out.isError === true, text: out.content.map(c => c.text).join('\n') };
    };
    const page = (title: string, readers: string[], body: string) => ['---', 'type: note', `title: ${title}`, `readable_by: [${readers.join(', ')}]`, '---', `# ${title}`, '', body].join('\n');

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      __resetPrivateVisibilityCacheForTests();
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [COMPANY_SOURCE]);
      await addMember(engine, 'alice-example');
      await addMember(engine, 'bob-example');
    }, 120_000);
    afterAll(async () => { await close(); });

    test('alice saves a team decision and a private note; bob reads and finds only the decision', async () => {
      const wrote = await as('alice-example', 'put_page', { slug: DECISION, content: page('Pricing tiers', ['alice-example', 'bob-example'], `We keep three tiers. ${DECISION_CANARY}` ) });
      expect(wrote.isError).toBe(false);
      expect((await as('alice-example', 'put_page', { slug: NOTE, content: page('Draft thoughts', ['alice-example'], `Not ready to share. ${NOTE_CANARY}`) })).isError).toBe(false);

      expect((await as('bob-example', 'get_page', { slug: DECISION })).text).toContain(DECISION_CANARY);
      const note = await as('bob-example', 'get_page', { slug: NOTE });
      expect(note.text).not.toContain(NOTE_CANARY);
      expect((await as('alice-example', 'get_page', { slug: NOTE })).text).toContain(NOTE_CANARY);

      const found = await as('bob-example', 'search', { query: DECISION_CANARY });
      expect(found.text).toContain(DECISION);
      const hidden = await as('bob-example', 'search', { query: NOTE_CANARY });
      expect(hidden.text).not.toContain(NOTE);
      expect(hidden.text).not.toContain(NOTE_CANARY);
    });
  });
}
