/**
 * GBRA-283 B3a (N2): visibility.honor_aliases and search.remote_private_pages are per engine for engines opened from
 * settings. Inside such an engine's scope its own setting decides (one brain's setting never decides another's), and
 * the process-wide sets that the CLI's lean-private rule reads never hold an embedded engine, so a per-call engine is
 * not retained after it closes. The CLI keeps its process-wide behaviour.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { openEngine, withEngineScope, withLocalScope, type EngineSettings } from '../src/core/engine-open.ts';
import { createEngine } from '../src/core/engine-factory.ts';
import {
  HONOR_ALIASES_KEY, REMOTE_PRIVATE_PAGES_KEY, __aliasPolicyEngineCountForTests, __resetPrivateVisibilityCacheForTests,
  currentCallerAccess, isPrivacyPrivatePage, readHonorAliases, remotePrivacyRelaxed,
} from '../src/core/search/private-visibility.ts';
import { waitFor } from './helpers/wait-for.ts';

const settings = (): EngineSettings => ({ embedded_core: true, engine: 'pglite', database: {}, host: { id: randomUUID() } });
const aliased = { type: 'note', frontmatter: { access: 'private' } };

afterEach(() => __resetPrivateVisibilityCacheForTests());

describe('per-engine alias and privacy policy', () => {
  test('two embedded engines with opposite visibility.honor_aliases each follow their own', async () => {
    const off = await openEngine(settings());
    const on = await openEngine(settings());
    try {
      await off.initSchema();
      await on.initSchema();
      await off.setConfig(HONOR_ALIASES_KEY, 'false');
      for (const order of [[off, on], [on, off]]) {
        __resetPrivateVisibilityCacheForTests();
        for (const engine of order) await readHonorAliases(engine);
        expect(withEngineScope(off, () => isPrivacyPrivatePage(aliased))).toBe(false);
        expect(withEngineScope(on, () => isPrivacyPrivatePage(aliased))).toBe(true);
      }
    } finally {
      await Promise.all([off.disconnect(), on.disconnect()]);
    }
  }, 120_000);

  test('the CLI keeps the process-wide lean-private rule', async () => {
    const off = await createEngine({ engine: 'pglite' });
    const on = await createEngine({ engine: 'pglite' });
    try {
      await off.connect({ engine: 'pglite' } as never);
      await on.connect({ engine: 'pglite' } as never);
      await off.initSchema();
      await on.initSchema();
      await off.setConfig(HONOR_ALIASES_KEY, 'false');
      await readHonorAliases(off);
      expect(withLocalScope(() => isPrivacyPrivatePage(aliased))).toBe(false);
      await readHonorAliases(on);
      expect(withLocalScope(() => isPrivacyPrivatePage(aliased))).toBe(true);
    } finally {
      await Promise.all([off.disconnect(), on.disconnect()]);
    }
  }, 120_000);

  test('an unscoped read stays strict while the process holds an embedded engine, whatever a local engine set', async () => {
    const embedded = await openEngine(settings());
    const local = await createEngine({ engine: 'pglite' });
    try {
      await local.connect({ engine: 'pglite' } as never);
      await local.initSchema();
      await local.setConfig(HONOR_ALIASES_KEY, 'false');
      await local.setConfig(REMOTE_PRIVATE_PAGES_KEY, 'visible');
      await readHonorAliases(local);
      await remotePrivacyRelaxed(local);
      expect(withLocalScope(() => isPrivacyPrivatePage(aliased))).toBe(false);
      expect(withLocalScope(() => currentCallerAccess().hidePrivate)).toBe(false);
      expect(isPrivacyPrivatePage(aliased)).toBe(true);
      expect(currentCallerAccess().hidePrivate).toBe(true);
    } finally {
      await Promise.all([embedded.disconnect(), local.disconnect()]);
    }
  }, 120_000);

  test('open, read and close cycles retain no embedded engine in the policy sets', async () => {
    const refs: WeakRef<object>[] = [];
    for (let i = 0; i < 5; i++) {
      const engine = await openEngine(settings());
      await engine.initSchema();
      await engine.setConfig(REMOTE_PRIVATE_PAGES_KEY, i % 2 ? 'visible' : 'hidden');
      await withEngineScope(engine, () => remotePrivacyRelaxed(engine));
      await readHonorAliases(engine);
      refs.push(new WeakRef(engine));
      await engine.disconnect();
    }
    expect(__aliasPolicyEngineCountForTests()).toBe(0);
    await waitFor(() => { Bun.gc(true); return refs.some(ref => ref.deref() === undefined); }, { timeoutMs: 10_000, intervalMs: 50, label: 'a closed engine collected' });
    expect(refs.filter(ref => ref.deref() !== undefined).length).toBeLessThan(refs.length);
  }, 120_000);
});
