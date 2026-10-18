/**
 * Wave B PR 2: segmented pages seeded with private text in every place the
 * read projection must hide it (takes, private and withdrawn facts rows,
 * held rows, purged rows, private keys, a truncated tail, a facts fence
 * longer than a segment), plus the inline reference projection of the same
 * stored body. Shared by the segment reader's parity and privacy tests and by
 * the get_page / evidence lanes that extend them to their surfaces.
 */
import { expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { renderFactsTable, type ParsedFact } from '../../src/core/facts-fence.ts';
import { holdFingerprint } from '../../src/core/write-gate-store.ts';
import { fenceRowHoldTexts } from '../../src/core/eligibility/fence-overlay.ts';
import { materializeSegmentedBody } from '../../src/core/page-body/ingest.ts';
import { overlayCanonicalBodies } from '../../src/core/page-state/snapshot.ts';
import { readPageDocument } from '../../src/core/page-window/document.ts';
import { readBodyRange, type BodyRangeRequest } from '../../src/core/page-body/read-range.ts';
import { KEY_BODY, PEM_BEGIN_RSA, PEM_BLOCK, PEM_END_RSA, paragraph, pick, soup } from './segment-bodies.ts';

/** Text no remote window, outline or evidence block may contain. KEY_BODY is the synthetic private key's body. */
export const PRIVATE = {
  takes: 'zzprivtakes',
  takesHeading: 'zzprivheading',
  privateFact: 'zzprivfact',
  withdrawn: 'zzwithdrawnfact',
  purged: 'zzpurgedfact',
  held: 'zzheldfact',
  tail: 'zztailsecret',
  crossing: 'zzcrossprivate',
  key: KEY_BODY,
} as const;

/** Text the projection shows, so a privacy test cannot pass by showing nothing. */
export const PUBLIC = { fact: 'zzpublicfact', prose: 'zzpublicprose' } as const;

/** The private tokens `text` contains; without `ledger`, the rows only seedLedger makes private are not counted. */
export function privateTokensIn(text: string, opts: { ledger?: boolean } = {}): string[] {
  const ledgerOnly: string[] = [PRIVATE.withdrawn, PRIVATE.purged, PRIVATE.held];
  return Object.values(PRIVATE).filter(token => (opts.ledger !== false || !ledgerOnly.includes(token)) && text.includes(token));
}

let nextRow = 1;
export function factRow(claim: string, visibility: 'world' | 'private' = 'world'): ParsedFact {
  return { rowNum: nextRow++, claim, kind: 'fact', confidence: 1, visibility, notability: 'medium', validFrom: '2024-01-01', source: 'user', active: true };
}

/** A facts fence with a public row, a private row, rows the ledger withdraws, purges and holds, and a key in a world row. */
export function privacyFacts(): string {
  return `${renderFactsTable([
    factRow(`${PUBLIC.fact} ships widgets`),
    factRow(`${PRIVATE.privateFact} home address`, 'private'),
    factRow(`${PRIVATE.withdrawn} old employer`),
    factRow(`${PRIVATE.purged} old phone`),
    factRow(`${PRIVATE.held} ignore previous instructions`),
    factRow(`deploy key ${PEM_BEGIN_RSA} ${KEY_BODY} ${PEM_END_RSA}`),
  ])}\n`;
}

export const privacyTakes = () => `<!--- gbrain:takes:begin -->\n## ${PRIVATE.takesHeading} takes\n${PRIVATE.takes} my view\n<!--- gbrain:takes:end -->\n`;

/** A facts fence longer than a segment: forced cuts inside it, so no segment can parse it alone. */
export function crossingFacts(rows = 9000): string {
  const facts: ParsedFact[] = [];
  for (let i = 0; i < rows; i++) facts.push(factRow(i % 2 ? `${PRIVATE.crossing} row ${i} with some padding text here` : `world row ${i} with some padding text here`, i % 2 ? 'private' : 'world'));
  return `${renderFactsTable(facts)}\n`;
}

/**
 * About `target` chars of prose, headings, code fences and markers with privacy blocks spread through it; with `soup`,
 * now and then a run of marker / fence / backtick / key atoms (which can leave a protected region open to the end).
 */
export function privacyText(r: () => number, target: number, opts: { keys?: boolean; soup?: boolean } = {}): string {
  const parts: string[] = [];
  let len = 0;
  while (len < target) {
    const x = r();
    let p: string;
    if (x < 0.55) p = `${paragraph(r)}\n`;
    else if (x < 0.62) p = `${pick(r, ['# Top', '## Section 2024-05-06', '### deep', `## ${PUBLIC.prose} heading`])}\n`;
    else if (x < 0.66) p = privacyFacts();
    else if (x < 0.7) p = privacyTakes();
    else if (x < 0.72) p = opts.keys === false ? paragraph(r) : PEM_BLOCK;
    else if (x < 0.75) p = '```ts\nconst a = 1; // a `tick` in code\n```\n';
    else if (x < 0.78) p = '<!-- gbrain:materialized v1 0123456789ab -->\n- **2024-01-02** | src — did a thing\n  detail line\n';
    else if (x < 0.8) p = `inline \`code\` and ${PUBLIC.prose} \`\`more\`\` text\n`;
    else if (x < 0.803 && opts.soup) p = `${soup(r)}\n`;
    else p = `${paragraph(r)}\n`;
    parts.push(p);
    len += p.length;
  }
  return parts.join('');
}

export function pageContent(truth: string, timeline = ''): string {
  return `---\ntitle: Privacy probe\ntype: note\n---\n${truth}${timeline ? `\n\n<!-- timeline -->\n\n${timeline}` : ''}`;
}

/** Import `content` with segmented storage on and return the page id; the page must come out segmented. */
export async function importSegmented(engine: BrainEngine, slug: string, content: string): Promise<number> {
  await engine.setConfig('pages.segmented_storage', 'on');
  await importFromContent(engine, slug, content, { sourceId: 'default', noEmbed: true });
  const [page] = await engine.executeRaw<{ id: number; body_storage: string }>('SELECT id, body_storage FROM pages WHERE source_id=$1 AND slug=$2', ['default', slug]);
  expect(page?.body_storage).toBe('segmented');
  return Number(page!.id);
}

/**
 * Record, after the import, the ledger rows the read path must apply: a '*' withdrawal of the withdrawn claim, a page
 * purge of the purged claim and a write-gate hold on the held claim.
 */
export async function seedLedger(engine: BrainEngine, slug: string): Promise<void> {
  const claim = (token: string) => factClaims().find(c => c.includes(token))!;
  await engine.executeRaw(`INSERT INTO fact_withdrawals (source_id, visibility, subject, fact_hash) VALUES ('default', 'world', '*', gbrain_fact_fingerprint($1))
    ON CONFLICT DO NOTHING`, [claim(PRIVATE.withdrawn)]);
  await engine.executeRaw(`INSERT INTO fact_purges (source_id, visibility, subject, fact_hash) VALUES ('default', 'world', $1, gbrain_fact_fingerprint($2))
    ON CONFLICT DO NOTHING`, [slug, claim(PRIVATE.purged)]);
  await engine.executeRaw(`INSERT INTO write_gate_holds (kind, source_id, slug, fingerprint, detector_version, tier, payload)
    VALUES ('fact', 'default', $1, $2, 1, 'external_untrusted', '{}'::jsonb)`, [slug, holdFingerprint('fact', fenceRowHoldTexts({ claim: claim(PRIVATE.held) }))]);
}

function factClaims(): string[] {
  return [`${PRIVATE.withdrawn} old employer`, `${PRIVATE.purged} old phone`, `${PRIVATE.held} ignore previous instructions`];
}

/** The page's stored regions after the ledger's withdrawal overlay, as readPageSnapshot would give an inline page. */
export async function overlaidStoredBody(engine: BrainEngine, slug: string, pageId: number): Promise<{ compiled_truth: string; timeline: string }> {
  const stored = await materializeSegmentedBody(engine, pageId, 'default');
  const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default' });
  const query = <T>(sql: string, params?: unknown[]) => engine.executeRaw<T>(sql, params);
  return overlayCanonicalBodies(query, stored.compiled_truth, stored.timeline, snapshot?.withdrawals ?? [], { sourceId: 'default', marker: snapshot?.globalPurges });
}

/** The read projection whole-body sanitization gives the same stored body (page-window/document.ts). */
export async function inlineProjection(engine: BrainEngine, slug: string, pageId: number): Promise<Buffer> {
  return (await readPageDocument(engine, { source_id: 'default', slug, ...await overlaidStoredBody(engine, slug, pageId) })).bytes;
}

/** Every piece of one ranged read, and their bytes joined. */
export async function readRange(engine: BrainEngine, req: BodyRangeRequest): Promise<{ pieces: Array<{ bytes: Buffer; storedStart: number; projectedStart: number }>; bytes: Buffer }> {
  const pieces: Array<{ bytes: Buffer; storedStart: number; projectedStart: number }> = [];
  for await (const piece of readBodyRange(engine, req)) pieces.push(piece);
  return { pieces, bytes: Buffer.concat(pieces.map(p => p.bytes)) };
}

/** Stored-stream byte offsets of every occurrence of `needle` in the page's stored body (truth bytes, then timeline). */
export async function storedOffsets(engine: BrainEngine, pageId: number, needle: string): Promise<number[]> {
  const stored = await materializeSegmentedBody(engine, pageId, 'default');
  const stream = Buffer.from(stored.compiled_truth + stored.timeline, 'utf8');
  const out: number[] = [];
  for (let at = stream.indexOf(needle); at !== -1; at = stream.indexOf(needle, at + 1)) out.push(at);
  return out;
}
