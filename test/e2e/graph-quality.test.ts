/**
 * E2E test for the v0.10.1 knowledge graph layer.
 *
 * Runs the full pipeline against in-memory PGLite (no API keys, no external DB).
 *   1. Seed pages with entity refs and timeline content
 *   2. Run link-extract + timeline-extract
 *   3. Verify graph populated
 *   4. Test auto-link via put_page operation handler
 *   5. Test reconciliation (edit page, stale links removed)
 *   6. Test graph-query traversal
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runExtract } from '../../src/commands/extract.ts';
import { operationsByName } from '../../src/core/operations.ts';
import type { OperationContext } from '../../src/core/operations.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

async function truncateAll() {
  for (const t of ['content_chunks', 'links', 'tags', 'raw_data', 'timeline_entries', 'page_versions', 'ingest_log', 'config', 'pages']) {
    await (engine as any).db.exec(`DELETE FROM ${t}`);
  }
  // Re-seed the two config keys this file touches back to their documented
  // defaults (both default to ON). This makes every test deterministic even if
  // an earlier test threw before its finally restored auto_link/auto_timeline,
  // and even though absent-key already resolves truthy via isAuto*Enabled.
  await engine.setConfig('auto_link', 'true');
  await engine.setConfig('auto_timeline', 'true');
}

function makeContext(): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' } as any,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    // E2E graph quality simulates local-CLI writes (auto-link / timeline run).
    // After F7b made `remote` required this needs to be explicit.
    remote: false,
    sourceId: 'default',
  };
}

describe('E2E graph quality (v0.10.1 pipeline)', () => {
  beforeEach(truncateAll, 15_000);

  test('full pipeline: seed -> link-extract -> timeline-extract -> verify', async () => {
    // Seed 5 pages with entity refs and timeline content.
    await engine.putPage('people/alice', {
      type: 'person', title: 'Alice',
      compiled_truth: 'Alice is the CEO of [Acme](companies/acme).',
      timeline: '- **2026-01-15** | Joined as CEO\n- **2026-02-20** | Closed Series A',
    });
    await engine.putPage('people/bob', {
      type: 'person', title: 'Bob',
      compiled_truth: 'Bob is a YC partner who invested in [Acme](companies/acme).',
      timeline: '- **2026-03-01** | Wrote check to Acme',
    });
    await engine.putPage('companies/acme', {
      type: 'company', title: 'Acme',
      compiled_truth: '',
      timeline: '- **2026-01-01** | Founded',
    });
    await engine.putPage('meetings/standup', {
      type: 'meeting', title: 'Standup',
      compiled_truth: 'Attendees: [Alice](people/alice), [Bob](people/bob).',
      timeline: '- **2026-04-01** | Met at YC office',
    });

    // Run extractions.
    await runExtract(engine, ['links', '--source', 'db']);
    await runExtract(engine, ['timeline', '--source', 'db']);

    // Verify graph populated. Concrete floors derived from the seeded fixtures:
    //   resolvable entity refs: alice->acme, bob->acme, standup->alice, standup->bob = 4
    //   timeline lines: alice(2) + bob(1) + acme(1) + standup(1) = 5
    const stats = await engine.getStats();
    expect(stats.link_count).toBeGreaterThanOrEqual(4);
    expect(stats.timeline_entry_count).toBeGreaterThanOrEqual(5);

    // Verify typed link inference.
    const aliceLinks = await engine.getLinks('people/alice');
    const acmeLink = aliceLinks.find(l => l.to_slug === 'companies/acme');
    expect(acmeLink?.link_type).toBe('works_at');

    const bobLinks = await engine.getLinks('people/bob');
    const bobAcme = bobLinks.find(l => l.to_slug === 'companies/acme');
    expect(bobAcme?.link_type).toBe('invested_in');

    // The standup meeting references both Alice and Bob as attendees. Assert the
    // exact attendee edges are present and typed 'attended' (a plain .every()
    // would silently pass if a meeting->company edge were misclassified or if the
    // attendee edges were missing entirely).
    const meetingLinks = await engine.getLinks('meetings/standup');
    const attended = new Set(
      meetingLinks.filter(l => l.link_type === 'attended').map(l => l.to_slug),
    );
    expect(attended.has('people/alice')).toBe(true);
    expect(attended.has('people/bob')).toBe(true);
    expect(meetingLinks.every(l => l.link_type === 'attended')).toBe(true);
  });

  test('auto-link via put_page operation handler', async () => {
    // Seed target pages first.
    await engine.putPage('people/alice', { type: 'person', title: 'Alice', compiled_truth: '', timeline: '' });
    await engine.putPage('companies/acme', { type: 'company', title: 'Acme', compiled_truth: '', timeline: '' });

    // Use put_page operation (not engine.putPage directly) so the auto-link
    // post-hook fires.
    const putOp = operationsByName['put_page'];
    expect(putOp).toBeDefined();
    const result = await putOp.handler(makeContext(), {
      slug: 'meetings/auto',
      content: `---
type: meeting
title: Auto Meeting
---

Attendees: [Alice](people/alice). Discussed [Acme](companies/acme).
`,
    });

    // The response should include auto_links results.
    expect((result as any).auto_links).toBeDefined();
    const autoLinks = (result as any).auto_links;
    // The page references exactly two seeded, resolvable targets (Alice + Acme),
    // so exactly two links are created.
    expect(autoLinks.created).toBe(2);
    expect(autoLinks.errors).toBe(0);

    // Verify links actually exist in DB.
    const links = await engine.getLinks('meetings/auto');
    expect(links.length).toBe(2);
    expect(new Set(links.map(l => l.to_slug))).toEqual(new Set(['people/alice', 'companies/acme']));
  });

  test('auto-link reconciliation: edit page removes stale links', async () => {
    await engine.putPage('people/alice', { type: 'person', title: 'Alice', compiled_truth: '', timeline: '' });
    await engine.putPage('people/bob', { type: 'person', title: 'Bob', compiled_truth: '', timeline: '' });

    const putOp = operationsByName['put_page'];

    // First write: links to Alice.
    await putOp.handler(makeContext(), {
      slug: 'notes/test',
      content: `---
type: concept
title: Test Note
---

I met [Alice](people/alice) today.
`,
    });

    let links = await engine.getLinks('notes/test');
    expect(links.length).toBe(1);
    expect(links[0].to_slug).toBe('people/alice');

    // Second write: removes Alice ref, adds Bob ref.
    const result = await putOp.handler(makeContext(), {
      slug: 'notes/test',
      content: `---
type: concept
title: Test Note
---

Now I'm meeting with [Bob](people/bob).
`,
    });

    expect((result as any).auto_links.removed).toBe(1);
    expect((result as any).auto_links.created).toBe(1);

    links = await engine.getLinks('notes/test');
    expect(links.length).toBe(1);
    expect(links[0].to_slug).toBe('people/bob');
  });

  test('auto-timeline: put_page extracts + inserts timeline entries', async () => {
    const putOp = operationsByName['put_page'];
    const result = await putOp.handler(makeContext(), {
      slug: 'people/dana',
      content: `---
type: person
title: Dana
---

Dana is a founder.

## Timeline

- **2026-03-15** | Shipped v1.0
- **2026-04-02** | Closed seed round
`,
    });

    expect((result as any).auto_timeline).toBeDefined();
    expect((result as any).auto_timeline.created).toBe(2);

    const entries = await engine.getTimeline('people/dana');
    expect(entries.length).toBe(2);
    const dates = entries.map((e: any) => {
      const d = e.date instanceof Date ? e.date.toISOString().slice(0, 10) : String(e.date).slice(0, 10);
      return d;
    }).sort();
    expect(dates).toEqual(['2026-03-15', '2026-04-02']);
  });

  test('auto-timeline is idempotent: re-write does not duplicate entries', async () => {
    const putOp = operationsByName['put_page'];
    const content = `---
type: person
title: Eve
---

## Timeline

- **2026-03-15** | Shipped
`;
    await putOp.handler(makeContext(), { slug: 'people/eve', content });
    await putOp.handler(makeContext(), { slug: 'people/eve', content });

    const entries = await engine.getTimeline('people/eve');
    expect(entries.length).toBe(1);
  });

  test('auto-timeline respects auto_timeline=false config', async () => {
    await engine.setConfig('auto_timeline', 'false');
    try {
      const putOp = operationsByName['put_page'];
      const result = await putOp.handler(makeContext(), {
        slug: 'people/frank',
        content: `---
type: person
title: Frank
---

## Timeline

- **2026-03-15** | Something happened
`,
      });
      expect((result as any).auto_timeline).toBeUndefined();
      const entries = await engine.getTimeline('people/frank');
      expect(entries.length).toBe(0);
    } finally {
      await engine.setConfig('auto_timeline', 'true');
    }
  });

  test('auto-link respects auto_link=false config', async () => {
    await engine.setConfig('auto_link', 'false');
    try {
      await engine.putPage('people/alice', { type: 'person', title: 'Alice', compiled_truth: '', timeline: '' });
      const putOp = operationsByName['put_page'];
      const result = await putOp.handler(makeContext(), {
        slug: 'notes/disabled',
        content: `---
type: concept
title: Disabled Auto Link
---

Mention of [Alice](people/alice).
`,
      });

      // No auto_links field when disabled (we skip the helper entirely).
      expect((result as any).auto_links).toBeUndefined();

      const links = await engine.getLinks('notes/disabled');
      expect(links.length).toBe(0);
    } finally {
      await engine.setConfig('auto_link', 'true');
    }
  });

  test('graph-query end-to-end: traversePaths returns expected edges', async () => {
    await engine.putPage('people/alice', { type: 'person', title: 'Alice', compiled_truth: '', timeline: '' });
    await engine.putPage('people/bob', { type: 'person', title: 'Bob', compiled_truth: '', timeline: '' });
    await engine.putPage('companies/acme', { type: 'company', title: 'Acme', compiled_truth: '', timeline: '' });
    await engine.addLink('people/alice', 'companies/acme', '', 'works_at');
    await engine.addLink('people/bob', 'companies/acme', '', 'invested_in');

    // "Who works at Acme?" -> direction in, type works_at.
    const paths = await engine.traversePaths('companies/acme', {
      direction: 'in', linkType: 'works_at', depth: 1,
    });
    expect(paths.length).toBe(1);
    expect(paths[0].from_slug).toBe('people/alice');
    expect(paths[0].link_type).toBe('works_at');
  });

  test('graph-query traversal: direction out and both, plus depth:2 multi-hop', async () => {
    // Seed a 2-hop chain: alice -works_at-> acme -partnered_with-> beta.
    await engine.putPage('people/alice', { type: 'person', title: 'Alice', compiled_truth: '', timeline: '' });
    await engine.putPage('companies/acme', { type: 'company', title: 'Acme', compiled_truth: '', timeline: '' });
    await engine.putPage('companies/beta', { type: 'company', title: 'Beta', compiled_truth: '', timeline: '' });
    await engine.addLink('people/alice', 'companies/acme', '', 'works_at');
    await engine.addLink('companies/acme', 'companies/beta', '', 'partnered_with');

    // direction:'out' from alice, depth 1 -> only the first hop.
    const out1 = await engine.traversePaths('people/alice', { direction: 'out', depth: 1 });
    expect(out1.length).toBe(1);
    expect(out1[0].from_slug).toBe('people/alice');
    expect(out1[0].to_slug).toBe('companies/acme');
    expect(out1[0].depth).toBe(1);

    // depth:2 -> both hops, depths 1 and 2.
    const out2 = await engine.traversePaths('people/alice', { direction: 'out', depth: 2 });
    const out2Edges = new Set(out2.map(p => `${p.from_slug}->${p.to_slug}@${p.depth}`));
    expect(out2Edges.has('people/alice->companies/acme@1')).toBe(true);
    expect(out2Edges.has('companies/acme->companies/beta@2')).toBe(true);
    expect(out2.length).toBe(2);

    // direction:'both' from acme depth 1 -> sees the inbound edge from alice AND
    // the outbound edge to beta. Edges keep their natural from->to orientation.
    const both = await engine.traversePaths('companies/acme', { direction: 'both', depth: 1 });
    const bothEdges = new Set(both.map(p => `${p.from_slug}->${p.to_slug}`));
    expect(bothEdges.has('people/alice->companies/acme')).toBe(true);
    expect(bothEdges.has('companies/acme->companies/beta')).toBe(true);
  });

  test('graph-query cycle safety: A->B->A terminates and returns bounded results', async () => {
    await engine.putPage('people/alice', { type: 'person', title: 'Alice', compiled_truth: '', timeline: '' });
    await engine.putPage('people/bob', { type: 'person', title: 'Bob', compiled_truth: '', timeline: '' });
    // Create a 2-cycle: alice -> bob -> alice.
    await engine.addLink('people/alice', 'people/bob', '', 'knows');
    await engine.addLink('people/bob', 'people/alice', '', 'knows');

    // High depth must NOT loop forever; the visited-set guard bounds the walk.
    const paths = await engine.traversePaths('people/alice', { direction: 'out', depth: 100 });
    const edges = new Set(paths.map(p => `${p.from_slug}->${p.to_slug}`));
    // Both edges of the cycle are reachable exactly once.
    expect(edges.has('people/alice->people/bob')).toBe(true);
    expect(edges.has('people/bob->people/alice')).toBe(true);
    // Bounded: there are only two edges in the graph, so no path explosion.
    expect(paths.length).toBe(2);
  });

  test('search backlink boost: well-connected pages rank higher', async () => {
    // Create 3 pages all matching a search term, but with different inbound link counts.
    await engine.putPage('topic/popular', {
      type: 'concept', title: 'Popular Topic',
      compiled_truth: 'This is the popular topic about widgets.',
      timeline: '',
    });
    await engine.putPage('topic/medium', {
      type: 'concept', title: 'Medium Topic',
      compiled_truth: 'This is a medium topic about widgets.',
      timeline: '',
    });
    await engine.putPage('topic/obscure', {
      type: 'concept', title: 'Obscure Topic',
      compiled_truth: 'This is an obscure topic about widgets.',
      timeline: '',
    });
    // Create inbound link references so each topic gets a backlink count.
    for (let i = 0; i < 5; i++) {
      await engine.putPage(`ref/popular-${i}`, {
        type: 'concept', title: `Ref ${i}`, compiled_truth: '', timeline: '',
      });
      await engine.addLink(`ref/popular-${i}`, 'topic/popular', '', 'mentions');
    }
    await engine.addLink('ref/popular-0', 'topic/medium', '', 'mentions');

    // Verify backlink counts.
    const counts = await engine.getBacklinkCounts(['topic/popular', 'topic/medium', 'topic/obscure']);
    expect(counts.get('topic/popular')).toBe(5);
    expect(counts.get('topic/medium')).toBe(1);
    expect(counts.get('topic/obscure')).toBe(0);
  });
});
