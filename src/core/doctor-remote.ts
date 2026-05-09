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
 * Pure data collector — separated from the print/exit logic so tests can
 * assert the report shape without intercepting stdout.
 */
export async function collectRemoteDoctorReport(config: GBrainConfig): Promise<RemoteDoctorReport> {
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
  const tokenRes = await mintClientCredentialsToken(disco.metadata.token_endpoint, remote.oauth_client_id, clientSecret, {
    resource: remote.mcp_url,
  });
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

  return finalize(remote, checks, tokenRes.token.scope);
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
