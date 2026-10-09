/**
 * ENG-21 drift guard (#5575): every fact, take or page writer in the write
 * attribution inventory (docs/architecture/system-of-record.md, pinned by
 * test/write-attribution-legacy.test.ts) either calls the write gate directly
 * or is declared exempt here with a reason. A new writer fails until it is
 * classified; an exemption for a writer that now calls the gate fails as stale.
 *
 * test-reads-source-ok[structural]: a source-text tripwire over the writer inventory, like the attribution inventory it extends.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const GATE = /\b(?:decideFactWrite|decideTakeWrite|assess(?:Page|Fact|Take|Timeline)ForGate|guardFenceRows)\s*\(|\bwriteGate\s*[:?]|\bgateInput\s*\(/;

/** Writers that never persist new attacker-controllable text, or reach the gate through a callee, with the reason. */
const EXEMPT: Record<string, string> = {
  'src/commands/extract-timeline-db.ts': 're-derives timeline rows from stored page text the page gate already assessed',
  'src/commands/migrate-engine.ts': 'copies rows verbatim between engines; tiers and receipts travel with them',
  'src/commands/sync/holds.ts': 'held-file bookkeeping; writes no content',
  'src/commands/sync/renames.ts': 'renames import through importFile, which passes the owner gate input (import-file.ts)',
  'src/core/calibration/undo-wave.ts': 'restores prior take lifecycle fields; no new text',
  'src/core/company-brain/profile.ts': 'company profile publication of an owner-approved company source (operator_curated, never gated)',
  'src/core/cycle/dream-provenance.ts': 'stamps provenance frontmatter; no new text',
  'src/core/cycle/drift.ts': 'adjusts take weights from evidence drift; no new text',
  'src/core/cycle/extract-atoms-page-state.ts': 'atom scan bookkeeping; no content',
  'src/core/cycle/grade-takes.ts': 'writes resolution fields on existing takes; no new claim text',
  'src/core/cycle/phantom-redirect.ts': 'slug redirect (placement only)',
  'src/core/embed-facts.ts': 'embedding columns only',
  'src/core/embedding-dim-check.ts': 'embedding columns only',
  'src/core/extract/receipt-writer.ts': 'gbrain-generated extraction receipt page (counts, cost, model id); no external text',
  'src/core/facts/derivation-inputs.ts': 'derivation edge ledger; ids only',
  'src/core/facts/forget.ts': 'withdrawal strike (lifecycle)',
  'src/core/facts/proposal-supersede.ts': 'checked supersede of existing rows (lifecycle)',
  'src/core/facts/purge.ts': 'purge deletes rows',
  'src/core/facts/relink-publish.ts': 'relinks existing facts to an entity (placement)',
  'src/core/facts/unfenced-facts.ts': 'repairs fence positions of existing rows',
  'src/core/facts/withdrawal.ts': 'withdrawal ledger and expiry (lifecycle)',
  'src/core/ops/extraction.ts': 'owner review of already-extracted rows (extraction_review)',
  'src/core/page-state/materialize.ts': 'writes stored timeline rows back into the page body; no new text',
  'src/core/page-state/rename-alias.ts': 'slug alias (placement only)',
  'src/core/page-state/versions.ts': 'page_versions snapshots copy the live row',
  'src/core/persistence/connector-google-receipts.ts': 'connector delivery receipts; the connector page publication is gated (connector-sync.ts)',
  'src/core/persistence/file-repair.ts': 'publishes an owner-reviewed repair preview of the owner source',
  'src/core/persistence/grandfather.ts': 'mechanical validate:false stamp under withTrustKeep',
  'src/core/persistence/links-maintenance.ts': 'link extraction from stored page text',
  'src/core/persistence/loop-fact-retirement.ts': 'expires a loop fact (lifecycle)',
  'src/core/persistence/memory-mutations.ts': 'forget (lifecycle); remember is gated in memory-prepare.ts',
  'src/core/repair/captured-facts.ts': 'owner repair of existing rows',
  'src/core/repair/extractor-facts.ts': 'owner repair of existing rows',
  'src/core/repair/frontmatter.ts': 'owner repair of existing frontmatter',
  'src/core/repair/ontology-facts.ts': 'owner repair restoring existing ontology rows',
  'src/core/repair/stale-atoms.ts': 'retires stale atoms (lifecycle)',
  'src/core/repair/take-supersession.ts': 'owner repair of take supersession pointers',
  'src/core/repair/timeline-comments.ts': 'owner repair of timeline comment markup',
  'src/core/schema-pack/page-to-alias.ts': 'schema-pack retype of existing pages',
  'src/core/schema-pack/page-to-link.ts': 'schema-pack retype of existing pages',
  'src/core/schema-pack/retype.ts': 'schema-pack retype of existing pages',
  'src/core/schema-pack/sync.ts': 'schema-pack sync of existing pages',
  'src/core/sweep.ts': 're-derives links and timeline rows from stored page text',
  'src/core/takes-write.ts': 'shared fence helpers; the takes_* verbs gate in takes-prepare.ts',
  'src/core/timeline-dedup-repair.ts': 'owner repair deduplicating existing timeline rows',
  'src/core/timeline-write-through.ts': 'rendering helpers for add_timeline_entry, which gates the row in semantic-pages.ts',
  'src/core/trust/owner-actions.ts': 'owner release publishes a held row the owner confirmed (CEO-9); the gate already held it',
  'src/core/trust/supersede-handlers.ts': 'owner accept/undo re-tiers existing rows inside the checked supersede',
  'src/core/repair/conversation-labels.ts': 'owner repair of existing conversation labels',
  'src/commands/extract-conversation-facts.ts': 'extracted rows go through insertDerivedFacts (persistence/derived-facts.ts), which gates them; its direct writes are gbrain audit outcome rows',
  'src/core/cycle/dream-taint.ts': 'the dream summary index page lists the run\'s output pages (gbrain-generated), stamped at their taint',
  'src/core/facts/fence-write.ts': 'callers decide the gate (backstop, loops-extract) and pass the decision; it records the flag receipt on the new row',
  'src/core/facts/write-single.ts': 'callers gate first (loops-extract decides; remember gates in memory-prepare); it records a passed decision\'s flag receipt',
  'src/core/output/writer.ts': 'gbrain integrity auto-repair (owner-run local CLI) rewrites citations and back-links of existing pages',
  'src/core/persistence/atom-maintenance.ts': 'pending: the managed atom page carries intent.derivation; the page gate runs in page-prepare once it reads that declaration',
  'src/core/persistence/prepared-maintenance.ts': 'consolidation takes gate in takes-prepare; pending: derived maintenance pages carry intent.derivation for the page-prepare gate',
  'src/core/think/index.ts': 'pending: the think --save page (quote-grounded synthesis, unverified claims moved to frontmatter) has no page gate seam on its direct putPage',
};

