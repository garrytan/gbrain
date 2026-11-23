/**
 * Why a shadow's freshness token can be blind, and what fixes it (docs/ENGINES.md, the privacy-check paragraph). The token
 * (checks.ts `captureToken`) lists the transactions in progress from `pg_stat_activity`; a role that is neither a superuser nor
 * in `pg_read_all_stats` sees every other session with its columns NULL, so the token is blind and never proven: such a brain
 * clears no privacy sample and no recall score, and swap readiness criterion 3 stays failing. The status document, the report,
 * the swap plan and `gbrain doctor` (doctor/checks/shadow-freshness-token.ts) all name that reason from here, with the fix in
 * the agent operator contract's shape (docs/protocol/AGENT_OPERATOR_v1.md): code, message, why, fix (tell_user_to_run), verify.
 * The role named is the connected role (`current_user`), never a brain name.
 */
import { renderAction, cliRenderContext, type Action, type RenderedAction } from '../core/agent-output.ts';
import type { BrainEngine } from '../core/engine.ts';
import { hasCapability } from '../core/engine-capabilities.ts';
import { doctorVerify } from '../commands/doctor/check-fix.ts';

export const FRESHNESS_BLIND_CODE = 'freshness_token_blind';
/** The doctor check that reports it; the finding's `fix.verify` runs it. */
export const FRESHNESS_BLIND_CHECK = 'shadow_freshness_token';
export const FRESHNESS_BLIND_MESSAGE = 'freshness token blind: role lacks pg_read_all_stats';
const DOCS = 'docs/ENGINES.md#rust-engine-shadow-mode';

/** The finding, as the status document, the report and the swap read it. */
export interface FreshnessBlind {
  code: typeof FRESHNESS_BLIND_CODE;
  message: string;
  why: string;
  /** The connected database role, as `quote_ident` writes it. */
  role: string;
  fix: RenderedAction;
}

/** The statement that ends the blindness; `role` is already quoted by the server. */
export const grantStatement = (role: string): string => `GRANT pg_read_all_stats TO ${role};`;

export function freshnessBlindFinding(role: string): FreshnessBlind {
  const statement = grantStatement(role);
  const action: Action = {
    argv: ['psql', '-c', statement], consent: [], actor: 'host_admin', requires_exclusive: false, docs: DOCS,
    why: `Lets role ${role} see other sessions' transactions, so the freshness token can be proven and samples can clear.`,
    verify: doctorVerify(FRESHNESS_BLIND_CHECK),
  };
  return {
    code: FRESHNESS_BLIND_CODE,
    message: FRESHNESS_BLIND_MESSAGE,
    why: `Role ${role} is neither a superuser nor a member of pg_read_all_stats, so it cannot see other sessions' transactions and the shadow's freshness token is never proven: this brain clears no privacy sample and no recall score, and swap readiness criterion 3 stays failing. Run as a superuser (or a role with ADMIN OPTION on pg_read_all_stats): ${statement}`,
    role,
    fix: renderAction(action, cliRenderContext()),
  };
}

/**
 * The finding for the role `engine` is connected as, or null when the role sees every session (a superuser, or a member of
 * pg_read_all_stats) or the engine is not Postgres (PGLite has one session). `pg_has_role(..., 'usage')` is the test the server
 * itself applies to `pg_stat_activity`: privileges the role holds without `SET ROLE`.
 */
export async function probeFreshnessBlind(engine: Pick<BrainEngine, 'capabilities' | 'executeRaw'>): Promise<FreshnessBlind | null> {
  if (!hasCapability(engine, 'postgres_admin')) return null;
  const [row] = await engine.executeRaw<{ role: string; sees_all: boolean }>(
    `SELECT quote_ident(current_user) AS role, pg_has_role(current_user, 'pg_read_all_stats', 'usage') AS sees_all`);
  return row && row.sees_all === false ? freshnessBlindFinding(row.role) : null;
}

/** The lines the status and the report print for a finding. */
export function renderFreshnessBlind(f: FreshnessBlind): string[] {
  return [`  ${f.message} (${f.code})`, `    why: ${f.why}`, `    fix (${f.fix.next}): ${f.fix.command ?? grantStatement(f.role)}`, `    verify: ${f.fix.verify?.argv?.join(' ') ?? ''}`];
}

/**
 * The finding for the configured brain, for the status, the report and the swap, which run with the database possibly down:
 * null (no finding) when the brain cannot be opened or answers too slowly. Never throws; always disconnects what it opened.
 */
export async function probeConfiguredFreshness(open: () => Promise<BrainEngine>, timeoutMs = 5_000): Promise<FreshnessBlind | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const probe = (async (): Promise<FreshnessBlind | null> => {
    let engine: BrainEngine | undefined;
    try {
      engine = await open();
      return await probeFreshnessBlind(engine);
    } catch {
      return null;
    } finally {
      await engine?.disconnect().catch(() => undefined);
    }
  })();
  try {
    return await Promise.race([probe, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
