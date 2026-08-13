/** Dependency-free smoke proof for project-scoped Codex wire adoption. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  adoptedConnectionsPath,
  fingerprintCodexEffectiveConfig,
  probeCodexProjectMcp,
  readAdoptedConnectionsState,
  writeAdoptedConnection,
} from '../src/core/bootstrap/wire.ts';

const root = mkdtempSync(join(tmpdir(), 'gbrain-wire-self-test-'));
const workspace = join(root, 'workspace');
const home = join(root, '.gbrain');
const serverName = 'example.project.oauth';
try {
  mkdirSync(join(workspace, '.codex'), { recursive: true });
  writeFileSync(join(workspace, '.codex', 'config.toml'), `[mcp_servers."${serverName}"]\nurl = "https://service.invalid/mcp"\n`);
  const effective = {
    enabled: true,
    transport: {
      type: 'streamable_http',
      url: 'https://service.invalid/mcp?token=must-not-persist',
      bearer_token_env_var: 'INITIAL_TOKEN',
    },
    http_headers: { Authorization: 'Bearer must-not-persist' },
  };
  const probe = await probeCodexProjectMcp(workspace, serverName, async () => ({
    code: 0, stdout: JSON.stringify(effective), stderr: '',
  }));
  if (!probe.configured || !probe.cli_readable || probe.enabled !== true ||
    probe.transport !== 'streamable_http' || !probe.effective_config_fingerprint) {
    throw new Error('effective project config probe did not produce an adoptable result');
  }
  const rotatedUserInfo = ['other', 'rotated'].join(':');
  const rotatedSecret = {
    enabled: true,
    transport: {
      type: 'http',
      url: `https://${rotatedUserInfo}@service.invalid/mcp?token=rotated#ignored`,
      bearer_token_env_var: 'ROTATED_TOKEN',
    },
    http_headers: { authorization: 'Bearer rotated' },
  };
  if (fingerprintCodexEffectiveConfig(effective) !== fingerprintCodexEffectiveConfig(rotatedSecret)) {
    throw new Error('secret rotation changed the structural fingerprint');
  }
  if (fingerprintCodexEffectiveConfig(effective) === fingerprintCodexEffectiveConfig({
    ...rotatedSecret,
    transport: { ...rotatedSecret.transport, url: 'https://service.invalid/mcp-v2?token=rotated' },
  })) {
    throw new Error('safe endpoint drift did not change the structural fingerprint');
  }
  await writeAdoptedConnection(home, {
    workspace, harness: 'codex', scope: 'project', server_name: serverName,
    transport: 'streamable_http', auth: 'not_proven',
    effective_config_fingerprint: probe.effective_config_fingerprint,
    verification_class: 'operator_attested_runtime_call', verified_at: '2026-01-01T00:00:00.000Z',
  });
  const first = readAdoptedConnectionsState(home);
  if (first.state !== 'ok' || first.connections.length !== 1) throw new Error('adoption evidence did not round-trip');
  const raw = readFileSync(adoptedConnectionsPath(home), 'utf8');
  if (raw.includes('service.invalid') || raw.includes('must-not-persist')) throw new Error('effective config leaked into evidence');
  await Promise.all([
    writeAdoptedConnection(home, { ...first.connections[0]!, workspace: join(root, 'two'), server_name: 'example.two' }),
    writeAdoptedConnection(home, { ...first.connections[0]!, workspace: join(root, 'three'), server_name: 'example.three' }),
  ]);
  const concurrent = readAdoptedConnectionsState(home);
  if (concurrent.state !== 'ok' || concurrent.connections.length !== 3) throw new Error('concurrent writes lost an update');
  writeFileSync(adoptedConnectionsPath(home), '{"schema_version":2,"connections":[]}\n');
  let refusedNewer = false;
  try {
    await writeAdoptedConnection(home, first.connections[0]!);
  } catch {
    refusedNewer = true;
  }
  if (!refusedNewer) throw new Error('newer evidence schema did not refuse overwrite');
  console.log('bootstrap wire self-test: ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}
