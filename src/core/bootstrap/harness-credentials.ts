import { readCredentials } from '../harness/credentials.ts';
import { harnessAdapter } from '../harness/registry.ts';
import { normalizeMcpUrl, validateToken } from '../mcp-registration.ts';
import { isValidSourceId } from '../source-id.ts';
import { existsSync, statSync } from 'node:fs';
import type { HarnessFlags } from './harness.ts';

/** Validate the private handoff before consent, probing, minting or host writes. */
export function resolveHarnessCredentials(flags: HarnessFlags): HarnessFlags {
  if (flags.credentialsFile === undefined) return flags;
  if (flags.token !== undefined) throw new Error('Conflicting credentials');
  const credentials = readCredentials(flags.credentialsFile);
  if ((!credentials.harness && credentials.client_secret) || (credentials.harness && harnessAdapter(credentials.harness).renewable)) {
    throw new Error('Static harness wiring cannot renew this handoff');
  }
  if (!credentials.access_token || (credentials.expires_at !== undefined && credentials.expires_at <= Math.floor(Date.now() / 1000))) {
    throw new Error('Missing or expired access token');
  }
  const selected = normalizeMcpUrl(flags.url ?? (flags.port !== undefined ? `http://127.0.0.1:${flags.port}/mcp` : credentials.mcp_url));
  if (!selected.ok || selected.url !== credentials.mcp_url) throw new Error('Endpoint mismatch');
  if (credentials.source_id !== undefined && (!isValidSourceId(credentials.source_id) || (flags.source !== undefined && flags.source !== credentials.source_id))) {
    throw new Error('Source mismatch');
  }
  return { ...flags, token: credentials.access_token, url: credentials.mcp_url,
    ...(credentials.source_id !== undefined ? { source: credentials.source_id } : {}) };
}

export function validateHarnessInputs(flags: HarnessFlags, logError: (line: string) => void): HarnessFlags | null {
  try { flags = resolveHarnessCredentials(flags); }
  catch {
    logError('--credentials-file needs a private, unexpired static-client handoff matching the selected endpoint and source. Renewable or recovered tokenless handoffs require gbrain connect --credentials FILE --install. No harness was changed.');
    return null;
  }
  for (const dir of flags.projects) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      logError(`--project directory does not exist: ${dir}`);
      return null;
    }
  }
  if (flags.token !== undefined) {
    const v = validateToken(flags.token);
    if (!v.ok) { logError(`--token: ${v.error}`); return null; }
  }
  return flags;
}
