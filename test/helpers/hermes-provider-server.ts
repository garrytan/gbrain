import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { startServeHttp, legacyToken, callTool } from './live-mcp-servers.ts';
import { mintLegacyToken, revokeLegacyTokenById } from '../../src/core/token-mint.ts';
import { sqlQueryForEngine } from '../../src/core/sql-query.ts';
import { createInterface } from 'node:readline';

const dataDir = process.env.GBRAIN_HERMES_FIXTURE_DATA_DIR;
const engine = new PGLiteEngine();
await engine.connect(dataDir ? { engine: 'pglite', database_path: dataDir } : {});
await engine.initSchema();
const server = await startServeHttp(engine);
const token = await legacyToken(engine, ['read', 'write', 'admin']);
const readOnlyToken = await (await import('../../src/core/token-mint.ts')).mintLegacyToken(engine, {
  name: 'hermes-acceptance-read-only', scopes: ['read'],
  allowedOperations: ['recall', 'context_pack', 'delta'], takesHolders: ['world'],
});

// Synthetic-only fixtures; do not reseed durable rows when reopening after restart.
if (!process.env.GBRAIN_HERMES_FIXTURE_REOPEN) {
await callTool(server.base, token, 'put_page', {
  slug: 'hermes-acceptance/world-synthetic', title: 'Synthetic world fixture',
  content: `---
title: Synthetic world fixture
visibility: world
---

HERMES_WORLD_FIXTURE_7241`, type: 'note',
});
await callTool(server.base, token, 'put_page', {
  slug: 'hermes-acceptance/private-synthetic', title: 'Synthetic private fixture',
  content: `---
title: Synthetic private fixture
visibility: private
---

HERMES_PRIVATE_FIXTURE_9813`, type: 'note',
});
}
const sourceTokens = [];
for (const sourceId of ['hermes-profile-a', 'hermes-profile-b']) {
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1) ON CONFLICT (id) DO NOTHING', [sourceId]);
  const minted = await mintLegacyToken(engine, {
    name: sourceId, scopes: ['read', 'write'], takesHolders: ['world'], sourceGrant: [sourceId],
  });
  const marker = sourceId === 'hermes-profile-a' ? 'amber telescope orchard' : 'violet compass meadow';
  if (!process.env.GBRAIN_HERMES_FIXTURE_REOPEN) {
  const result = await callTool(server.base, minted.token, 'put_page', {
    source_id: sourceId, slug: 'notes/profile-fixture',
    content: `---\ntitle: Synthetic profile fixture\nvisibility: world\n---\n\n${marker}`,
  });
  if (result.isError) throw new Error('Synthetic source fixture could not be written');
  }
  sourceTokens.push({ sourceId, token: minted.token, id: minted.id, marker });
}
process.stdout.write(JSON.stringify({ url: server.mcpUrl, token, readOnlyToken: readOnlyToken.token, sourceTokens }) + '\n');

// Private parent/child test control pipe, never exposed on the HTTP listener.
// Only synthetic fixtures and these two exact consent states can be changed.
try {
  for await (const line of createInterface({ input: process.stdin })) {
    const command = JSON.parse(line) as { action: string; enabled?: boolean; sourceId?: string };
    let result: unknown;
    if (command.action === 'consent' && typeof command.enabled === 'boolean') {
      await engine.setConfig('memory.auto_writeback', command.enabled ? 'all' : 'off');
      result = { enabled: command.enabled };
    } else if (command.action === 'revoke' && command.sourceId === 'hermes-profile-b') {
      result = { revoked: await revokeLegacyTokenById(sqlQueryForEngine(engine), sourceTokens[1]!.id) };
    } else if (command.action === 'pages' && ['hermes-profile-a', 'hermes-profile-b'].includes(command.sourceId ?? '')) {
      result = await engine.executeRaw('SELECT slug,compiled_truth FROM pages WHERE source_id=$1 AND deleted_at IS NULL ORDER BY slug', [command.sourceId]);
    } else {
      throw new Error('Unsupported fixture control action');
    }
    process.stdout.write(JSON.stringify({ control: command.action, result }) + '\n');
  }
} finally {
  await server.close();
  await engine.disconnect();
}
