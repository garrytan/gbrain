import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseGitHubSourceConfig, runGitHubSync } from '../src/core/github-source.ts';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { beginConnectorSync } from '../src/core/persistence/connector-sync.ts';
import { withEnv } from './helpers/with-env.ts';
import { createConnectorFixture, options, json, googleConfig, githubConfig, contact, githubFetch, sourceCheckpoint } from './helpers/connector-fixture.ts';

const { engines, env, boundSource, standaloneConnector, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);

test('standalone connector restart recovers a real SIGKILL after file publication without a resident consumer', async () => withEnv(env, async () => {
  for (const engine of engines) for (const connector of ['google', 'github'] as const) {
    const config = connector === 'google' ? googleConfig : githubConfig;
    const f = await boundSource(engine, config);
    if (connector === 'google') await runGoogleSync(engine, f.id, parseGoogleSourceConfig(config, f.dir), options, async url =>
      json(url.includes('/settings/sendAs') ? { sendAs: [] } : { connections: [{ ...contact('first', 'First Example'),
        organizations: [{ name: 'Initial organization' }] }], nextSyncToken: 'contacts-restart' }));
    else await runGitHubSync(engine, f.id, parseGitHubSourceConfig(config, f.dir), options, githubFetch());
    const slug = connector === 'google' ? 'people/first-example' : 'gh/acme-example/app/1';
    const before = await engine.readPageSnapshot(slug, { sourceId: f.id });
    const crash = await standaloneConnector(engine, f, config, true);
    expect(crash.stdout).toContain('CONNECTOR_AFTER_PUBLICATION_BEFORE_COMMIT');
    expect(crash.exitCode).not.toBe(0);
    const [retained] = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE source_id=$1 AND recovery IS NOT NULL', [f.id]);
    expect(retained).toBeDefined();
    expect((await engine.readPageSnapshot(slug, { sourceId: f.id }))?.revision).toBe(before?.revision);
    expect(readFileSync(join(f.dir, `${slug}.md`), 'utf8')).toContain('Updated organization after interruption');
    const restart = await standaloneConnector(engine, f, config);
    expect(restart.stdout).toContain('CONNECTOR_RESULT');
    expect(restart.exitCode).toBe(0);
    expect((await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid', [retained.id]))[0]).toMatchObject({ state: 'committed', recovery: null });
    expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1 AND recovery IS NOT NULL', [f.id])).toHaveLength(0);
    const after = (await engine.readPageSnapshot(slug, { sourceId: f.id }))!;
    expect(after.page.compiled_truth).toContain('Updated organization after interruption');
    expect(parseMarkdown(readFileSync(join(f.dir, `${slug}.md`), 'utf8'), slug).compiled_truth).toBe(after.page.compiled_truth);
  }
}), 120_000);

test('standalone retained recovery preserves operator edits and rejects changed grants, sources, and owners before fetching', async () => withEnv(env, async () => {
  for (const engine of engines) for (const change of ['operator-edit', 'grant', 'source', 'owner'] as const) {
    const f = await boundSource(engine, githubConfig);
    await runGitHubSync(engine, f.id, parseGitHubSourceConfig(githubConfig, f.dir), options, githubFetch());
    const checkpoint = await sourceCheckpoint(engine, f.id);
    const crash = await standaloneConnector(engine, f, githubConfig, true);
    expect(crash.stdout).toContain('CONNECTOR_AFTER_PUBLICATION_BEFORE_COMMIT');
    const [retained] = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE source_id=$1 AND recovery IS NOT NULL', [f.id]);
    const beforeRequests = await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1 ORDER BY sequence', [f.id]);
    const [writer] = await engine.executeRaw<{ grant_ceiling: unknown }>('SELECT grant_ceiling FROM persistence_local_writers WHERE id=$1::uuid', [retained.principal_id]);
    const path = join(f.dir, 'gh/acme-example/app/1.md');
    const published = readFileSync(path, 'utf8');
    const edited = `${published}\nOperator edit must survive.\n`;
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    if (change === 'operator-edit') writeFileSync(path, edited);
    else if (change === 'grant') await engine.executeRaw("UPDATE persistence_local_writers SET grant_ceiling=jsonb_set(grant_ceiling,'{scopes}','[]'::jsonb) WHERE id=$1::uuid", [retained.principal_id]);
    else if (change === 'source') await engine.executeRaw('UPDATE sources SET config=$2::text::jsonb WHERE id=$1', [f.id, JSON.stringify({ ...githubConfig, gh_repos: 'foreign-example/app' })]);
    else await engine.executeRaw('UPDATE persistence_worktrees SET owner_host_id=$2::uuid WHERE id=$1::uuid', [f.binding.worktree_id, randomUUID()]);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    try {
      const started = performance.now();
      const blocked = await standaloneConnector(engine, f, githubConfig);
      expect(performance.now() - started).toBeLessThan(15_000);
      expect(blocked.exitCode).toBe(1);
      expect(blocked.stdout).not.toContain('CONNECTOR_FIXTURE_FETCH');
      const failure = JSON.parse(blocked.stdout.split('CONNECTOR_ERROR ')[1].trim());
      expect(failure.code).toBe(change === 'operator-edit' ? 'recovery_required' : change === 'grant' ? 'permission_denied'
        : change === 'source' ? 'source_changed' : 'owner_unavailable');
      if (change === 'operator-edit') expect(failure.receipt).toMatchObject({ request_id: retained.request_id, blocked_reason: 'unexpected_file_bytes' });
      expect(readFileSync(path, 'utf8')).toBe(change === 'operator-edit' ? edited : published);
      expect((await engine.getPage('gh/acme-example/app/1', { sourceId: f.id }))?.compiled_truth).toContain('synthetic issue');
      expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1 ORDER BY sequence', [f.id])).toEqual(beforeRequests);
      expect(await sourceCheckpoint(engine, f.id)).toEqual(checkpoint);
    } finally {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      if (change === 'operator-edit') writeFileSync(path, published);
      else if (change === 'grant') await engine.executeRaw('UPDATE persistence_local_writers SET grant_ceiling=$2::text::jsonb WHERE id=$1::uuid', [retained.principal_id, JSON.stringify(writer.grant_ceiling)]);
      else if (change === 'source') await engine.executeRaw('UPDATE sources SET config=$2::text::jsonb WHERE id=$1', [f.id, JSON.stringify(githubConfig)]);
      else await engine.executeRaw('UPDATE persistence_worktrees SET owner_host_id=$2::uuid WHERE id=$1::uuid', [f.binding.worktree_id, f.binding.owner_host_id]);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    }
    expect((await standaloneConnector(engine, f, githubConfig)).exitCode).toBe(0);
    expect((await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid', [retained.id]))[0]).toMatchObject({ state: 'committed', recovery: null });
  }
}), 120_000);

test('an already authenticated connector session drains later retained recovery before reads and direct submit identity', async () => withEnv(env, async () => {
  for (const engine of engines) for (const entry of ['page', 'submit'] as const) {
    const f = await boundSource(engine, githubConfig);
    const config = parseGitHubSourceConfig(githubConfig, f.dir);
    await runGitHubSync(engine, f.id, config, options, githubFetch());
    await disposePersistenceConsumer(engine);
    const session = (await beginConnectorSync(engine, f.id, 'github', config, options))!;
    const crash = await standaloneConnector(engine, f, githubConfig, true);
    expect(crash.stdout).toContain('CONNECTOR_AFTER_PUBLICATION_BEFORE_COMMIT');
    const [retained] = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE source_id=$1 AND recovery IS NOT NULL', [f.id]);
    if (entry === 'page') expect((await session.page('gh/acme-example/app/1'))?.compiled_truth).toContain('Updated organization after interruption');
    else expect((await session.importMarkdown('gh/acme-example/app/1.md', retained.intent!.content as string)).status).toBe('skipped');
    expect((await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid', [retained.id]))[0]).toMatchObject({ state: 'committed', recovery: null });
    expect(await engine.executeRaw("SELECT id FROM persistence_requests WHERE source_id=$1 AND state<>'committed'", [f.id])).toHaveLength(0);
    expect((await session.page('gh/acme-example/app/1'))?.compiled_truth).toContain('Updated organization after interruption');
  }
}), 120_000);
