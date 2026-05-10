/**
 * Thin-client doctor (multi-topology v1).
 *
 * Replaces every DB-bound check from `runDoctor()` with a tighter set scoped
 * to "is the remote MCP we configured actually reachable?". Runs three
 * outbound HTTP probes via `src/core/remote-mcp-probe.ts` plus a config
 * integrity sanity check. Output shape matches the local doctor's `Check`
 * surface so JSON consumers can union the two without conditional logic.
 *
 * Called from `src/cli.ts`'s doctor branch when `isThinClient(loadConfig())`
 * returns true. Local doctor is bypassed entirely — no DB checks, no schema
 * version, no jsonb integrity. Those don't apply when there's no local DB.
 */

import type { GBrainConfig } from './config.ts';
import { discoverOAuth, mintClientCredentialsToken, smokeTestMcp } from './remote-mcp-probe.ts';
import { callRemoteTool, RemoteMcpError, unpackToolResult } from './mcp-client.ts';
import { safeCompare, driftLevel, loadPromptState } from './thin-client-upgrade-prompt.ts';
import { VERSION } from '../version.ts';

export interface RemoteCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  message: string;
  detail?: Record<string, unknown>;
}

export interface RemoteDoctorReport {
  schema_version: 2;
  mode: 'thin-client';
  status: 'ok' | 'warn' | 'fail';
  mcp_url: string;
  issuer_url: string;
  oauth_client_id: string;
  oauth_scope?: string;
  checks: RemoteCheck[];
}

/**
 * Run thin-client doctor checks and either print to stdout (json or human)
 * or return the structured report. The `args` argument is the same array
 * passed to local `runDoctor`, so flags like `--json` are honored.
 */
export async function runRemoteDoctor(config: GBrainConfig, args: string[]): Promise<void> {
  const jsonOutput = args.includes('--json');
  const report = await collectRemoteDoctorReport(config);

  if (jsonOutput) {
    console.log(JSON.stringify(report));
  } else {
    printHumanReport(report);
  }

  if (report.status === 'fail') process.exit(1);
}

/**
 * v0.31.1: opts for collectRemoteDoctorReport.
 *
 * `skipScopeProbe` defaults to false. Set to true in test fixtures that
 * mock /mcp at JSON-RPC initialize level only — the MCP SDK Client used
 * by the scope probe hangs on shape mismatch and doesn't always honor
 * AbortSignal. Production callers always run the probe.
 *
 * Also honors GBRAIN_DOCTOR_SKIP_SCOPE_PROBE=1 for ops bypass; explicit
 * opts.skipScopeProbe wins.
 */
export interface CollectRemoteDoctorOpts {
  skipScopeProbe?: boolean;
}

/**
 * Pure data collector — separated from the print/exit logic so tests can
 * assert the report shape without intercepting stdout.
 */
