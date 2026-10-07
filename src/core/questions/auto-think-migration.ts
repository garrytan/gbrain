/**
 * dream.auto_think -> pinned questions (C4 migration). Maps all seven legacy
 * keys without creating consent the owner never gave:
 *
 *   dream.auto_think.questions      one pin per question (source `default`, no scope)
 *   dream.auto_think.enabled=false  pins import inactive (`migrated_disabled`)
 *   dream.auto_think.budget = 0     pins import inactive (`migrated_zero_budget`);
 *                                   a positive budget seeds cycle.standing_questions.budget_usd
 *   dream.auto_think.auto_commit    false (the default) keeps draft-only publishing
 *   dream.auto_think.cooldown_days  per-pin cooldown (default 30, as before)
 *   dream.auto_think.max_per_cycle  seeds cycle.standing_questions.max_per_cycle
 *   models.auto_think / dream.auto_think.model
 *                                   per-pin model
 * plus dream.auto_think.allow_unpriced -> cycle.standing_questions.allow_unpriced
 * and last_completion_ts as each pin's cooldown anchor.
 *
 * Reads config and inserts rows only: no provider call, no page write (the
 * owner's next local `gbrain questions` call or cycle materializes the
 * question pages). Re-running inserts nothing new (ON CONFLICT DO NOTHING on
 * the deterministic slug) and never overwrites a key the owner already set.
 */
import type { BrainEngine } from '../engine.ts';
import { MAX_QUESTION_CHARS, normalizeQuestion, questionSlug } from './identity.ts';

export const AUTO_THINK_KEYS = [
  'dream.auto_think.enabled', 'dream.auto_think.questions', 'dream.auto_think.max_per_cycle',
  'dream.auto_think.auto_commit', 'dream.auto_think.budget', 'dream.auto_think.cooldown_days',
  'dream.auto_think.model',
] as const;

/** Where each legacy key went; `gbrain config set|get` prints it for the old key. */
export const AUTO_THINK_REPLACEMENTS: Readonly<Record<string, string>> = {
  'dream.auto_think.enabled': 'gbrain questions pin "<question>" (CLI pins refresh; gbrain questions unpin <id> stops one)',
  'dream.auto_think.questions': 'gbrain questions pin "<question>" / gbrain questions list',
  'dream.auto_think.max_per_cycle': 'gbrain config set cycle.standing_questions.max_per_cycle <n>',
  'dream.auto_think.auto_commit': 'gbrain questions pin --id <id> --publish',
  'dream.auto_think.budget': 'gbrain config set cycle.standing_questions.budget_usd <usd>',
  'dream.auto_think.cooldown_days': 'gbrain config set cycle.standing_questions.cooldown_days <days>',
  'dream.auto_think.model': 'gbrain config set models.standing_questions <model>',
  'dream.auto_think.allow_unpriced': 'gbrain config set cycle.standing_questions.allow_unpriced true',
  'dream.auto_think.last_completion_ts': 'gbrain questions status <id> (last_refresh_at)',
  'models.auto_think': 'gbrain config set models.standing_questions <model>',
};

/** `gbrain config get|set` on a migrated dream.auto_think.* key names its pinned-questions replacement on stderr. */
export function noteAutoThinkReplacement(key: string): void {
  const replacement = AUTO_THINK_REPLACEMENTS[key];
  if (replacement) console.error(`[config] ${key} is replaced by pinned questions (docs/guides/pinned-questions.md): ${replacement}`);
}

export interface AutoThinkMigrationReport {
  questions: number;
  inserted: number;
  state: 'active' | 'inactive' | null;
  publish_mode: 'publish' | 'draft' | null;
  config_set: string[];
}

function finiteNumber(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

async function setIfUnset(engine: BrainEngine, key: string, value: string, set: string[]): Promise<void> {
  const current = await engine.getConfig(key);
  if (current !== null && current !== undefined && current !== '') return;
  await engine.setConfig(key, value);
  set.push(key);
}

export async function migrateAutoThinkToPins(engine: BrainEngine): Promise<AutoThinkMigrationReport> {
  const read = (key: string) => engine.getConfig(key).catch(() => null);
  const report: AutoThinkMigrationReport = { questions: 0, inserted: 0, state: null, publish_mode: null, config_set: [] };
  let questions: string[] = [];
  const rawQuestions = await read('dream.auto_think.questions');
  if (rawQuestions) {
    try {
      const parsed = JSON.parse(rawQuestions);
      if (Array.isArray(parsed)) questions = parsed.filter((q): q is string => typeof q === 'string');
    } catch { /* malformed list: nothing to import */ }
  }
  const bySlug = new Map<string, string>();
  for (const q of questions.map(normalizeQuestion)) {
    if (q.length === 0 || q.length > MAX_QUESTION_CHARS) continue;
    const slug = questionSlug(q, { source: 'default' });
    if (!bySlug.has(slug)) bySlug.set(slug, q);
  }
  questions = [...bySlug.values()];
  report.questions = questions.length;
  if (questions.length === 0) return report;

  const enabled = (await read('dream.auto_think.enabled')) === 'true';
  const budget = finiteNumber(await read('dream.auto_think.budget')) ?? 2.0;
  const autoCommit = (await read('dream.auto_think.auto_commit')) === 'true';
  const cooldown = Math.max(0, finiteNumber(await read('dream.auto_think.cooldown_days')) ?? 30);
  const model = (await read('models.auto_think')) || (await read('dream.auto_think.model')) || null;
  const lastCompletion = await read('dream.auto_think.last_completion_ts');
  const anchor = lastCompletion && Number.isFinite(Date.parse(lastCompletion)) ? new Date(Date.parse(lastCompletion)).toISOString() : null;
  const inactiveReason = !enabled ? 'migrated_disabled' : budget <= 0 ? 'migrated_zero_budget' : null;
  report.state = inactiveReason ? 'inactive' : 'active';
  report.publish_mode = autoCommit ? 'publish' : 'draft';

  for (const question of questions) {
    const slug = questionSlug(question, { source: 'default' });
    const rows = await engine.executeRaw<{ id: number }>(
      `INSERT INTO pinned_questions (source_id, slug, question, state, inactive_reason, publish_mode, model, cooldown_days,
         origin, created_by, last_attempt_at)
       VALUES ('default', $1, $2, $3, $4, $5, $6, $7, 'auto_think', 'migration:auto_think', $8::timestamptz)
       ON CONFLICT (source_id, slug) DO NOTHING RETURNING id`,
      [slug, question, report.state, inactiveReason, report.publish_mode, model, cooldown, anchor]);
    report.inserted += rows.length;
  }

  const maxPerCycle = finiteNumber(await read('dream.auto_think.max_per_cycle'));
  if (maxPerCycle !== null && maxPerCycle >= 1) await setIfUnset(engine, 'cycle.standing_questions.max_per_cycle', String(Math.floor(maxPerCycle)), report.config_set);
  if (budget > 0) await setIfUnset(engine, 'cycle.standing_questions.budget_usd', String(budget), report.config_set);
  if ((await read('dream.auto_think.allow_unpriced')) === 'true') {
    await setIfUnset(engine, 'cycle.standing_questions.allow_unpriced', 'true', report.config_set);
  }
  return report;
}
