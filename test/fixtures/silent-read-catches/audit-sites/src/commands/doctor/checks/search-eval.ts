// @ts-nocheck
// Pinned audit sites: code copied verbatim from src/commands/doctor/checks/search-eval.ts at origin/master 7ef3d53a47 (parsed by the guard test, never run).
// The test asserts each catch below is counted under the path#function key that scripts/silent-read-catches-baseline.tsv uses.

// verbatim src/commands/doctor/checks/search-eval.ts:25-78
export async function checkSearchMode(engine: BrainEngine): Promise<Check> {
  try {
    const mode = await engine.getConfig('search.mode');
    const overrides = await engine.listConfigKeys('search.');
    // Exclude search.mode itself + the upgrade-notice state key from the
    // override roster — they aren't knobs.
    const overrideKeys = overrides.filter(k => k !== 'search.mode' && k !== 'search.mode_upgrade_notice_shown' && k !== 'search.mode_source');

    const { loadSearchModeConfig, resolveSearchMode } = await import('../../../core/search/mode.ts');
    const loaded = await loadSearchModeConfig(engine);
    const resetReranker = resolveSearchMode({ mode: loaded.mode }).reranker_model;
    const context = !mode
      ? 'search.mode is unset (using balanced fallback). Run `gbrain search modes` to see what is running and pick a mode explicitly.'
      : overrideKeys.length === 0
        ? `Mode: ${mode} (no per-key overrides — mode bundle is canonical).`
        : `Mode: ${mode} with ${overrideKeys.length} per-key override(s) (${overrideKeys.join(', ')}).`;

    if (!mode || overrideKeys.length === 0) {
      return { name: 'search_mode', status: 'ok', message: context };
    }

    // An explicit `search.reranker.model` equal to the bundle default is
    // redundant, but `--reset` would also wipe every OTHER tuned search.*
    // knob — name the exact key instead. (Installs from v0.46.3–v0.47.10
    // carry an init-written `voyage:rerank-2.5` row; since the default moved
    // to rerank-3-lite that row is a real pin and keeps them on rerank-2.5.)
    const redundant: string[] = [];
    if (resetReranker !== undefined) {
      const explicitModel = await engine.getConfig('search.reranker.model');
      if (explicitModel && explicitModel === resetReranker) redundant.push('search.reranker.model');
    }
    if (redundant.length > 0 && redundant.length === overrideKeys.length) {
      return {
        name: 'search_mode',
        status: 'ok',
        message:
          `${context} The override equals the mode bundle's own default, so it is redundant: ` +
          `gbrain config unset ${redundant.join(' ')}`,
      };
    }

    return {
      name: 'search_mode',
      status: 'ok',
      message: `${context} To consolidate to the pure mode bundle: gbrain search modes --reset`,
    };
  } catch (e) {
    return {
      name: 'search_mode',
      status: 'ok',
      message: `Could not read search mode config (${(e as Error).message ?? 'unknown'}).`,
    };
  }
}
