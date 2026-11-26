/**
 * The shadow child of the pipe-at-exit test: the real child loop (src/shadow/child.ts) on a seeded directory with a fake owner store, started late (READER_SLEEP seconds) so its pipe backs up.
 * Env: DIR, READER_SLEEP, DONE (written when the loop has ended and the tally is saved); GBRAIN_SHADOW_SESSION is the supervisor's.
 */
import { writeFileSync } from 'node:fs';
import { runShadowChild } from '../../src/shadow/child.ts';
import { writeSeedRecord } from '../../src/shadow/seed.ts';

const env = process.env as Record<string, string>;
writeSeedRecord(env.DIR!, { version: 1, seed_id: 'seed-1', started_at: '2026-01-01T00:00:00.000Z', finished_at: '2026-01-01T00:01:00.000Z', unseeded_gap_rows_total: 0, unseeded_gap_rows: {}, relations: {}, digests: true } as never);
await new Promise((resolve) => setTimeout(resolve, Number(env.READER_SLEEP) * 1000));
await runShadowChild(env.DIR!, {
  input: process.stdin, writeControl: () => {}, loadAddon: async () => ({ ok: true as const, addon: { target: 'linux-x64-glibc', engineAbi: 1, engineBuild: 'b1', catalogVersion: 3 } as never }),
  capabilities: () => ['search', 'pages'], readinessPolicyHash: () => 'p1', heartbeatMs: 60_000, childId: 'pipe-exit', addonSha256: () => 'a'.repeat(64),
  openEngine: () => ({ ownerRole: 'owner', async connect() {}, async disconnect() {} }) as never,
});
writeFileSync(env.DONE!, 'done\n');
process.exit(0);
