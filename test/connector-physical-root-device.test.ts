/**
 * #5604 for managed connectors: a device-only physical-root change (a macOS
 * reboot renumbering the filesystem) is re-stamped by the connector's locked
 * worktree acquisition before the connector root is asserted, so Google and
 * GitHub sync keep running like every other managed writer.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseGitHubSourceConfig, runGitHubSync } from '../src/core/github-source.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { PHYSICAL_ROOT_MARKER, physicalRootReservationPath } from '../src/core/persistence/physical-root-record.ts';
import { withEnv } from './helpers/with-env.ts';
import { createConnectorFixture, options, json, githubConfig, issueFixture, githubFetch } from './helpers/connector-fixture.ts';

const { engines, env, boundSource, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });

test('a device-only change is re-stamped and managed connector sync continues', async () => {
  await withEnv(env, async () => {
    for (const engine of engines) {
      const f = await boundSource(engine, githubConfig);
      let body = 'Before the reboot';
      const run = () => runGitHubSync(engine, f.id, parseGitHubSourceConfig(githubConfig, f.dir),
        { ...options, githubItem: { repo: 'acme-example/app', number: 1, kind: 'issue' } },
        async url => new URL(url).pathname.endsWith('/issues/1') ? json({ ...issueFixture, body }) : githubFetch()(url));
      await run();
      await disposePersistenceConsumer(engine);
      const root = f.binding.local_path!;
      const live = statSync(root, { bigint: true }).dev.toString();
      const previous = String(BigInt(live) + 1n);
      const marker = join(root, PHYSICAL_ROOT_MARKER), reservation = physicalRootReservationPath(root);
      writeJson(marker, { ...readJson(marker), device: previous });
      writeJson(reservation, { ...readJson(reservation), initialDevice: previous });
      body = 'After the reboot';
      expect((await run()).modified).toBe(1);
      await disposePersistenceConsumer(engine);
      expect(readFileSync(join(f.dir, 'gh/acme-example/app/1.md'), 'utf8')).toContain('After the reboot');
      expect(readJson(marker).device).toBe(live);
      expect(readJson(reservation).initialDevice).toBe(live);
    }
  });
}, 120_000);
