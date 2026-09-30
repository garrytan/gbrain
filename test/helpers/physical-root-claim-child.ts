import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';

async function main() {
  const engine = new PostgresEngine();
  await engine.connect({ database_url: process.env.DATABASE_URL!, poolSize: 2 });
  const hostId = localHostId();
  try {
    writeFileSync(join(process.env.GBRAIN_HOME!, 'ready'), 'ready');
    await Bun.stdin.text();
    try {
      const binding = await claimWorktree(engine, process.argv[2], process.argv[3], hostId);
      process.stdout.write(JSON.stringify({ claimed: true, worktreeId: binding.worktree_id, hostId }));
    } catch (error) { process.stdout.write(JSON.stringify({ claimed: false, code: (error as { code?: string }).code ?? 'unexpected_error', hostId })); }
  } finally { await engine.disconnect(); }
}
await main();