export async function collectRemoteDoctorReport(
  config: GBrainConfig,
  opts: CollectRemoteDoctorOpts = {},
): Promise<RemoteDoctorReport> {
  const remote = config.remote_mcp;
  const checks: RemoteCheck[] = [];

  // 1. Config integrity. If the dispatch guard let us reach here at all,
  // remote_mcp is set, but defense-in-depth: validate the URL fields look
  // sane before issuing any HTTP. Catches typos that aren't covered by the
  // probe itself ("htttp://..." would otherwise produce a confusing
  // network-error message).
  if (!remote) {
    checks.push({
      name: 'config_integrity',
      status: 'fail',
      message: 'config has no remote_mcp section — runRemoteDoctor was called incorrectly',
    });
    return {
      schema_version: 2,
      mode: 'thin-client',
      status: 'fail',
      mcp_url: '',
      issuer_url: '',
      oauth_client_id: '',
      checks,
    };
  }

  const issuerOk = /^https?:\/\//i.test(remote.issuer_url);
  const mcpOk = /^https?:\/\//i.test(remote.mcp_url);
  if (!issuerOk || !mcpOk) {
    checks.push({
      name: 'config_integrity',
      status: 'fail',
      message: `URL fields malformed: issuer_url=${remote.issuer_url}, mcp_url=${remote.mcp_url}`,
    });
  } else {
    checks.push({
      name: 'config_integrity',
      status: 'ok',
      message: `mcp_url=${remote.mcp_url}, issuer_url=${remote.issuer_url}`,
    });
  }

  // Resolve the secret: env var wins, then config file value.
  const clientSecret = process.env.GBRAIN_REMOTE_CLIENT_SECRET ?? remote.oauth_client_secret;
  const clientSecretSource: 'env' | 'config' | 'none' = process.env.GBRAIN_REMOTE_CLIENT_SECRET
    ? 'env'
    : remote.oauth_client_secret
      ? 'config'
      : 'none';

  if (!clientSecret) {
    checks.push({
      name: 'oauth_credentials',
      status: 'fail',
      message: 'No client_secret available. Set GBRAIN_REMOTE_CLIENT_SECRET or rerun `gbrain init --mcp-only` with --oauth-client-secret.',
    });
    return {
      schema_version: 2,
      mode: 'thin-client',
      status: 'fail',
      mcp_url: remote.mcp_url,
      issuer_url: remote.issuer_url,
      oauth_client_id: remote.oauth_client_id,
      checks,
    };
  }

  checks.push({
    name: 'oauth_credentials',
    status: 'ok',
    message: `client_id=${remote.oauth_client_id}, secret_source=${clientSecretSource}`,
  });

  // 2. OAuth discovery
  const disco = await discoverOAuth(remote.issuer_url);
  if (!disco.ok) {
    checks.push({
      name: 'oauth_discovery',
      status: 'fail',
      message: disco.message,
      detail: { reason: disco.reason, ...(disco.status ? { status: disco.status } : {}) },
    });
    return finalize(remote, checks);
  }
  checks.push({
    name: 'oauth_discovery',
    status: 'ok',
    message: `token_endpoint=${disco.metadata.token_endpoint}`,
  });

  // 3. Token round-trip
  const tokenRes = await mintClientCredentialsToken(disco.metadata.token_endpoint, remote.oauth_client_id, clientSecret);
  if (!tokenRes.ok) {
    checks.push({
      name: 'oauth_token',
      status: 'fail',
      message: tokenRes.message,
      detail: { reason: tokenRes.reason, ...(tokenRes.status ? { status: tokenRes.status } : {}) },
    });
    return finalize(remote, checks);
  }
  checks.push({
    name: 'oauth_token',
    status: 'ok',
    message: `${tokenRes.token.token_type ?? 'bearer'} (scope=${tokenRes.token.scope ?? 'unspecified'}, expires_in=${tokenRes.token.expires_in ?? '?'})`,
    detail: { scope: tokenRes.token.scope ?? null, expires_in: tokenRes.token.expires_in ?? null },
  });

  // 4. MCP smoke
  const mcpRes = await smokeTestMcp(remote.mcp_url, tokenRes.token.access_token);
  if (!mcpRes.ok) {
    checks.push({
      name: 'mcp_smoke',
      status: 'fail',
      message: mcpRes.message,
      detail: { reason: mcpRes.reason, ...(mcpRes.status ? { status: mcpRes.status } : {}) },
    });
    return finalize(remote, checks, tokenRes.token.scope);
  }
  checks.push({
    name: 'mcp_smoke',
    status: 'ok',
    message: 'initialize round-trip succeeded',
  });

  // 5. v0.31.1 (CDX-5): scope-probe — verify the OAuth client actually has
  // the scopes its token claims. Calls a representative read op (always
  // safe), then a representative admin op (also read-only, no side effects).
  // Reports per-tier status with a pinpoint remediation hint when admin is
  // missing — the v0.29.2/v0.30.0 thin-clients without admin scope hit
  // `gbrain stats` / `gbrain history` and fail today; this check surfaces
  // the gap during `gbrain remote doctor` instead of mid-command.
  //
  // Skippable via opts.skipScopeProbe (preferred for tests) OR
  // GBRAIN_DOCTOR_SKIP_SCOPE_PROBE=1 (env-flag for ops bypass) — the MCP
  // SDK Client hangs on JSON-RPC shape mismatch in fixtures that don't
  // implement full tools/call.
  const grantedScope = tokenRes.token.scope ?? '';
  const skipProbe = opts.skipScopeProbe || process.env.GBRAIN_DOCTOR_SKIP_SCOPE_PROBE === '1';
  if (!skipProbe) {
    const scopeResult = await probeScopes(config);
    checks.push(buildScopeCheck(grantedScope, scopeResult));
  }

  // 6. v0.31.11: thin-client version-drift check. Calls get_brain_identity
  // to compare local CLI version against remote brain version. Reports:
  //   - 'ok' when local >= remote OR drift is 'patch' (D8 policy: only
  //     minor/major drift is meaningful enough to flag in doctor)
  //   - 'warn' when minor/major drift detected; fix hint points at
  //     `gbrain upgrade` (or, if state shows a prior 'failed' attempt,
  //     points at the manual install path)
  //   - 'ok' (informational) when network unreachable / fetch throws —
  //     doctor MUST NOT fail loud on transient network issues; this check
  //     is informational, the earlier mcp_smoke would have already failed
  //     hard if the remote is genuinely down.
  if (!skipProbe) {
    checks.push(await runUpgradeDriftCheck(config));
  }

  return finalize(remote, checks, tokenRes.token.scope);
}

