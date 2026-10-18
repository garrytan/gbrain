/**
 * `gbrain repair missing-tables` (#6911): recreate, empty, a rebuildable cache table that the applied migrations
 * created but the brain no longer has (`doctor` check schema_missing_tables). The schema version already covers its
 * creating migration, so `apply-migrations` never runs it again, and a later migration that touches the cache fails
 * with 42P01. Only tables the graduation inventory classifies `rebuild` and that have a recreate step qualify; any
 * other missing table is listed for the operator, never recreated here.
 *
 * Explicit-only and preview-bound: the preview prints the tables and a hash, and `--apply --expect <hash>` recreates
 * exactly that set once; the approval is retired with the last table. It never runs on upgrade, apply-migrations,
 * db-repair or the maintenance cycle. DDL only (IF NOT EXISTS) under the migration lock timeout; no journal admission
 * and no user data changes. Brain-wide.
 */
import { LATEST_VERSION } from '../migrate.ts';
import { OperationError } from '../ops/contract.ts';
import { resolveSchemaLockTimeoutMs, schemaLockBlockedError } from '../postgres-engine/schema-lock-timeout.ts';
import { clearApprovedSet, loadApprovedSet, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { relationExists } from '../persistence/rebuildable-cache.ts';
import { isLockTimeoutError } from '../retry-matcher.ts';
import { readMissingTables, recreateStep } from '../schema-missing-tables.ts';
import { afterCursor, type RepairHandler, type RepairItem, type RepairPlan } from './core.ts';
import { classifyOriginUniqueViolation } from '../persistence/origin-guard.ts';

const PREVIEW = 'gbrain repair missing-tables';
const DOCS = 'docs/guides/repair.md#missing-tables';
type TableItem = RepairItem & { hash?: string; last?: boolean };
const toItem = (table: string, position: number, hash?: string, last?: boolean): TableItem => ({ cursor: { phase: 0, id: position + 1 }, source_id: '(brain)',
  slug: table, chars: 0, action: 'recreate_empty', ...(hash ? { hash, last } : {}) });
const CLIENT_BEHIND = (version: number) => `The brain schema is at v${version}, newer than this gbrain client (v${LATEST_VERSION}); upgrade gbrain, then preview again.`;

export const missingTablesRepair: RepairHandler = {
  kind: 'missing-tables',
  publication: 'projection',
  embeds: false,
  async plan(engine, scope, after, opts = { apply: false }): Promise<RepairPlan> {
    const report = await readMissingTables(engine);
    if (opts.apply) {
      if (!opts.expect) throw new OperationError('invalid_params', 'gbrain repair missing-tables --apply needs the preview hash.',
        `Preview first: ${PREVIEW} — then run the apply command it prints: ${PREVIEW} --apply --expect <preview-hash>`, DOCS);
      if (report.status === 'skipped') throw new OperationError('invalid_params', CLIENT_BEHIND(report.version), `Upgrade gbrain, then run ${PREVIEW} again.`, DOCS);
      const { items: tables } = await loadApprovedSet<string>(engine, { command: 'missing-tables', hash: opts.expect, previewCommand: PREVIEW });
      const items = tables.map((table, index) => toItem(table, index, opts.expect, index === tables.length - 1)).filter(item => afterCursor(item.cursor, after));
      if (!items.length) await clearApprovedSet(engine, { command: 'missing-tables', hash: opts.expect });
      return { items, preview_hash: opts.expect, residuals: {} };
    }
    if (report.status === 'skipped') return { items: [], residuals: {}, warnings: [CLIENT_BEHIND(report.version)] };
    const tables = report.missing.filter(m => m.recreatable).map(m => m.table);
    const userData = report.missing.filter(m => !m.recreatable && m.loss_kind === 'user_data').map(m => m.table);
    const other = report.missing.filter(m => !m.recreatable && m.loss_kind !== 'user_data').map(m => m.table);
    const hash = previewHash({ kind: 'missing-tables-v1', brain_id: scope.brain_id, latest: LATEST_VERSION, tables });
    if (tables.length) await saveApprovedSet<string>(engine, { command: 'missing-tables', hash }, tables);
    return { items: tables.map((table, index) => toItem(table, index)), ...(tables.length ? { preview_hash: hash } : {}),
      residuals: { ...(userData.length ? { user_data_tables: userData.length } : {}), ...(other.length ? { other_tables: other.length } : {}) },
      details: { checked: report.checked, scope: report.scope, recreate: tables, user_data_tables: userData, other_tables: other } };
  },
  async apply(ctx, entry, opts) {
    const item = entry as TableItem;
    const outcome = await (async () => {
      const recreate = recreateStep(item.slug);
      if (!recreate) return { applied: false, outcome: 'refused', reason: 'not_rebuildable' } as const;
      if (await relationExists(ctx.engine, item.slug)) return { applied: false, outcome: 'already_present' } as const;
      try {
        await ctx.engine.transaction(async tx => {
          if (ctx.engine.kind === 'postgres') {
            await tx.executeRaw("SET LOCAL statement_timeout = '600000'");
            await tx.executeRaw(`SET LOCAL lock_timeout = '${resolveSchemaLockTimeoutMs()}ms'`);
          }
          await recreate(tx);
        });
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === '42501') {
          throw new OperationError('schema_owner_required', `This database role may not create ${item.slug}, so nothing was recreated.`,
            `Connect as the role that owns the brain tables (the one apply-migrations uses) and run: ${PREVIEW} --apply --expect ${opts?.expect ?? '<preview-hash>'}`, DOCS);
        }
        if ((code === '23505' && !classifyOriginUniqueViolation(error) || code === '42P07') && await relationExists(ctx.engine, item.slug)) return { applied: false, outcome: 'already_present' };
        if (ctx.engine.kind === 'postgres' && isLockTimeoutError(error)) {
          throw schemaLockBlockedError({ step: `repair missing-tables (${item.slug})`, timeoutMs: resolveSchemaLockTimeoutMs(), sessions: null, sampledDuringWait: false });
        }
        throw error;
      }
      if (!await relationExists(ctx.engine, item.slug)) {
        throw new OperationError('storage_error', `Recreating ${item.slug} ran, but the table still does not exist.`,
          'Run gbrain doctor --json and report the schema_missing_tables entry.');
      }
      return { applied: true, outcome: 'recreated' };
    })();
    if (item.last && item.hash) await clearApprovedSet(ctx.engine, { command: 'missing-tables', hash: item.hash });
    return outcome;
  },
  render(details) {
    const d = details as { checked?: number; recreate?: string[]; user_data_tables?: string[]; other_tables?: string[] };
    return [
      `  ${d.checked ?? 0} expected table(s) checked`,
      ...(d.recreate ?? []).map(t => `  recreate empty: ${t} (rebuildable cache; it refills on use)`),
      ...(d.user_data_tables ?? []).map(t => `  not recreated: ${t} holds user data; restore its rows from a backup before any upgrade or migrate run (${DOCS})`),
      ...(d.other_tables ?? []).map(t => `  not recreated: ${t} holds no user data; gbrain init --migrate-only recreates it if the base schema defines it`),
    ];
  },
};
