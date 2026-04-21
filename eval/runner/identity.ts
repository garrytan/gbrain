/**
 * BrainBench Category 3: Identity Resolution.
 *
 * Tests whether gbrain can resolve aliases ("Sarah Chen", "S. Chen", "@schen",
 * "sarah.chen@example.com") to one canonical entity.
 *
 * gbrain currently has NO alias table. The benchmark measures what's possible
 * with searchKeyword (tsvector) + slug-based getPage. Numbers will be honest:
 * documented aliases (in canonical body) findable; undocumented not.
 *
 * The point is to surface the gap. A good v1 number on undocumented aliases
 * would mean we have an alias table; a poor number proves we should build one.
 *
 * Usage: bun run eval/runner/identity.ts [--json]
 */

import { PGLiteEngine } from '../../src/core/pglite-engine.ts';

interface Entity {
  canonicalSlug: string;
  fullName: string;
  /** Aliases mentioned IN the canonical page body (should be keyword-findable). */
  documentedAliases: string[];
  /** Aliases that exist (handles, emails, typos) but are NOT in any page. */
  undocumentedAliases: string[];
}

const FIRST_NAMES = ['Sarah', 'Alice', 'Bob', 'Carol', 'David', 'Eve', 'Frank', 'Grace', 'Henry', 'Iris', 'Jack', 'Kate', 'Liam', 'Mia', 'Noah', 'Olivia', 'Paul', 'Quinn', 'Rachel', 'Sam'];
const LAST_NAMES = ['Chen', 'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson'];
const COMPANIES = ['stripe.com', 'acme.io', 'beta.co', 'gamma.dev', 'delta.ai'];

function generateEntities(n: number): Entity[] {
  const entities: Entity[] = [];
  for (let i = 0; i < n; i++) {
    const first = FIRST_NAMES[i % FIRST_NAMES.length];
    const last = LAST_NAMES[Math.floor(i / FIRST_NAMES.length) % LAST_NAMES.length];
    const fullName = `${first} ${last}`;
    const handle = `@${first[0].toLowerCase()}${last.toLowerCase()}`;
    const email = `${first.toLowerCase()}.${last.toLowerCase()}@${COMPANIES[i % COMPANIES.length]}`;
    const initial = `${first[0]}. ${last}`;
    const noSpace = `${first[0]} ${last}`;
    const typo1 = `${first.slice(0, -1)}${first[first.length - 1]}${first[first.length - 1]} ${last}`;
    const typo2 = `${first} ${last}n`;
    const handlePlain = handle.slice(1);

    entities.push({
      canonicalSlug: `people/${first.toLowerCase()}-${last.toLowerCase()}-${i}`,
      fullName,
      documentedAliases: [fullName, handle, email],
      undocumentedAliases: [initial, noSpace, typo1, typo2, handlePlain],
    });
  }
  return entities;
}

interface QueryResult {
  alias: string;
  canonicalSlug: string;
  category: 'documented' | 'undocumented';
  found: boolean;
  rankPosition: number; // 1-indexed; 0 = not in top-10
}

