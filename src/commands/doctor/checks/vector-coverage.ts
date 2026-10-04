/**
 * fact_take_vectors (#5188, #5885): facts and takes are searched by vector
 * (dedup, consolidation, think, `takes search --semantic`), but chunk coverage
 * says nothing about them. Counts, per source, active facts and takes whose
 * vector is missing or was computed by another model, width or text than the
 * brain's configured embedding model, and names the recovery commands.
 *
 * Keyless brains (embedding_disabled) report "not applicable": nothing can
 * embed there, and keyword search keeps working.
 */
import { loadConfig } from '../../../core/config.ts';
import { AUDIT_ROW_SOURCES } from '../../../core/facts/audit-sources.ts';
import { eligibleFactEmbedding, staleFactEmbedding } from '../../../core/facts/embedding-identity.ts';
import { takesAutoEmbedEnabled } from '../../../core/embed-takes.ts';
import type { Check } from '../../doctor.ts';
import { agentFix } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';

export const VECTOR_COVERAGE_DOCS = 'docs/GBRAIN_VERIFY.md#5a-fact-and-take-vectors';

interface SourceVectors { source_id: string; facts_missing: number; facts_stale: number; takes_missing: number; takes_stale: number }

async function runFactTakeVectors(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];
  ctx.progress.heartbeat('fact_take_vectors');
  if (loadConfig()?.embedding_disabled === true || await engine.getConfig('embedding_disabled') === 'true') {
    checks.push({ name: 'fact_take_vectors', status: 'ok', message: 'Not applicable: embeddings are disabled on this brain (keyword search keeps working).',
      details: { applicable: false }, severity: 'info', readiness_state: 'disabled_by_choice' });
    return checks;
  }
  const model = await engine.getConfig('embedding_model');
  const dims = Number(await engine.getConfig('embedding_dimensions'));
  if (!model || !Number.isInteger(dims) || dims <= 0) {
    checks.push({ name: 'fact_take_vectors', status: 'warn', message: 'Fact and take vectors were not verified: the brain records no embedding model and width. Fix: gbrain migrate embeddings --status',
      details: { code: 'vectors_not_verified', applicable: true, fix: 'gbrain migrate embeddings --status', docs: VECTOR_COVERAGE_DOCS },
      fix: agentFix(['gbrain', 'migrate', 'embeddings', '--status'], 'Shows which embedding model and width this brain was built with, read-only.', 'fact_take_vectors', { docs: VECTOR_COVERAGE_DOCS }) });
    return checks;
  }
  try {
    const sources = (await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE NOT archived ORDER BY id'))
      .filter(s => !ctx.orphanRatioSourceId || s.id === ctx.orphanRatioSourceId);
    const factRows = await engine.executeRaw<{ source_id: string; missing: number; stale: number }>(
      `SELECT f.source_id, count(*) FILTER (WHERE f.embedding IS NULL)::int AS missing, count(*)::int AS stale
         FROM facts f WHERE ($1::text IS NULL OR f.source_id = $1) AND ${eligibleFactEmbedding} AND ${staleFactEmbedding}
        GROUP BY f.source_id`,
      [ctx.orphanRatioSourceId ?? null, [...AUDIT_ROW_SOURCES], model, dims]);
    const bySource: SourceVectors[] = [];
    for (const source of sources) {
      const fact = factRows.find(r => r.source_id === source.id);
      const takesStale = await engine.countStaleTakes({ model, dims, sourceId: source.id });
      const takesMissing = takesStale ? await engine.countStaleTakes({ sourceId: source.id }) : 0;
      const row = { source_id: source.id, facts_missing: Number(fact?.missing ?? 0), facts_stale: Number(fact?.stale ?? 0),
        takes_missing: takesMissing, takes_stale: takesStale };
      if (row.facts_stale || row.takes_stale) bySource.push(row);
    }
    const sum = (key: keyof Omit<SourceVectors, 'source_id'>) => bySource.reduce((n, r) => n + r[key], 0);
    const facts = { missing: sum('facts_missing'), other_model: sum('facts_stale') - sum('facts_missing'), stale: sum('facts_stale') };
    const takes = { missing_or_changed: sum('takes_missing'), other_model: sum('takes_stale') - sum('takes_missing'), stale: sum('takes_stale') };
    const takesFix = await takesAutoEmbedEnabled(engine) ? 'gbrain embed --stale' : 'gbrain takes embed';
    const factSources = bySource.filter(r => r.facts_stale).map(r => r.source_id);
    const fix = [
      ...(takes.stale ? [takesFix] : []),
      ...factSources.map(id => `gbrain embed --facts --stale --source ${id} --dry-run --json`),
    ];
    if (facts.stale === 0 && takes.stale === 0) {
      checks.push({ name: 'fact_take_vectors', status: 'ok', message: `Every active fact and take has a ${model} vector for its current text.`,
        details: { applicable: true, model, dims, facts, takes, by_source: [] } });
      return checks;
    }
    checks.push({
      name: 'fact_take_vectors',
      status: 'warn',
      message: `${facts.stale} active fact(s) and ${takes.stale} active take(s) have no ${model} (${dims}d) vector for their current text ` +
        `(facts: ${facts.missing} missing, ${facts.other_model} from another model or text; takes: ${takes.missing_or_changed} missing or claim changed, ${takes.other_model} from another model). ` +
        `Vector dedup, consolidation and semantic take search skip them. Fix: ${fix.join('; ')}`,
      details: { code: 'stale_vectors', applicable: true, model, dims, facts, takes, by_source: bySource,
        cause: 'facts and takes without a current-model vector', fix, docs: VECTOR_COVERAGE_DOCS },
      fix: factSources.length
        ? agentFix(['gbrain', 'embed', '--facts', '--stale', '--source', factSources[0], '--dry-run', '--json'],
          `Previews the fact re-embed for source '${factSources[0]}' (count and cost) without calling the provider; run it without --dry-run once the user approves the spend.`, 'fact_take_vectors', { docs: VECTOR_COVERAGE_DOCS })
        : agentFix(takesFix.split(' '), 'Embeds the takes that have no current-model vector; this calls the embedding provider.', 'fact_take_vectors', { consent: ['paid'], docs: VECTOR_COVERAGE_DOCS }),
    });
  } catch (err) {
    checks.push({ name: 'fact_take_vectors', status: 'warn',
      message: `Fact and take vectors were not verified: ${err instanceof Error ? err.message : String(err)}. Fix: gbrain migrate embeddings --status`,
      details: { code: 'vectors_not_verified', applicable: true, fix: 'gbrain migrate embeddings --status', docs: VECTOR_COVERAGE_DOCS },
      fix: agentFix(['gbrain', 'migrate', 'embeddings', '--status'], 'Shows which embedding model and width this brain was built with, read-only.', 'fact_take_vectors', { docs: VECTOR_COVERAGE_DOCS }) });
  }
  return checks;
}

export const factTakeVectorsEntry: DoctorEntry = { name: 'fact_take_vectors', emits: ['fact_take_vectors'], run: runFactTakeVectors };
