/** An unmanaged `gbrain sync --dry-run` of a Google or GitHub source previews: no provider call, nothing written. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { parseGitHubSourceConfig, runGitHubSync } from '../src/core/github-source.ts';
import { createConnectorFixture, githubConfig, googleConfig, options } from './helpers/connector-fixture.ts';
import { withEnv } from './helpers/with-env.ts';

const { engines, env, source, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);

test('unmanaged dry run of google and github sources calls no provider and writes no page', async () => withEnv(env, async () => {
  for (const engine of engines) for (const connector of ['google', 'github'] as const) {
    const config = connector === 'google' ? googleConfig : githubConfig;
    const f = await source(engine, config);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    let calls = 0;
    const fetcher = async () => { calls++; throw new Error('Unexpected external request'); };
    const run = connector === 'google'
      ? runGoogleSync(engine, f.id, parseGoogleSourceConfig(config, f.dir), { ...options, dryRun: true }, fetcher)
      : runGitHubSync(engine, f.id, parseGitHubSourceConfig(config, f.dir), { ...options, dryRun: true }, fetcher);
    const outcome = await run.then(result => ({ status: result.status, added: result.added }), (error: Error) => ({ status: `threw: ${error.message}`, added: -1 }));
    expect(outcome).toEqual({ status: 'dry_run', added: 0 });
    expect(calls).toBe(0);
    const [pages] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE source_id=$1', [f.id]);
    expect(pages!.n).toBe(0);
  }
}), 120_000);