function inventory(): string[] {
  const doc = readFileSync(join(root, 'docs/architecture/system-of-record.md'), 'utf8');
  return ['write-attribution-covered', 'write-attribution-unattributed'].flatMap(marker => {
    const section = doc.split(`<!-- ${marker}:start -->`)[1]?.split(`<!-- ${marker}:end -->`)[0] ?? '';
    return [...section.matchAll(/^- `([^`]+)` \(\d+\)/gm)].map(m => m[1]!);
  });
}
const callsGate = (path: string) => GATE.test(readFileSync(join(root, path), 'utf8')
  .split('\n').filter(line => !/^\s*(?:\/\/|\/?\*)/.test(line)).join('\n'));

describe('write gate drift (ENG-21)', () => {
  test('every inventoried writer calls the gate or is exempt with a reason; no exemption is stale', () => {
    const writers = inventory();
    expect(writers.length).toBeGreaterThan(40);
    const unclassified = writers.filter(path => !callsGate(path) && !(path in EXEMPT));
    expect(unclassified, 'Gate the writer (write-gate.ts / write-gate-store.ts, or pass writeGate to importFromContent) or add it to EXEMPT with a reason.').toEqual([]);
    const stale = Object.keys(EXEMPT).filter(path => !writers.includes(path) || callsGate(path));
    expect(stale, 'These exemptions are stale: the writer left the inventory or now calls the gate.').toEqual([]);
    for (const reason of Object.values(EXEMPT)) expect(reason.length).toBeGreaterThan(10);
  });
});
