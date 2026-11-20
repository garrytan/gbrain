/**
 * GBRA-218 (A2): `access_policy_pending`, the notice on a remote read while some
 * source this connection reads has folder prefixes that read as nobody (a
 * narrowing still being stamped, or a policy file that does not validate).
 * The empty or short answer is then not proof the brain holds nothing there.
 * Names only sources inside the caller's read scope; the first step is to wait
 * and check again, then the brain host finishes or fixes it.
 */
import type { Notice } from '../agent-output.ts';
import type { OperationContext } from '../ops/contract.ts';
import { federatedSearchScope } from '../ops/context.ts';
import { hostFix } from '../ops/op-fix.ts';
import { currentCallerAccess } from '../search/private-visibility.ts';

const READ_OPS: ReadonlySet<string> = new Set(['search', 'query', 'recall', 'list_pages', 'get_page', 'fetch', 'get_links', 'get_backlinks', 'traverse_graph', 'resolve_slugs', 'get_timeline']);

export function accessPolicyNotices(op: string, ctx: OperationContext): Notice[] {
  if (ctx.remote === false || !READ_OPS.has(op)) return [];
  return [...readSharedNotices(ctx), ...folderPolicyNotices(ctx)];
}

/**
 * GST-2898: the credential's read-shared switch is on but the shared set could not be read at verification, so this
 * call read the credential's stored sources only. Never a silent narrowing.
 */
function readSharedNotices(ctx: OperationContext): Notice[] {
  if (ctx.auth?.readSharedUnresolved !== true) return [];
  return [{
    code: 'read_shared_unresolved',
    kind: 'degraded',
    why: 'This connection reads every shared source, but the list of shared sources could not be read, so this answer comes from its own listed sources only. '
      + 'A missing page is not proof the brain has nothing on it. Tell the user; the brain host checks the database (command in fix).',
    fix: { argv: ['gbrain', 'doctor', '--json'], consent: [], actor: 'host_admin', requires_exclusive: false,
      why: 'Read-only: reports why the sources table could not be read on the brain host.' },
  }];
}

function folderPolicyNotices(ctx: OperationContext): Notice[] {
  const coverage = currentCallerAccess().folderCoverage;
  if (!coverage.length) return [];
  try {
    const scope = federatedSearchScope(ctx);
    const readable = scope.sourceIds ?? (scope.sourceId !== undefined ? [scope.sourceId] : []);
    const sources = [...new Set(coverage.map(c => c.source_id))].filter(s => readable.includes(s)).sort();
    if (!sources.length) return [];
    const source = sources[0]!;
    return [{
      code: 'access_policy_pending',
      kind: 'degraded',
      why: `Folder rules of source ${sources.join(', ')} are being applied (or its policy file does not validate), so pages under the affected folders read as nobody for now. `
        + 'A missing page there is not proof the brain has nothing on it. Retry in a minute; if it stays this way, the brain host finishes it (command in fix).',
      fix: {
        argv: ['gbrain', 'access', 'rule', 'status', '--source', source, '--json'], consent: [], actor: 'provider', requires_exclusive: false,
        why: 'The apply finishes on its own; check again shortly.',
        then: hostFix(ctx, ['gbrain', 'access', 'resume', '--source', source],
          `Finishes an interrupted narrowing (database store); on a git store run gbrain sync --source ${source} --no-pull, and for an invalid file fix .gbrain/access.yml.`),
      },
    }];
  } catch {
    return [];
  }
}