/**
 * v0.31.11: thin-client version-drift check. Surfaces remote-brain drift in
 * `gbrain doctor` so quiet/non-TTY users (who don't see the interactive
 * prompt) still learn about minor/major bumps. Pure data fetch + compare.
 *
 * Errors are non-fatal: any failure returns an 'ok' status with a
 * `network_error` detail. The earlier `mcp_smoke` check covers the
 * "remote is genuinely unreachable" case with a 'fail' status.
 */
export async function runUpgradeDriftCheck(config: GBrainConfig): Promise<RemoteCheck> {
  let remoteVersion: string;
  try {
    const raw = await callRemoteTool(config, 'get_brain_identity', {}, { timeoutMs: 2000 });
    const identity = unpackToolResult<{ version: string }>(raw);
    remoteVersion = identity.version;
  } catch (e) {
    return {
      name: 'thin_client_upgrade_drift',
      status: 'ok',
      message: 'could not fetch remote version (network or scope error); see other checks',
      detail: { error: e instanceof Error ? e.message : String(e), inconclusive: true },
    };
  }

  const cmp = safeCompare(VERSION, remoteVersion);
  if (cmp === null) {
    return {
      name: 'thin_client_upgrade_drift',
      status: 'ok',
      message: `version comparison inconclusive (local=${VERSION}, remote=${remoteVersion})`,
      detail: { local: VERSION, remote: remoteVersion, inconclusive: true },
    };
  }
  if (cmp >= 0) {
    return {
      name: 'thin_client_upgrade_drift',
      status: 'ok',
      message: `local v${VERSION} ≥ remote v${remoteVersion}`,
      detail: { local: VERSION, remote: remoteVersion },
    };
  }
  const level = driftLevel(VERSION, remoteVersion);
  if (level === 'patch') {
    return {
      name: 'thin_client_upgrade_drift',
      status: 'ok',
      message: `local v${VERSION}, remote v${remoteVersion} (patch drift; not flagged)`,
      detail: { local: VERSION, remote: remoteVersion, level },
    };
  }

  // Minor or major drift. Check the prompt-state file: if a prior 'failed'
  // attempt is recorded for this remote+version, point users at the manual
  // install path instead of the auto-upgrade command.
  let priorFailed = false;
  try {
    const state = loadPromptState();
    const entry = state.entries[config.remote_mcp?.mcp_url ?? ''];
    if (entry && entry.last_response === 'failed' && entry.last_prompted_remote_version === remoteVersion) {
      priorFailed = true;
    }
  } catch { /* state read is best-effort */ }

  const fixHint = priorFailed
    ? `Prior \`gbrain upgrade\` did not advance the binary. See https://github.com/garrytan/gbrain/releases for manual install.`
    : `Run \`gbrain upgrade\` to install v${remoteVersion}.`;

  return {
    name: 'thin_client_upgrade_drift',
    status: 'warn',
    message: `${level} upgrade available: local v${VERSION} → remote v${remoteVersion}. ${fixHint}`,
    detail: { local: VERSION, remote: remoteVersion, level, prior_failed: priorFailed },
  };
}

/**
 * v0.31.1: minimal probe of the read + admin scope tiers via two harmless
 * read-only MCP calls. Write tier is NOT probed (no benign write op exists
 * — every write would mutate state). Trust the granted-scope string for
 * write status.
 */
/** v0.31.1: exported for test access (test/oauth-scope-probe.test.ts). */
export interface ScopeProbeResult {
  read_ok: boolean;
  admin_ok: boolean;
  read_error?: string;
  admin_error?: string;
}

async function probeScopes(config: GBrainConfig): Promise<ScopeProbeResult> {
  const result: ScopeProbeResult = { read_ok: false, admin_ok: false };

  // Read tier: get_brain_identity is the cheapest read op (just returns
  // counters; no DB scan beyond the existing getStats).
  try {
    await callRemoteTool(config, 'get_brain_identity', {}, { timeoutMs: 1500 });
    result.read_ok = true;
  } catch (e) {
    if (e instanceof RemoteMcpError) {
      result.read_error = e.detail?.code === 'missing_scope' ? 'missing_scope' : e.reason;
    } else {
      result.read_error = e instanceof Error ? e.message : String(e);
    }
  }

  // Admin tier: get_health is read-only (engine.getHealth is a SELECT) but
  // requires admin scope per operations.ts:1370.
  try {
    await callRemoteTool(config, 'get_health', {}, { timeoutMs: 1500 });
    result.admin_ok = true;
  } catch (e) {
    if (e instanceof RemoteMcpError) {
      result.admin_error = e.detail?.code === 'missing_scope' ? 'missing_scope' : e.reason;
    } else {
      result.admin_error = e instanceof Error ? e.message : String(e);
    }
  }

  return result;
}

