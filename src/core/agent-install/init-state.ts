/** File-plane init guards: ambient connection/provider values must never become persisted state. */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { configPath, gbrainPath, isThinClient, loadConfigFileOnly } from '../config.ts';
import { privateWrite, readFileConfigState } from './state.ts';

export function readInitConfigState(json: boolean) {
  const state = readFileConfigState(configPath());
  if (state.kind === 'invalid') {
    const message = `Existing configuration at ${configPath()} is unreadable or malformed. Preserve and repair it before initialization; it will not be overwritten.`;
    if (json) console.log(JSON.stringify({ status: 'error', reason: 'invalid_existing_config', message }));
    else console.error(message);
    process.exit(1);
  }
  return state;
}

/** Preserve exact bytes before an explicitly requested topology conversion. */
export function preserveConversionConfig(nextRemote: boolean): void {
  const prior = readFileConfigState(configPath());
  if (prior.kind === 'present' && isThinClient(prior.config) !== nextRemote) {
    const backup = `${configPath()}.before-conversion-${crypto.randomUUID()}`;
    privateWrite(backup, readFileSync(configPath()));
    console.error(`[init] Previous configuration preserved at ${backup}`);
  }
}

export function inspectRemoteInitState(force: boolean, fail: (reason: string, message: string, extra?: Record<string, unknown>) => never) {
  const state = readFileConfigState(configPath());
  if (state.kind === 'invalid') fail('invalid_existing_config', 'Existing configuration is malformed; repair it before initialization.');
  const existing = loadConfigFileOnly();
  if (isThinClient(existing) && !force) {
    const url = existing!.remote_mcp!.mcp_url;
    fail('thin_client_config_present', `Thin-client config already present at ${configPath()} (remote_mcp.mcp_url=${url}).\nRe-running --mcp-only would overwrite. Use --force to refresh.`, { mcp_url: url });
  }
  if (!force && (existing || existsSync(gbrainPath('brain.pglite')))) fail('local_config_present', `A local brain already exists at ${configPath()}. Use a separate GBRAIN_HOME, or --force to explicitly convert this installation. The database is preserved.`);
  return existing;
}

/** The setup subprocess retains real init warnings and the search-mode matrix,
 * then points to the native skill instead of another harness's bootstrap. */
export function printInAgentReady(databasePath: string): void {
  const root = dirname(dirname(databasePath));
  console.log(`\nBrain ready at ${databasePath}\nLocal personal-agent setup will finish at ${join(root, 'bin', 'gbrain')}.\nAttach the generated memory skill in your app, then test a fresh conversation.\nExplicit memory is available; automatic capture and paid maintenance remain separate choices.`);
}
