import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';

interface Review {
  id: number;
  fact: string;
  previous_run_id: string;
  slug: string;
  revision: string;
  quote: string;
  outcome: 'no_subject' | 'no_page';
  rationale: string;
}

function parseReviews(input: unknown): Review[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 50) throw new Error('Provide 1–50 fact reviews.');
  const ids = new Set<number>();
  for (const item of input) {
    if (!item || !Number.isSafeInteger(item.id) || item.id < 1 || ids.has(item.id) ||
        !['fact', 'previous_run_id', 'slug', 'revision', 'quote', 'rationale'].every(k =>
          typeof item[k] === 'string' && item[k].trim() && item[k].length <= 4096) ||
        (item.outcome !== 'no_subject' && item.outcome !== 'no_page')) {
      throw new Error('Every review needs a unique fact ID, previous run, exact source evidence, outcome, and rationale.');
    }
    ids.add(item.id);
  }
  return (input as Review[]).sort((a, b) => a.id - b.id);
}

/**
 * Replace a model memo with an explicit operator review. Its previous row and the
 * revision-bound evidence live in the append-only ingest log. Facts and pages
 * themselves are untouched; no inference, embedding, or access change occurs.
 */
export async function reviewRelinkMemos(engine: BrainEngine, source: string, input: unknown, expected?: string) {
  const items = parseReviews(input);
  const hash = createHash('sha256').update(JSON.stringify([source, items])).digest('hex');
  if (expected !== undefined && expected !== hash) throw new Error('The review differs from the preview.');
  const ref = `operator-review:${hash}`;

  return engine.transaction(async tx => {
    const rows = [];
    for (const item of items) {
      const [fact] = await tx.executeRaw<{ fact: string; source_session: string | null }>(
        `SELECT fact,source_session FROM facts WHERE source_id=$1 AND id=$2
          AND entity_slug IS NULL AND expired_at IS NULL FOR UPDATE`, [source, item.id]);
      if (fact?.fact !== item.fact || fact.source_session !== `put_page:${item.slug}`) throw new Error(`Fact ${item.id} no longer matches its origin.`);
      const [memo] = await tx.executeRaw<{ memo: Record<string, unknown> }>(
        'SELECT to_jsonb(a) AS memo FROM fact_relink_attempts a WHERE source_id=$1 AND fact_id=$2 FOR UPDATE', [source, item.id]);
      if (memo?.memo.run_id === ref && memo.memo.tier === 'operator') {
        rows.push({ id: item.id, outcome: item.outcome, replay: true });
        continue;
      }
      const [evidence] = await tx.executeRaw<{ quote_present: boolean }>(
        `SELECT strpos(compiled_truth,$4)>0 AS quote_present FROM pages
          WHERE source_id=$1 AND slug=$2 AND knowledge_revision::text=$3 AND deleted_at IS NULL FOR SHARE`,
        [source, item.slug, item.revision, item.quote]);
      if (!evidence?.quote_present) throw new Error(`Fact ${item.id} has no matching quote in the selected revision.`);
      if (memo?.memo.run_id !== item.previous_run_id || memo.memo.tier !== 'model') throw new Error(`The model memo for fact ${item.id} changed.`);
      if (expected !== undefined) {
        await tx.logIngest({ source_id: source, source_type: 'facts:relink-review', source_ref: ref,
          pages_updated: [], summary: JSON.stringify({ review: item, previous: memo.memo }) });
        await tx.executeRaw(`UPDATE fact_relink_attempts SET outcome=$3,reason=$3,tier='operator',model=NULL,
          target_slug=NULL,run_id=$4,attempted_at=now() WHERE source_id=$1 AND fact_id=$2`,
          [source, item.id, item.outcome, ref]);
      }
      rows.push({ id: item.id, outcome: item.outcome, replay: false });
    }
    return { status: expected === undefined ? 'preview' : 'committed', source_id: source, review_hash: hash, rows };
  });
}
