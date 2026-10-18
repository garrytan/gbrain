/**
 * `gbrain repair content-receipt-root [--source <id>]` (C-7, #6892): rebind a gbrain-owned content source's
 * shared-skills content receipt that still names an old root after a writer transfer or relocation an older release
 * ran (newer accepts and set-paths rebind it themselves, `shared-skills/receipt-root.ts`). Explicit-only and
 * preview-bound: the preview classifies every stale receipt and hashes the result; `--apply --expect <hash>`
 * recomputes it and refuses `preview_changed` unless it is unchanged.
 *
 * A receipt is rebound (class `rebind`) only on the owner host, when the owner binding's root (joined with the
 * source's relative_path) exists, is the source's local_path, and the owner's tree still hashes to the worktree
 * manifest the last transfer or rebind verified. Otherwise it is refused and listed with what to do first:
 * `not_owner_host`, `root_missing` (writer status), `source_path_mismatch` (`gbrain sources set-path`), or
 * `tree_mismatch` (a self-transfer on the owner host re-verifies the tree and rebinds the receipt in its accept).
 * The apply rewrites only the receipt's `root` and `root_identity`, keeps the previous value under
 * `<receipt key>.backup`, and skips a receipt that changed since the preview.
 */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { Action } from '../agent-output.ts';
