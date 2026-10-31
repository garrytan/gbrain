/**
 * Saved facts in `search` (retrieval.saved_facts): a fact saved with
 * `remember` is found by the next search for its words. Words match whole,
 * after stemming with the brain's full-text language ("renews" and "renewal"
 * share a stem; "count" no longer matches inside "countersigned"), and a fact
 * needs three quarters of the query's words, as before. Among equal matches
 * the newest comes first; at most five facts ride a reply.
 *
 * `search.saved_facts_supersede` (default on): a newer fact carrying a
 * correction cue that shares the query's words with an older returned fact is
 * returned ahead of it, and the older one is labelled `corrected_by`. The
 * fixture is the shape of a harness case where a channel post was corrected
 * in another channel and every search returned the retracted figure.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { serializeMarkdown } from '../src/core/markdown.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { SAVED_FACTS_SUPERSEDE_KEY } from '../src/core/search/saved-facts-match.ts';
import { withEnv } from './helpers/with-env.ts';

const WRITER = { remote: true, transport: 'http' as const, sourceId: 'default' };
const REMOTE = { ...WRITER, auth: { token: 't', clientId: 'sf-client', clientName: 'sf', scopes: ['read'], expiresAt: Date.now() / 1000 + 3600 } };

const FIRST = 'Alice Example wrote in #team-a on 2026-09-02: For your records, no action needed: Orbix Home Goods renews at 52 seats. I will file the signed form once countersigned.';
const CORRECTION = 'Alice Example wrote in #team-b on 2026-09-02: Correction for your records, no action needed: the signed Orbix form says 46 seats, not what I posted in #team-a this morning. Ignore the 52, I was reading the draft.';
const QUESTION = 'Bob Example wrote in a direct message on 2026-09-04: What seat count did Orbix land on for the renewal? I am fixing the seat column in the morning report.';
const WORDINGS = ['Orbix seats renewal', 'Orbix renewal seats', 'Orbix seat count renewal', 'Orbix Home Goods renews seats'];

type Fact = { id: number; fact: string; corrected_by?: number };
let engine: PGLiteEngine;
const ids: Record<string, number> = {};

async function remember(fact: string, validFrom: string): Promise<number> {
  const res = await withEnv({ GBRAIN_BACKUP_CHECK: '0' }, () => dispatchToolCall(engine, 'remember', { fact, provenance: 'fixture', valid_from: validFrom }, { ...WRITER, writeWaitMs: 30_000 }));
  expect(res.isError).toBeFalsy();
  const [row] = await engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE fact = $1', [fact]);
  return Number(row.id);
}

async function search(query: string): Promise<{ facts: Fact[]; text: string }> {
  const res = await withEnv({ GBRAIN_BACKUP_CHECK: '0' }, () => dispatchToolCall(engine, 'search', { query }, REMOTE));
  const retrieval = (res._meta?.retrieval ?? {}) as { saved_facts?: Fact[] };
  return { facts: (retrieval.saved_facts ?? []).map(f => ({ ...f, id: Number(f.id) })), text: res.content.map(c => c.text).join('\n') };
}

const order = (facts: Fact[], id: number) => facts.findIndex(f => f.id === id);

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const [slug, title, body] of [
    ['accounts/orbix', 'Orbix Home Goods account', 'Account notes for Orbix Home Goods. Renewal cycle is annual. Seat counts are on the signed form.'],
    ['notes/renewals', 'Renewal tracker', 'Track every renewal: seats, price, signed form.'],
    ['notes/seat-column', 'Seat column', 'The morning report has a seat column per account.'],
  ] as const) {
    await importFromContent(engine, slug, serializeMarkdown({}, body, '', { type: 'note', title, tags: [] }), { noEmbed: true, forceRechunk: true });
  }
  ids.first = await remember(FIRST, '2026-09-02T09:00:00Z');
  // Saved with the same time as the post it corrects, as a flush of both posts saves them.
  ids.correction = await remember(CORRECTION, '2026-09-02T09:00:00Z');
  ids.question = await remember(QUESTION, '2026-09-04T09:00:00Z');
  ids.lease = await remember('Delta Example countersigned the warehouse lease.', '2026-09-01T09:00:00Z');
  ids.olderLease = await remember('The warehouse lease runs five years.', '2026-08-01T09:00:00Z');
  ids.newerLease = await remember('The warehouse lease renews in March.', '2026-08-15T09:00:00Z');
  ids.otherAccount = await remember('Kappa Example renews at 30 seats.', '2026-09-01T10:00:00Z');
  // A correction posted days before the question that asks for the figure, in the words a question uses.
  ids.zentra = await remember('Dana Example (dana-example, Strategic account manager) wrote in #pod-a on 2026-08-14 09:00: For your records, no action needed: the Q3 digest has Zentra wrong. Zentra Medical Supply is at 50 seats, not 55.', '2026-08-14T09:00:00Z');
  ids.zentraQuestion = await remember('Erin Example (erin-example, revenue lead) wrote in #pod-a on 2026-08-16 09:00: What is the current Zentra Medical Supply seat count? I am filling in the pod sheet.', '2026-08-16T09:00:00Z');
  // Replies that report the correction or acknowledge it on a named date: neither makes a correction.
  ids.zentraAck = await remember('Correction noted on 14 Aug: Zentra Medical Supply has 50 seats, not 55.', '2026-08-14T09:05:00Z');
  ids.zentraReport = await remember('Erin, Zentra Medical Supply is at 50 seats. Dana posted that on 14 Aug, correcting the 55 in the Q3 digest.', '2026-08-16T09:05:00Z');
  // A correction and an acknowledgement of it saved in one flush: the acknowledgement is the later post.
  ids.quellin = await remember('Quellin Freight renews at 30 seats.', '2026-05-01T09:00:00Z');
  ids.quellinFix = await remember('Correction: Quellin Freight is at 24 seats, ignore the 30.', '2026-05-02T09:00:00Z');
  ids.quellinAck = await remember('Thanks for the correction, noted: Quellin Freight at 24 seats.', '2026-05-02T09:00:00Z');
  ids.delta = await remember('Delta Example has 50 seats, not 55.', '2026-08-01T09:00:00Z');
  ids.deltaAck = await remember('Correction noted: Delta Example has 50 seats, not 55.', '2026-08-01T09:05:00Z');
  ids.omega = await remember('Correction for the record: Omega Example stays with Carol Example.', '2026-07-01T09:00:00Z');
  ids.omegaAck = await remember('Correction noted: Omega Example stays with Carol Example.', '2026-07-01T09:05:00Z');
  ids.sigma = await remember('Correction: Sigma Example has 46 seats, not 52.', '2026-06-01T09:00:00Z');
  ids.sigmaAgain = await remember('Correction again: Sigma Example has 44 seats.', '2026-06-02T09:00:00Z');
  // A correction the remote caller may not read never comes back and never relabels a fact it can read.
  await engine.executeRaw(`INSERT INTO facts (source_id, fact, kind, visibility, source, valid_from)
    VALUES ('default', 'Correction: Orbix renewal seats are 40, ignore the earlier posts.', 'fact', 'private', 'fixture', '2026-09-03')`);
}, 180_000);
afterAll(async () => { await engine.disconnect(); });

describe('search saved facts: stem-aware whole-word matching', () => {
  test('the post comes back for every wording through its word forms; partial matches do not', async () => {
    await engine.setConfig(SAVED_FACTS_SUPERSEDE_KEY, 'false');
    for (const q of WORDINGS) {
      const { facts } = await search(q);
      expect(facts.map(f => f.id), q).toContain(ids.first);
      // The correction shares two words (the company and the seats): under three quarters.
      expect(facts.map(f => f.id), q).not.toContain(ids.correction);
      expect(facts.map(f => f.id), q).not.toContain(ids.otherAccount);
      expect(facts.some(f => f.corrected_by !== undefined), q).toBe(false);
      expect(facts.length, q).toBeLessThanOrEqual(5);
    }
  });

  test('a query word matches whole words only', async () => {
    const { facts } = await search('counter lease');
    expect(facts.map(f => f.id)).not.toContain(ids.lease);
  });

  test('newest first among equal matches', async () => {
    const { facts } = await search('warehouse lease');
    expect(order(facts, ids.newerLease)).toBeGreaterThanOrEqual(0);
    expect(order(facts, ids.newerLease)).toBeLessThan(order(facts, ids.olderLease));
  });

  test('a question\'s framing words ("count") do not keep out the fact that states the figure', async () => {
    for (const flag of ['false', 'true']) {
      await engine.setConfig(SAVED_FACTS_SUPERSEDE_KEY, flag);
      const { facts } = await search('Zentra seat count');
      expect(facts.map(f => f.id), flag).toEqual(expect.arrayContaining([ids.zentra, ids.zentraQuestion]));
    }
    await engine.setConfig(SAVED_FACTS_SUPERSEDE_KEY, 'false');
  });

  test('a long natural question finds the short earlier correction that answers it', async () => {
    for (const flag of ['false', 'true']) {
      await engine.setConfig(SAVED_FACTS_SUPERSEDE_KEY, flag);
      const { facts } = await search('What is the current Zentra Medical Supply seat count? I am filling in the quarterly sheet.');
      expect(facts.map(f => f.id), flag).toContain(ids.zentra);
    }
    await engine.setConfig(SAVED_FACTS_SUPERSEDE_KEY, 'false');
  });

  test('a fact the remote caller may not read never comes back', async () => {
    for (const q of WORDINGS) expect((await search(q)).text, q).not.toContain('are 40');
  });
});

describe('search.saved_facts_supersede on', () => {
  test('on by default: with the key unset the correction comes back ahead of the fact it corrects', async () => {
    await engine.unsetConfig(SAVED_FACTS_SUPERSEDE_KEY);
    try {
      for (const q of WORDINGS) {
        const { facts } = await search(q);
        expect(order(facts, ids.correction), q).toBeGreaterThanOrEqual(0);
        expect(order(facts, ids.correction), q).toBeLessThan(order(facts, ids.first));
        expect(facts.find(f => f.id === ids.first)?.corrected_by, q).toBe(ids.correction);
      }
    } finally {
      await engine.setConfig(SAVED_FACTS_SUPERSEDE_KEY, 'false');
    }
  });

  test('the correction comes back ahead of the fact it corrects, which is labelled, for every wording', async () => {
    await engine.setConfig(SAVED_FACTS_SUPERSEDE_KEY, 'true');
    try {
      for (const q of WORDINGS) {
        const { facts, text } = await search(q);
        expect(order(facts, ids.correction), q).toBeGreaterThanOrEqual(0);
        expect(order(facts, ids.correction), q).toBeLessThan(order(facts, ids.first));
        expect(facts.find(f => f.id === ids.first)?.corrected_by, q).toBe(ids.correction);
        expect(facts.find(f => f.id === ids.question)?.corrected_by, q).toBeUndefined();
        expect(facts.find(f => f.id === ids.correction)?.corrected_by, q).toBeUndefined();
        expect(text, q).toContain('corrected by a newer saved fact');
        expect(text, q).not.toContain('are 40');
        // Only a correction comes in under three quarters, not any fact sharing two words.
        expect(facts.map(f => f.id), q).not.toContain(ids.otherAccount);
        expect(facts.length, q).toBeLessThanOrEqual(5);
      }
    } finally {
      await engine.setConfig(SAVED_FACTS_SUPERSEDE_KEY, 'false');
    }
  });

  test('an acknowledgement that adds no figure relabels nothing', async () => {
    await engine.setConfig(SAVED_FACTS_SUPERSEDE_KEY, 'true');
    try {
      const { facts } = await search('Delta seats');
      expect(facts.map(f => f.id)).toEqual(expect.arrayContaining([ids.delta, ids.deltaAck]));
      expect(facts.some(f => f.corrected_by !== undefined)).toBe(false);
      // Acknowledging a correction does not correct it.
      const omega = await search('Omega Carol');
      expect(omega.facts.map(f => f.id)).toEqual(expect.arrayContaining([ids.omega, ids.omegaAck]));
      expect(omega.facts.some(f => f.corrected_by !== undefined)).toBe(false);
      // A correction of a correction that brings a new figure still corrects it.
      const sigma = await search('Sigma seats');
      expect(sigma.facts.find(f => f.id === ids.sigma)?.corrected_by).toBe(ids.sigmaAgain);
    } finally {
      await engine.setConfig(SAVED_FACTS_SUPERSEDE_KEY, 'false');
    }
  });

  test('an acknowledgement saved after a correction does not crowd it out', async () => {
    await engine.setConfig(SAVED_FACTS_SUPERSEDE_KEY, 'true');
    try {
      const { facts } = await search('Quellin seats renewal');
      expect(order(facts, ids.quellinFix)).toBeGreaterThanOrEqual(0);
      expect(order(facts, ids.quellinFix)).toBeLessThan(order(facts, ids.quellin));
      expect(order(facts, ids.quellinAck)).toBeLessThan(order(facts, ids.quellin));
      expect(facts.find(f => f.id === ids.quellin)?.corrected_by).toBeDefined();
    } finally {
      await engine.setConfig(SAVED_FACTS_SUPERSEDE_KEY, 'false');
    }
  });

  test('a reply reporting a correction, or acknowledging it on a named date, relabels nothing', async () => {
    await engine.setConfig(SAVED_FACTS_SUPERSEDE_KEY, 'true');
    try {
      const { facts } = await search('What is the current Zentra Medical Supply seat count? I am filling in the quarterly sheet.');
      expect(facts.map(f => f.id)).toEqual(expect.arrayContaining([ids.zentra, ids.zentraAck, ids.zentraReport]));
      expect(facts.some(f => f.corrected_by !== undefined)).toBe(false);
    } finally {
      await engine.setConfig(SAVED_FACTS_SUPERSEDE_KEY, 'false');
    }
  });

  test('a newer fact with no correction cue relabels nothing', async () => {
    await engine.setConfig(SAVED_FACTS_SUPERSEDE_KEY, 'true');
    try {
      const { facts } = await search('warehouse lease');
      expect(facts.some(f => f.corrected_by !== undefined)).toBe(false);
    } finally {
      await engine.setConfig(SAVED_FACTS_SUPERSEDE_KEY, 'false');
    }
  });
});

// Value: protects=search.saved_facts_supersede turns off for off/0/no/false spellings and CJK words match as substrings; fails_when=the off parse or CJK branch is dropped; why_new=existing tests only set 'false' and use Latin words; seam=none; no_claim=none beyond protects
describe('saved facts: config spellings and CJK words', () => {
  test('every off spelling of search.saved_facts_supersede returns no correction and no label', async () => {
    try {
      for (const raw of ['off', 'OFF', '0', 'no', ' False ']) {
        await engine.setConfig(SAVED_FACTS_SUPERSEDE_KEY, raw);
        const { facts, text } = await search('Orbix seats renewal');
        expect(facts.map(f => f.id), raw).toContain(ids.first);
        expect(facts.map(f => f.id), raw).not.toContain(ids.correction);
        expect(facts.some(f => f.corrected_by !== undefined), raw).toBe(false);
        expect(text, raw).not.toContain('corrected by a newer saved fact');
      }
    } finally {
      await engine.setConfig(SAVED_FACTS_SUPERSEDE_KEY, 'false');
    }
  });

  test('a CJK query word matches inside a fact that has no word breaks', async () => {
    const id = await remember('合同续约期 pending zorbex', '2026-09-05T09:00:00Z');
    const { facts } = await search('续约期 zorbex');
    expect(facts.map(f => f.id)).toContain(id);
    const miss = await search('续费期 zorbex');
    expect(miss.facts.map(f => f.id)).not.toContain(id);
  });
});
// Value: protects=a corrected_by label always names a fact the reply returns; fails_when=the five-fact cap keeps a corrected fact and cuts its corrector; why_new=existing supersede tests return fewer than five facts; seam=none; no_claim=collapsed duplicates (no near-duplicate fixture here)
describe('search.saved_facts_supersede: the five-fact cap', () => {
  test('a corrector that is itself corrected outranks the fact it corrects, so no label names a fact the cap cut', async () => {
    await engine.setConfig(SAVED_FACTS_SUPERSEDE_KEY, 'true');
    try {
      const stale = await remember('Vorlane renews at 52 seats under the plan (the draft said 48).', '2026-04-01T09:00:00Z');
      for (const [i, fact] of ['Vorlane renewal seats: 52 draft, 46 signed, 48 final.', 'The Vorlane renewal lists seats as 52, then 46, then 48.', 'Vorlane seats at renewal went 52 to 46 to 48.'].entries()) {
        await remember(fact, `2026-04-0${i + 2}T09:00:00Z`);
      }
      const corrector = await remember('Correction: Vorlane renewal seats are 46, ignore the 52.', '2026-04-06T09:00:00Z');
      const newest = await remember('Correction: Vorlane seats are 48.', '2026-04-07T09:00:00Z');
      const { facts } = await search('Vorlane seats renewal plan');
      const returned = new Set(facts.map(f => f.id));
      expect(returned.has(newest)).toBe(true);
      expect(returned.has(corrector)).toBe(true);
      expect(facts.find(f => f.id === corrector)?.corrected_by).toBe(newest);
      expect(returned.has(stale)).toBe(false);
      for (const f of facts) if (f.corrected_by !== undefined) expect(returned.has(f.corrected_by), String(f.id)).toBe(true);
    } finally {
      await engine.setConfig(SAVED_FACTS_SUPERSEDE_KEY, 'false');
    }
  });
});
// Value: protects=a corrector outside the top 200 candidates still corrects; fails_when=200 full matches push a two-word cue row past the cut; why_new=no fixture had more than a handful of matching facts; seam=none; no_claim=query cost on a large facts table
// Value: protects=a fact naming another entity, or of lower trust, never demotes the fact it names; fails_when=a cue fact with shared words and a new figure demotes any older fact; why_new=every earlier corrector shared the corrected fact's entity and tier; seam=none; no_claim=two writers at one tier disagreeing
describe('search.saved_facts_supersede: which cue facts can correct', () => {
  test('a cue fact past the first 200 full matches still comes back as the correction', async () => {
    await engine.setConfig(SAVED_FACTS_SUPERSEDE_KEY, 'true');
    try {
      const letters = 'abcdefghijklmnopqrst';
      for (const a of letters) for (const b of 'abcdefghijk') await remember(`Pelloran renewal seats reviewed by desk ${a}${b}.`, '2026-03-02T09:00:00Z');
      const fix = await remember('Correction: Pelloran seats are 24, ignore the 30.', '2026-03-03T09:00:00Z');
      const { facts } = await search('Pelloran renewal seats');
      expect(facts.map(f => f.id)).toContain(fix);
    } finally {
      await engine.setConfig(SAVED_FACTS_SUPERSEDE_KEY, 'false');
    }
  }, 120_000);

  test('a cue fact about another entity, or of lower trust than the fact it names, does not correct', async () => {
    await engine.setConfig(SAVED_FACTS_SUPERSEDE_KEY, 'true');
    try {
      const base = await remember('Torvane Logistics renews at 40 seats.', '2026-02-01T09:00:00Z');
      const other = await remember('Correction: Torvane Logistics seats are 35, ignore the 40.', '2026-02-02T09:00:00Z');
      await engine.executeRaw('UPDATE facts SET entity_slug = $2 WHERE id = $1', [base, 'companies/torvane-example']);
      await engine.executeRaw('UPDATE facts SET entity_slug = $2 WHERE id = $1', [other, 'companies/acme-example']);
      expect((await search('Torvane Logistics seats')).facts.find(f => f.id === base)?.corrected_by).toBeUndefined();
      await engine.executeRaw("UPDATE facts SET entity_slug = 'companies/torvane-example', trust_tier = 'external_untrusted' WHERE id = $1", [other]);
      const lower = await search('Torvane Logistics seats');
      expect(lower.facts.map(f => f.id)).toContain(other);
      expect(lower.facts.find(f => f.id === base)?.corrected_by).toBeUndefined();
      await engine.executeRaw("UPDATE facts SET trust_tier = 'external_untrusted' WHERE id = $1", [base]);
      expect((await search('Torvane Logistics seats')).facts.find(f => f.id === base)?.corrected_by).toBe(other);
    } finally {
      await engine.setConfig(SAVED_FACTS_SUPERSEDE_KEY, 'false');
    }
  });
});
// Value: protects=a label never names a fact the reply leaves out when corrections chain; fails_when=an older corrector ranks ahead of the newer one correcting it and the cap cuts the newer; why_new=the cap test above has one corrected corrector; seam=none; no_claim=chains that cross collapsed copies
describe('search.saved_facts_supersede: a chain of corrections under the cap', () => {
  test('the newest corrections stay ahead, so every label names a returned fact', async () => {
    await engine.setConfig(SAVED_FACTS_SUPERSEDE_KEY, 'true');
    try {
      await remember('Brenlow berth quota lease at 60.', '2026-01-01T09:00:00Z');
      const x = await remember('Correction: Brenlow berth quota lease is 58, ignore the 60, 56 and 55.', '2026-01-02T09:00:00Z');
      const b = await remember('Correction: Brenlow berth quota lease is 55, ignore the 57.', '2026-01-03T09:00:00Z');
      const c = await remember('Correction: Brenlow berth quota is 60, ignore the 56.', '2026-01-04T09:00:00Z');
      const d = await remember('Correction: Brenlow berth is 55.', '2026-01-05T09:00:00Z');
      for (const desk of ['a', 'b']) await remember(`Brenlow berth quota lease reviewed by desk ${desk}.`, '2026-01-06T09:00:00Z');
      const { facts } = await search('Brenlow berth quota lease');
      const returned = new Set(facts.map(f => f.id));
      for (const f of facts) if (f.corrected_by !== undefined) expect(returned.has(f.corrected_by), String(f.id)).toBe(true);
      expect(facts.find(f => f.id === c)?.corrected_by).toBe(d);
      expect(facts.find(f => f.id === b)?.corrected_by).toBe(c);
      expect(returned.has(x)).toBe(false);
    } finally {
      await engine.setConfig(SAVED_FACTS_SUPERSEDE_KEY, 'false');
    }
  });
});
// Value: protects=a correction of one entity's figure never labels another entity's fact, a bare "correction" acknowledgement corrects nothing, and an entity-resolved search keeps the label; fails_when=two shared generic words let a correction cross entities, a figure-free thank-you demotes the figure, or the entity copy replaces the labelled copy; why_new=every earlier fixture named one entity per query and no entity page; seam=none; no_claim=names written in lower case
describe('search.saved_facts_supersede: what a correction must share', () => {
  test('a correction naming another entity does not label a fact on the same two words', async () => {
    await engine.setConfig(SAVED_FACTS_SUPERSEDE_KEY, 'true');
    try {
      const zeta = await remember('Zentic renews at 52 seats.', '2025-10-30T09:00:00Z');
      await remember('Ostrel renews at 52 seats.', '2025-11-01T09:00:00Z');
      await remember('Correction: Ostrel renews at 46 seats, ignore the 52.', '2025-11-02T09:00:00Z');
      const { facts } = await search('Zentic renewal seats');
      expect(facts.map(f => f.id)).toContain(zeta);
      expect(facts.find(f => f.id === zeta)?.corrected_by).toBeUndefined();
    } finally {
      await engine.setConfig(SAVED_FACTS_SUPERSEDE_KEY, 'false');
    }
  });

  test('an acknowledgement with no figure does not correct the fact that states one', async () => {
    await engine.setConfig(SAVED_FACTS_SUPERSEDE_KEY, 'true');
    try {
      const yonder = await remember('Yondrel renews at 52 seats.', '2025-10-01T09:00:00Z');
      await remember('Thanks for the correction on the Yondrel renewal seats, noted.', '2025-10-02T09:00:00Z');
      expect((await search('Yondrel renewal seats')).facts.find(f => f.id === yonder)?.corrected_by).toBeUndefined();
    } finally {
      await engine.setConfig(SAVED_FACTS_SUPERSEDE_KEY, 'false');
    }
  });

  test('a search that resolves the entity keeps the label on the entity copy', async () => {
    await engine.setConfig(SAVED_FACTS_SUPERSEDE_KEY, 'true');
    try {
      await importFromContent(engine, 'companies/halvard-example', serializeMarkdown({}, 'Halvard Example is a customer account.', '', { type: 'company', title: 'Halvard Example', tags: [] }), { noEmbed: true, forceRechunk: true });
      const old = await remember('Halvard Example renews at 40 seats.', '2025-09-01T09:00:00Z');
      const fix = await remember('Correction: Halvard Example is at 35 seats, ignore the 40.', '2025-09-02T09:00:00Z');
      const { facts } = await search('Halvard Example seats');
      expect(facts.map(f => f.id)).toEqual(expect.arrayContaining([old, fix]));
      expect(facts.find(f => f.id === old)?.corrected_by).toBe(fix);
    } finally {
      await engine.setConfig(SAVED_FACTS_SUPERSEDE_KEY, 'false');
    }
  });
});