/** v0.31.1: exported for test access. */
export function buildScopeCheck(grantedScope: string, probe: ScopeProbeResult): RemoteCheck {
  // Status semantics — informational by default, escalates only on signals
  // we can KNOW indicate a scope problem (i.e. tool_error code='missing_scope').
  // Other probe failures (parse/network/timeout) might be transient or fixture
  // artifacts; report as 'ok' with `inconclusive` detail so doctor's overall
  // status doesn't flap on probe noise.
  //
  //   - read.missing_scope  → 'fail' (broken setup; nothing works)
  //   - admin.missing_scope → 'warn' (the load-bearing case for v0.29.2 thin
  //     clients that registered with read+write only; pinpoint hint follows)
  //   - both succeed        → 'ok'
  //   - other probe errors  → 'ok' with inconclusive=true
  const readMissing = !probe.read_ok && probe.read_error === 'missing_scope';
  const adminMissing = !probe.admin_ok && probe.admin_error === 'missing_scope';

  if (readMissing) {
    return {
      name: 'oauth_client_scopes_probe',
      status: 'fail',
      message: 'OAuth client lacks read scope. Re-register on the host with at least `--scopes read`.',
      detail: {
        granted: grantedScope || null,
        read_ok: false,
        admin_ok: probe.admin_ok,
      },
    };
  }
  if (adminMissing) {
    return {
      name: 'oauth_client_scopes_probe',
      status: 'warn',
      message:
        'admin scope MISSING (read works). On the host, re-register: ' +
        '`gbrain auth register-client <name> --grant-types client_credentials --scopes read,write,admin`',
      detail: {
        granted: grantedScope || null,
        read_ok: true,
        admin_ok: false,
        admin_error: probe.admin_error ?? null,
      },
    };
  }
  if (probe.read_ok && probe.admin_ok) {
    return {
      name: 'oauth_client_scopes_probe',
      status: 'ok',
      message: `read + admin scopes verified (write tier inferred from granted="${grantedScope || 'unspecified'}")`,
      detail: {
        granted: grantedScope || null,
        read_ok: true,
        admin_ok: true,
      },
    };
  }
  // Inconclusive: probe failed for non-scope reasons. Report as 'ok' so
  // unrelated probe transients don't escalate doctor's overall status,
  // but include the probe results for debugging.
  return {
    name: 'oauth_client_scopes_probe',
    status: 'ok',
    message: `scope probe inconclusive (granted="${grantedScope || 'unspecified'}"); commands will surface scope errors at call time if any`,
    detail: {
      granted: grantedScope || null,
      read_ok: probe.read_ok,
      admin_ok: probe.admin_ok,
      read_error: probe.read_error ?? null,
      admin_error: probe.admin_error ?? null,
      inconclusive: true,
    },
  };
}

function finalize(
  remote: NonNullable<GBrainConfig['remote_mcp']>,
  checks: RemoteCheck[],
  scope?: string,
): RemoteDoctorReport {
  const status: 'ok' | 'warn' | 'fail' = checks.some(c => c.status === 'fail')
    ? 'fail'
    : checks.some(c => c.status === 'warn')
      ? 'warn'
      : 'ok';
  return {
    schema_version: 2,
    mode: 'thin-client',
    status,
    mcp_url: remote.mcp_url,
    issuer_url: remote.issuer_url,
    oauth_client_id: remote.oauth_client_id,
    ...(scope ? { oauth_scope: scope } : {}),
    checks,
  };
}

function printHumanReport(report: RemoteDoctorReport): void {
  console.log('\nGBrain Health Check (thin-client)');
  console.log('=================================');
  console.log(`Mode:        ${report.mode}`);
  console.log(`Issuer URL:  ${report.issuer_url}`);
  console.log(`MCP URL:     ${report.mcp_url}`);
  console.log(`Client ID:   ${report.oauth_client_id}`);
  if (report.oauth_scope) console.log(`OAuth scope: ${report.oauth_scope}`);
  console.log('');

  for (const c of report.checks) {
    const icon = c.status === 'ok' ? '✓' : c.status === 'warn' ? '!' : '✗';
    console.log(`  [${icon}] ${c.name}: ${c.message}`);
  }
  console.log('');

  if (report.status === 'ok') {
    console.log('All checks passed. Thin-client connectivity to remote brain is healthy.');
  } else if (report.status === 'warn') {
    console.log('Connectivity has warnings — review above.');
  } else {
    console.log('Connectivity check FAILED — see error above.');
    console.log('Common fixes:');
    console.log('  - Confirm the host is reachable + `gbrain serve --http` is running.');
    console.log('  - Confirm OAuth credentials are valid (have the host operator re-mint via `gbrain auth register-client`).');
    console.log('  - Confirm `mcp_url` matches the path the host serves /mcp on (default: <issuer_url>/mcp).');
  }
}
