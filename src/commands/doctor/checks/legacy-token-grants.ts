/**
 * F3 legacy token grants (O-CEO-8, O-DX-9).
 *
 * `legacy_token_grant_shape` (warn when non-zero): active tokens still on
 * the JSONB-only grant shape. Schema migration v202 converts every
 * well-formed one; an older binary's `auth create` can add more, which
 * convert on their next authorization read or with
 * `gbrain auth rescope --migrate-legacy`. A malformed one denies every axis
 * until the user picks its grant. Reports the grant-mirror window end date.
 *
 * `legacy_token_grant_drift` (warn): migrated tokens whose `permissions`
 * mirror disagrees with the grant columns (an older gbrain edited the JSONB).
 * Each drifted axis denies every request until the operator picks a side.
 *
 * `legacy_token_null_scope` (warn): active tokens minted without scopes
 * (`scopes IS NULL`), which grandfather to read+write+admin. Each token gets
 * its own `gbrain auth rescope --id <id> --scopes read,write` command; the
 * check's `fix` asks the user before narrowing the first one.
 */
import type { Action } from '../../../core/agent-output.ts';
import { GRANT_MIRROR_WINDOW_ENDS, grantFromTokenRow, type LegacyGrantAxis } from '../../../core/grants/model.ts';
import type { Check } from '../../doctor.ts';
import { doctorVerify } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';

const DOCS = 'docs/mcp/ADMIN.md#legacy-token-grants';
const NULL_SCOPE_DOCS = 'docs/mcp/ADMIN.md#tokens-without-scopes';

async function runLegacyTokenGrants(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  const rows = await connectedEngine(ctx).listActiveAccessTokenRows();
  const legacy: Array<{ name: string; id: string; malformed: boolean }> = [];
  const drift: Array<{ name: string; id: string; axes: LegacyGrantAxis[] }> = [];
  const nullScope: Array<{ name: string; id: string; argv: string[] }> = [];
  for (const row of rows) {
    const grant = grantFromTokenRow(row);
    const entry = { name: String(row.name), id: String(row.id) };
    if (row.scopes == null) nullScope.push({ ...entry, argv: ['gbrain', 'auth', 'rescope', '--id', entry.id, '--scopes', 'read,write'] });
    if (grant.shape === 'legacy_permissions') legacy.push({ ...entry, malformed: grant.permissionsMalformed });
    if (grant.drift.length) drift.push({ ...entry, axes: grant.drift });
  }
  const malformed = legacy.filter(t => t.malformed).map(({ name, id }) => ({ name, id,
    argv: ['gbrain', 'auth', 'rescope', '--id', id, '--reset-default', 'sources,takes-holders,operations'] }));
  const convertible = legacy.length - malformed.length;
  const shapeFix: Action | undefined = convertible > 0
    ? { argv: ['gbrain', 'auth', 'rescope', '--migrate-legacy'], consent: [], actor: 'agent', requires_exclusive: false, docs: DOCS,
        verify: doctorVerify('legacy_token_grant_shape'), why: 'Writes the unified grant columns for every legacy-shape token without changing any grant.' }
    : malformed[0] && { argv: malformed[0].argv, consent: ['credentials'], actor: 'agent', requires_exclusive: false, docs: DOCS,
        verify: doctorVerify('legacy_token_grant_shape'),
        why: 'A token whose permissions value is not a JSON object has no faithful grant, so it denies every request until it is given one.',
        user_message: `${malformed.length} API key(s) (first: ${malformed[0].name}) have unreadable permissions and are refused everywhere. `
          + 'Give each the default grant (no source grant, holders world, every operation its scopes allow), or name the sources, holders and operations it should hold?' };
  checks.push({
    name: 'legacy_token_grant_shape',
    status: legacy.length ? 'warn' : 'ok',
    message: (legacy.length === 0
      ? 'Every active legacy token uses the unified grant columns.'
      : (convertible ? `${convertible} active legacy token(s) still use the permissions-JSON grant shape (an older gbrain created them); each converts on its next request, or now with gbrain auth rescope --migrate-legacy (no grant changes, no user decision needed). ` : '')
        + (malformed.length ? `${malformed.length} have malformed permissions and deny every request; ask the user which grant each should hold, then run the command in details.malformed (or gbrain auth rescope --id <id> with explicit --sources/--takes-holders/--operations). ` : '')
        + `See ${DOCS}.`)
      + ` The permissions mirror for older gbrain binaries is kept until ${GRANT_MIRROR_WINDOW_ENDS}.`,
    details: { legacy_shape_count: legacy.length, convertible_count: convertible, malformed, mirror_window_ends: GRANT_MIRROR_WINDOW_ENDS, docs: DOCS },
    ...(shapeFix ? { fix: shapeFix } : {}),
  });
  checks.push({
    name: 'legacy_token_grant_drift',
    status: drift.length ? 'warn' : 'ok',
    message: drift.length === 0
      ? 'No legacy token grant has drifted from its permissions mirror.'
      : `${drift.length} legacy token(s) have grant drift: an older gbrain edited the permissions JSON after migration, so the drifted axes deny every request (fail-closed). `
        + 'Ask the user which grant is intended, then for each token run gbrain auth rescope --token <name> --adopt-permissions (keep the JSON edit) or --adopt-columns (restore the columns): '
        + drift.slice(0, 5).map(t => `${t.name} (${t.axes.join(', ')}): gbrain auth rescope --token ${t.name} --adopt-permissions|--adopt-columns`).join('; ')
        + `${drift.length > 5 ? `; and ${drift.length - 5} more in details.drift` : ''}. Drift is enforced while the mirror is kept (until ${GRANT_MIRROR_WINDOW_ENDS}). See ${DOCS}.`,
    details: { drift, mirror_window_ends: GRANT_MIRROR_WINDOW_ENDS, docs: DOCS },
  });
  const first = nullScope[0];
  const fix: Action | undefined = first && {
    argv: first.argv, consent: ['credentials'], actor: 'agent', requires_exclusive: false, docs: NULL_SCOPE_DOCS, verify: doctorVerify('legacy_token_null_scope'),
    why: 'A token minted without scopes is grandfathered to read+write+admin; narrowing it to read,write removes admin operations from that key.',
    user_message: `${nullScope.length} API key(s) have full read, write and admin access because they were created without scopes`
      + ` (first: ${first.name}). Narrow each to read and write? A client that needs admin operations would lose them.`,
  };
  checks.push({
    name: 'legacy_token_null_scope',
    status: nullScope.length ? 'warn' : 'ok',
    message: nullScope.length === 0
      ? 'Every active legacy token has explicit scopes.'
      : `${nullScope.length} active legacy token(s) have no scopes, so they hold full read+write+admin access (grandfathered). `
        + 'Ask the user, then narrow each: '
        + nullScope.slice(0, 5).map(t => `${t.name}: ${t.argv.join(' ')}`).join('; ')
        + `${nullScope.length > 5 ? `; and ${nullScope.length - 5} more in details.tokens` : ''}. See ${NULL_SCOPE_DOCS}.`,
    details: { null_scope_count: nullScope.length, tokens: nullScope, docs: NULL_SCOPE_DOCS },
    ...(fix ? { fix } : {}),
  });
  return checks;
}

export const legacyTokenGrantsEntry: DoctorEntry = {
  name: 'legacy_token_grant_shape',
  emits: ['legacy_token_grant_shape', 'legacy_token_grant_drift', 'legacy_token_null_scope'],
  run: runLegacyTokenGrants,
};