async function main() {
  const json = process.argv.includes('--json');
  const log = json ? () => {} : console.log;

  log('# BrainBench Category 3: Identity Resolution\n');
  log(`Generated: ${new Date().toISOString().slice(0, 19)}`);

  const entities = generateEntities(100);
  log(`Entities: ${entities.length}`);
  log(`Aliases per entity: ${entities[0].documentedAliases.length} documented + ${entities[0].undocumentedAliases.length} undocumented = ${entities[0].documentedAliases.length + entities[0].undocumentedAliases.length} total`);

  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  // Seed canonical pages. Each page mentions the entity by full name + handle + email.
  for (const e of entities) {
    await engine.putPage(e.canonicalSlug, {
      type: 'person',
      title: e.fullName,
      compiled_truth: `${e.fullName} (also known as ${e.documentedAliases.slice(1).join(', ')}) is a person in our network. Reach them at ${e.documentedAliases[2]}.`,
      timeline: '',
    });
    // Also chunk for searchKeyword.
    await engine.upsertChunks(e.canonicalSlug, [
      { chunk_index: 0, chunk_text: `${e.fullName} ${e.documentedAliases.join(' ')}`, chunk_source: 'compiled_truth' },
    ]);
  }

  // Run queries.
  const results: QueryResult[] = [];
  for (const e of entities) {
    for (const cat of ['documented', 'undocumented'] as const) {
      const aliases = cat === 'documented' ? e.documentedAliases : e.undocumentedAliases;
      for (const alias of aliases) {
        const r = await engine.searchKeyword(alias, { limit: 10 });
        // Page-level dedup, keep highest score per slug
        const seen = new Set<string>();
        const pages = r.filter(x => { if (seen.has(x.slug)) return false; seen.add(x.slug); return true; });
        const idx = pages.findIndex(x => x.slug === e.canonicalSlug);
        results.push({
          alias,
          canonicalSlug: e.canonicalSlug,
          category: cat,
          found: idx >= 0,
          rankPosition: idx + 1, // 0 if not found
        });
      }
    }
  }

  await engine.disconnect();

  // ── Metrics ──
  const documented = results.filter(r => r.category === 'documented');
  const undocumented = results.filter(r => r.category === 'undocumented');
  const docRecall = documented.filter(r => r.found).length / documented.length;
  const undocRecall = undocumented.filter(r => r.found).length / undocumented.length;
  const docMrr = documented.reduce((s, r) => s + (r.found ? 1 / r.rankPosition : 0), 0) / documented.length;
  const undocMrr = undocumented.reduce((s, r) => s + (r.found ? 1 / r.rankPosition : 0), 0) / undocumented.length;

  log('\n## Metrics');
  log('| Alias category   | Recall (top-10) | MRR    |');
  log('|------------------|-----------------|--------|');
  log(`| Documented       | ${(docRecall * 100).toFixed(1)}%             | ${docMrr.toFixed(3)}  |`);
  log(`| Undocumented     | ${(undocRecall * 100).toFixed(1)}%             | ${undocMrr.toFixed(3)}  |`);

  log('\n## Per-alias-type breakdown (documented)');
  const docByType: Record<string, { found: number; total: number }> = {};
  for (const r of documented) {
    const type = r.alias.startsWith('@') ? 'handle' : r.alias.includes('@') ? 'email' : 'fullname';
    docByType[type] ??= { found: 0, total: 0 };
    docByType[type].total++;
    if (r.found) docByType[type].found++;
  }
  for (const [type, { found, total }] of Object.entries(docByType)) {
    log(`  ${type.padEnd(10)} ${found}/${total} = ${((found / total) * 100).toFixed(1)}%`);
  }

  log('\n## Per-alias-type breakdown (undocumented)');
  const undocByType: Record<string, { found: number; total: number }> = {};
  for (const r of undocumented) {
    let type: string;
    if (r.alias.match(/^[A-Z]\. /)) type = 'initial';
    else if (r.alias.match(/^[A-Z] /)) type = 'no-period';
    else if (r.alias.match(/[A-Z][a-z]+n$/)) type = 'typo';
    else if (r.alias.match(/[a-z][a-z]+ /)) type = 'typo';
    else type = 'handle-plain';
    undocByType[type] ??= { found: 0, total: 0 };
    undocByType[type].total++;
    if (r.found) undocByType[type].found++;
  }
  for (const [type, { found, total }] of Object.entries(undocByType)) {
    log(`  ${type.padEnd(13)} ${found}/${total} = ${((found / total) * 100).toFixed(1)}%`);
  }

  log('\n## Interpretation');
  log('Documented aliases (full name, handle, email mentioned in canonical body):');
  log(`  Recall ${(docRecall * 100).toFixed(1)}% — what current gbrain can do via tsvector keyword match.`);
  log('Undocumented aliases (initials, typos, handle without @):');
  log(`  Recall ${(undocRecall * 100).toFixed(1)}% — what current gbrain CAN'T do without an alias table.`);
  log('');
  log('Gap: gbrain has no alias table, no fuzzy match, no nickname dictionary.');
  log('Suggested v0.11 feature: explicit aliases + Levenshtein/phonetic match.');

  if (json) {
    process.stdout.write(JSON.stringify({
      results,
      summary: { docRecall, undocRecall, docMrr, undocMrr, docByType, undocByType },
    }, null, 2) + '\n');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
