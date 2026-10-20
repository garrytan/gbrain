/**
 * commit_notifier (GBRA-133 PR 2a): names the resident that syncs each local source on commit (gbrain serve, gbrain jobs
 * work or the autopilot daemon; one owns the notifier per host), or says none is running with the fix. With
 * `sync.on_commit` on, a source no resident watches warns, and a stalled notifier (`notifier_stalled`,
 * `operator_blocked`) warns with the foreground sync that shows the error. With it off, a source with a pending sync
 * request and no resident warns (the request waits for a resident); otherwise the check is informational. Reader:
 * src/core/notifier/status.ts (the same block `gbrain sync status` prints). Database reads only; no git call.
 */
import type { Check } from '../../doctor.ts';
import { connectedEngine, doctorSourceIds, type DoctorContext, type DoctorEntry } from '../context.ts';
import { checkError } from '../check-fix.ts';
import { loadAllSources, parseSourceConfig } from '../../../core/sources-load.ts';
import { isConnectorSourceKind } from '../../../core/persistence/connector-identity.ts';
import { parseOnCommit } from '../../../core/commit-notifier.ts';
import { SYNC_ON_COMMIT_KEY } from '../../../core/sync-config-keys.ts';
import { formatNotifierBlock, readNotifierBlock, type NotifierBlock } from '../../../core/notifier/status.ts';

const DOCS = 'docs/guides/on-commit-sync.md';

async function runCommitNotifierCheck(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  try {
    const engine = connectedEngine(ctx);
    const scope = doctorSourceIds(ctx);
    const sources = (await loadAllSources(engine)).filter(s => !s.archived && s.local_path && !isConnectorSourceKind(parseSourceConfig(s.config).kind)
      && (!scope || scope.includes(s.id)));
    if (!sources.length) {
      checks.push({ name: 'commit_notifier', status: 'ok', message: 'No local source to watch for commits.' });
      return checks;
    }
    const onCommit = parseOnCommit(await engine.getConfig(SYNC_ON_COMMIT_KEY));
    const blocks: Array<{ id: string; block: NotifierBlock | null }> = [];
    for (const s of sources) blocks.push({ id: s.id, block: await readNotifierBlock(engine, s.id, { remote: ctx.sourceIds !== undefined }) });
    const needsAttention = blocks.filter(({ block }) => block && (block.stalled || (!block.resident && (onCommit || block.pending_markers.length > 0))));
    const details = { sync_on_commit: onCommit, docs: DOCS, sources: blocks.map(({ id, block }) => ({ source_id: id, resident: block?.resident?.kind ?? null,
      state: block?.state ?? null, reason: block?.reason ?? null, stalled: block?.stalled ?? false, pending_markers: block?.pending_markers.length ?? 0 })) };
    const lines = blocks.map(({ id, block }) => block ? formatNotifierBlock(id, { ...block, fix: null }) : `notifier for ${id}: not observed yet`);
    if (needsAttention.length) {
      const first = needsAttention[0]!;
      checks.push({ name: 'commit_notifier', status: 'warn', details, ...(first.block?.fix ? { fix: first.block.fix } : {}),
        message: `${needsAttention.map(({ id, block }) => formatNotifierBlock(id, block!)).join('; ')}.` });
      return checks;
    }
    checks.push({ name: 'commit_notifier', status: 'ok', severity: 'info', details,
      message: `${onCommit ? '' : 'sync.on_commit is off; residents still run explicit sync requests. '}${lines.join('; ')}.` });
  } catch (error) {
    checks.push(checkError('commit_notifier', 'read the commit notifier state', error, { details: { health: 'unknown', docs: DOCS } }));
  }
  return checks;
}

export const commitNotifierEntry: DoctorEntry = { name: 'commit_notifier', emits: ['commit_notifier'], run: runCommitNotifierCheck };