import { OperationError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { localHostId } from '../persistence/identity.ts';
import { previewChangedError, previewHash } from '../persistence/preview-approval.ts';
import { storedManifestScope, worktreeManifest, type StoredWorktreeManifest } from '../persistence/worktree-manifest.ts';
import { staleOwnedContent } from '../shared-skills/content-freshness.ts';
import { ownedContentReceipt, rootIdentity } from '../shared-skills/receipt-root.ts';
import { afterCursor, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairPlan, type RepairScope } from './core.ts';

type Verdict = { source_id: string; class: 'rebind' | 'not_owner_host' | 'root_missing' | 'source_path_mismatch' | 'tree_mismatch'; detail: string; fix?: Action;
  key: string; raw: string; next?: { root: string; root_identity: { device: number; inode: number } } };
type ReceiptItem = RepairItem & { key: string; raw: string; next: NonNullable<Verdict['next']> };

const previewCommand = (scope: RepairScope) => `gbrain repair content-receipt-root${scope.source_ids.length === 1 ? ` --source ${scope.source_ids[0]}` : ''}`;
const statusFix = (sourceId: string) => readFix(`Shows source ${sourceId}'s owner host, binding root and worktree state, read-only.`,
  { argv: ['gbrain', 'sources', 'writer', 'status', '--source', sourceId, '--json'] });

function selfTransferFix(sourceId: string): Action {
  const intent = (phase: string) => ['--admin-intent', `writer_transfer_${phase}`, '--expected-state', '<admin_state>'];
  const inputs = [{ name: 'admin_state', how: `admin_state from gbrain sources writer status ${sourceId} --json on the owner host (read it again before the accept)` }];
  return { argv: ['gbrain', 'sources', 'writer', 'transfer', 'prepare', sourceId, '--self-transfer', ...intent('prepare')], inputs, consent: [], actor: 'host_admin', requires_exclusive: false,
    why: `Records the manifest of source ${sourceId}'s current tree on the owner host; the self-transfer accept then re-verifies the tree and rebinds the content receipt in the same transaction.`,
    then: { argv: ['gbrain', 'sources', 'writer', 'transfer', 'accept', sourceId, '--path', '<owner root>', '--expected-epoch', '<owner_epoch>', '--manifest', '<manifest digest printed by prepare>', '--self-transfer', ...intent('accept')],
      inputs: [...inputs, { name: 'owner root', how: 'the binding root writer status prints' }, { name: 'owner_epoch', how: 'the owner_epoch prepare printed' }],
      consent: [], actor: 'host_admin', requires_exclusive: false, why: 'Accepts the self-transfer: ownership stays on this host and the content receipt follows the verified root.' } };
}

async function verdicts(engine: Parameters<RepairHandler['plan']>[0], scope: RepairScope): Promise<Verdict[]> {
  const out: Verdict[] = [];
  for (const stale of await staleOwnedContent(engine, scope.source_ids)) {
    const [row] = await engine.executeRaw<{ incarnation: string; brain_id: string; key: string; value: string; owner_host_id: string; manifest: StoredWorktreeManifest | null; worktree_root: string; relative_path: string }>(
      `SELECT s.incarnation::text AS incarnation,p.brain_id,c.key,c.value,w.owner_host_id::text AS owner_host_id,w.manifest,h.local_path AS worktree_root,b.relative_path
         FROM sources s JOIN persistence_brain p ON p.singleton=1
         JOIN config c ON c.key='shared_skills.content.v1.'||s.id||'.'||s.incarnation::text
         JOIN persistence_source_bindings b ON b.source_id=s.id AND b.source_incarnation=s.incarnation
         JOIN persistence_worktrees w ON w.id=b.worktree_id
         JOIN persistence_host_bindings h ON h.worktree_id=w.id AND h.host_id=w.owner_host_id
        WHERE s.id=$1`, [stale.sourceId]);
    if (!row || !ownedContentReceipt(row.value, row.brain_id, stale.sourceId, row.incarnation)) continue;
    const base = { source_id: stale.sourceId, key: row.key, raw: row.value };
    const was = `the receipt names ${stale.receiptRoot ?? 'no root'}`;
    if (row.owner_host_id !== localHostId()) { out.push({ ...base, class: 'not_owner_host', detail: `${was}; run this repair on the owner host, which can read its root`, fix: statusFix(stale.sourceId) }); continue; }
    const next = rootIdentity(resolve(row.worktree_root, row.relative_path));
    if (!next) { out.push({ ...base, class: 'root_missing', detail: `${was}; the owner binding's root ${resolve(row.worktree_root, row.relative_path)} cannot be read`, fix: statusFix(stale.sourceId) }); continue; }
    if (rootIdentity(stale.localPath)?.root !== next.root) {
      out.push({ ...base, class: 'source_path_mismatch', detail: `${was}; the source's local_path is ${stale.localPath} but its owner binding is at ${next.root}; move the source there first`,
        fix: { argv: ['gbrain', 'sources', 'set-path', stale.sourceId, next.root], consent: [], actor: 'host_admin', requires_exclusive: false,
          why: `Moves source ${stale.sourceId}'s local_path to its owner binding's root after verifying the bytes; the rebind also rebinds the content receipt.` } });
      continue;
    }
    const recorded = row.manifest?.digest ?? null;
    const actual = worktreeManifest(row.worktree_root, { scope: storedManifestScope(row.manifest) }).digest;
    if (recorded !== actual) {
      out.push({ ...base, class: 'tree_mismatch', fix: selfTransferFix(stale.sourceId),
        detail: `${was}; the owner's tree at ${row.worktree_root} hashes to ${actual} but the recorded worktree manifest is ${recorded ?? 'missing'}, so it is not proven to be the transferred content` });
      continue;
    }
    out.push({ ...base, class: 'rebind', next, detail: `${was}; rebind it to ${next.root} (device ${next.root_identity.device}, inode ${next.root_identity.inode}), whose tree matches manifest ${actual}` });
  }
  return out;
}

export const contentReceiptRootRepair: RepairHandler = {
  kind: 'content-receipt-root',
  publication: 'projection',
  embeds: false,
  async plan(engine, scope, after, opts): Promise<RepairPlan> {
    const command = previewCommand(scope);
    const found = await verdicts(engine, scope);
    const hash = previewHash({ kind: 'content-receipt-root-v1', brain_id: scope.brain_id, selection: scope.source_ids,
      verdicts: found.map(v => [v.source_id, v.class, createHash('sha256').update(v.raw).digest('hex'), v.next ?? null]) });
    if (opts?.apply && !opts.expect) {
      throw new OperationError('invalid_params', 'gbrain repair content-receipt-root --apply rebinds only the set a preview printed.',
        `Preview first: ${command} — then run the apply command it prints: ${command} --apply --expect <preview-hash>`, 'docs/guides/repair.md#content-receipt-root');
    }
    if (opts?.apply && opts.expect !== hash) throw previewChangedError(opts.expect!, command);
    const items: ReceiptItem[] = found.filter(v => v.class === 'rebind').map((v, index) => ({ cursor: { phase: 0, id: index + 1 }, source_id: v.source_id, slug: v.source_id, chars: 0,
      action: 'rebind_receipt', change: { from: v.raw, to: JSON.stringify(v.next) }, key: v.key, raw: v.raw, next: v.next! }));
    const refused = found.filter(v => v.class !== 'rebind');
    const residuals: Record<string, number> = {};
    for (const v of refused) residuals[v.class] = (residuals[v.class] ?? 0) + 1;
    return { items: items.filter(item => afterCursor(item.cursor, after)), preview_hash: hash, residuals,
      listing: found.map(v => ({ item: v.source_id, class: v.class, detail: v.detail })),
      details: { refused: refused.map(v => ({ source_id: v.source_id, class: v.class, detail: v.detail, fix: v.fix })) } };
  },
  async apply(ctx, entry): Promise<RepairItemOutcome> {
    const { key, raw, next, source_id } = entry as ReceiptItem;
    return ctx.engine.transaction(async tx => {
      const [row] = await tx.executeRaw<{ value: string }>('SELECT value FROM config WHERE key=$1 FOR UPDATE', [key]);
      if (row?.value !== raw) return { applied: false, outcome: 'kept', reason: 'changed_since_preview' };
      const now = rootIdentity(next.root);
      if (now?.root_identity.device !== next.root_identity.device || now.root_identity.inode !== next.root_identity.inode) return { applied: false, outcome: 'kept', reason: 'root_changed_since_preview' };
      const backup = `${key}.backup`;
      await tx.executeRaw('INSERT INTO config(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value',
        [backup, JSON.stringify({ previous: raw, replaced_at: new Date().toISOString(), source_id })]);
      await tx.executeRaw('UPDATE config SET value=$2 WHERE key=$1', [key, JSON.stringify({ ...JSON.parse(raw), ...next })]);
      return { applied: true, outcome: 'rebound', detail: { from: (JSON.parse(raw) as { root?: unknown }).root ?? null, to: next.root, backup_key: backup } };
    });
  },
  render(details) {
    const refused = (details.refused ?? []) as Array<{ source_id: string; class: string; detail: string; fix?: Action }>;
    return refused.map(row => `refused ${row.source_id} (${row.class}): ${row.detail}${row.fix?.argv ? `; next: ${row.fix.argv.join(' ')}` : ''}`);
  },
};
