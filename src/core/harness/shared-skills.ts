import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { createSharedSkillsAdapter, type SharedSkillsToolCaller } from '../shared-skills/adapter.ts';
import { credentialAccessToken, type HarnessCredentials } from './credentials.ts';
import { extractResultText } from '../connect-probe.ts';
import { OperationError } from '../ops/contract.ts';
import { nativeSharedSkillsDirectory } from './native-router.ts';

export interface SharedSkillsConnectionOptions {
  harness: string;
  root: string;
  launcher?: string;
  name?: string;
  remove?: boolean;
  sharedSkills?: HarnessCredentials['shared_skills'];
  toolCaller?: SharedSkillsToolCaller;
  nativeSkillsDir?: string;
}

export async function installSharedSkillsConnection(credentials: HarnessCredentials, options: SharedSkillsConnectionOptions) {
  const policy = options.sharedSkills ?? credentials.shared_skills;
  if (options.remove && !existsSync(join(options.root, 'shared-skills', 'receipt.json'))) return { status: 'left', native: 'unverified', next_action: 'No shared-skills enrollment receipt exists in this installation.' };
  const deactivating = options.remove || policy?.follow === false && existsSync(join(options.root, 'shared-skills', 'receipt.json'));
  if (!policy?.follow && !deactivating) return { status: 'pending', reason: policy?.follow === false ? 'memory_only' : 'follow_approval_required',
    native: 'unverified', next_action: 'Keep using memory. To follow shared skills, approve the follow policy and ask the host for skills_member_self and enrollment operation access.' };
  let client: Client | undefined;
  try {
    let call = options.toolCaller;
    if (!call) {
      call = async <T>(name: string, params: Record<string, unknown>): Promise<T> => {
        if (!client) {
          const token = await credentialAccessToken(credentials);
          client = new Client({ name: 'gbrain-shared-skills-installer', version: '1' }, { capabilities: {} });
          const transport = new StreamableHTTPClientTransport(new URL(credentials.mcp_url), {
            requestInit: { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) },
          });
          await client.connect(transport);
        }
        const result = await client.callTool({ name, arguments: params }, undefined, { timeout: 30_000 });
        const text = extractResultText(result.content);
        let data: any;
        try { data = JSON.parse(text); } catch { throw new OperationError('shared_skills_unsupported', 'The server does not expose the shared-skills protocol.'); }
        if (result.isError || data.error) throw new OperationError(typeof data.error === 'string' ? data.error : 'shared_skills_unavailable', 'The shared-skills operation was refused. Memory remains independently available.');
        return data as T;
      };
    }
    const nativeSkillsDir = options.nativeSkillsDir ?? nativeSharedSkillsDirectory(options.harness) ?? undefined;
    const adapter = createSharedSkillsAdapter({ call, root: join(options.root, 'shared-skills'), adapter: options.harness, launcher: options.launcher, connectionName: options.name,
      nativeSkillsDir });
    if (deactivating) return await adapter.leave();
    const installed = await adapter.join({ approved: true, ...(policy?.source_ids ? { source_ids: policy.source_ids } : {}) });
    return nativeSkillsDir ? installed : { ...installed, status: 'pending', reason: 'native_registration_required', catalog_delivery: installed.status };
  } catch (error) {
    const code = (error as { code?: string }).code;
    const conflict = ['local_conflict', 'symlink_path', 'invalid_path', 'invalid_root'].includes(code ?? '');
    return { status: 'pending', reason: conflict ? 'local_conflict' : error instanceof OperationError ? error.code : 'shared_skills_unavailable', native: 'unverified',
      next_action: conflict ? 'Memory configuration is preserved. Resolve the edited or unowned native router without overwriting user files, then reconnect.'
        : 'Memory configuration is preserved. Verify follow approval, grant and shared-skills server support, then reconnect; do not activate stale cached skills.' };
  } finally { if (client) await client.close().catch(() => {}); }
}
