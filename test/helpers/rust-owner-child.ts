/**
 * Child process for the Rust owner-protocol tests (test/rust-owner-failover.test.ts, test/rust-owner-clients.test.ts,
 * scripts/bench-rust-owner.ts). It opens a Rust engine on the real store through the napi addon named by
 * GBRAIN_RUST_ENGINE_ADDON and connects, so it becomes the brain's owner or a client of the owner.
 *
 *   bun test/helpers/rust-owner-child.ts <mode> <databasePath> <worker> [count]
 *
 * Modes (each prints one JSON line per event):
 * - `writer`: prints `{ready, role}`, then puts pages `fo/w<worker>-<n>` one after another and prints `{acked: slug}`
 *   after each put resolves, until it is killed. The test kills it mid-write.
 * - `mixed`: prints `{ready, role}`, waits for a line on stdin, then runs `count` operations, alternating a putPage of
 *   `mix/w<worker>-<n>` with a getPage of a page it already wrote. It prints `{done, latencies, errors}` with every
 *   operation's latency in ms and every error's code, then disconnects.
 *
 * With GBRAIN_TEST_OWNER_HOST_ID set, a child that is the owner first registers that host (host-registration.ts, the
 * lease a multi-user Rust brain's resident consumer holds) and prints its fence in the ready line as `fence`.
 */
import { loadRustAddon } from '../../src/core/rust-engine/addon-loader.ts';
import { openRustEngine } from '../../src/core/rust-engine.ts';
import { processOrigin, startHostRegistration } from '../../src/core/persistence/host-registration.ts';

const [mode, databasePath, workerText, countText] = process.argv.slice(2);
const worker = Number(workerText ?? 0);
const count = Number(countText ?? 100);

function say(line: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

async function main(): Promise<void> {
  const addon = await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: process.env.GBRAIN_RUST_ENGINE_ADDON } });
  const engine = openRustEngine({ addon, databasePath: databasePath! });
  await engine.connect({ engine: 'pglite', database_path: databasePath } as never);
  const hostId = process.env.GBRAIN_TEST_OWNER_HOST_ID;
  const fence = hostId && engine.ownerRole === 'owner'
    ? await startHostRegistration(engine, { hostId, origin: processOrigin(hostId, 'local_consumer:test') }).first
    : undefined;
  say({ ready: true, role: engine.ownerRole, pid: process.pid, ...(fence !== undefined ? { fence } : {}) });

  if (mode === 'writer') {
    for (let n = 0; ; n++) {
      const slug = `fo/w${worker}-${n}`;
      await engine.putPage(slug, { type: 'note', title: `Writer ${worker} page ${n}`, compiled_truth: `Page ${n}.` });
      say({ acked: slug });
    }
  }

  if (mode === 'mixed') {
    await new Promise<void>(resolve => process.stdin.once('data', () => resolve()));
    const latencies: number[] = [];
    const errors: string[] = [];
    let written = 0;
    const started = performance.now();
    for (let n = 0; n < count; n++) {
      const at = performance.now();
      try {
        if (n % 2 === 0) {
          await engine.putPage(`mix/w${worker}-${written}`, {
            type: 'note', title: `Mixed ${worker} ${written}`, compiled_truth: `Written by worker ${worker}.`,
          });
          written++;
        } else {
          const page = await engine.getPage(`mix/w${worker}-${Math.max(0, written - 1)}`);
          if (!page) errors.push('read_missing');
        }
      } catch (error) {
        errors.push(String((error as { code?: string }).code ?? (error as Error).name));
      }
      latencies.push(performance.now() - at);
    }
    say({ done: true, role: engine.ownerRole, ms: performance.now() - started, latencies, errors });
    await engine.disconnect();
    process.exit(0);
  }
  throw new Error(`unknown mode ${mode}`);
}

main().catch(error => {
  say({ fatal: String((error as { code?: string }).code ?? ''), message: (error as Error).message });
  process.exit(1);
});
