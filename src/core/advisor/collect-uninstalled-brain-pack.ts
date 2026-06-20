/**
 * advisor/collect-uninstalled-brain-pack.ts — brain-resident packs the user
 * hasn't installed.
 *
 * workspace_dependent (A1): "installed" is a property of the local install
 * ledger (skillpack-state.json) — meaningless on the server side. runAdvisor
 * drops these over MCP. Respects the nag ceiling so a long-ignored pack stops
 * appearing (consistent with the Topology-A advisory; one nag engine).
 */

import { existsSync } from 'fs';
import { join } from 'path';

import { loadAllSources } from '../sources-load.ts';
import { loadSkillpackManifest } from './../skillpack/manifest-v1.ts';
import { loadState, findEntry } from './../skillpack/state.ts';
import { loadNagState, findNag, decideNagAction } from './../skillpack/nag-state.ts';
import { deriveBrainId } from './../skillpack/brain-resident-locate.ts';
import type { AdvisorCollector, AdvisorFinding } from './types.ts';

export const collectUninstalledBrainPack: AdvisorCollector = {
  id: 'uninstalled-brain-pack',
  collect: async (ctx) => {
    if (ctx.remote) return []; // A1: no workspace/install ledger over MCP
    const findings: AdvisorFinding[] = [];

    let sources;
    try {
      sources = await loadAllSources(ctx.engine);
    } catch {
      return [];
    }
    const state = loadState();
    const nag = loadNagState();

    for (const src of sources) {
      const localPath = src.local_path;
      if (!localPath || !existsSync(join(localPath, 'skillpack.json'))) continue;
      try {
        const manifest = loadSkillpackManifest(localPath);
        if (manifest.brain_resident !== true) continue;

        const entry = findEntry(state, manifest.name);
        const installed = !!entry && entry.version === manifest.version;
        if (installed) continue;

        // Honor the nag ceiling so a long-ignored pack goes quiet.
        const remoteUrl = (src.config as Record<string, unknown>)?.remote_url as string | undefined;
        const brainId = deriveBrainId(remoteUrl ?? null, localPath);
        const decision = decideNagAction(
          findNag(nag, { brain_id: brainId, source_id: src.id, pack_name: manifest.name }),
          { pack_version: manifest.version },
        );
        if (!decision.show) continue;

        findings.push({
          id: `uninstalled_brain_pack:${src.id}:${manifest.name}`,
          severity: 'info',
          title: `Brain source "${src.id}" ships ${manifest.skills.length} skill${manifest.skills.length === 1 ? '' : 's'} you haven't installed (${manifest.name}).`,
          detail: 'These skills were authored for this brain. Install them to get its full operating manual.',
          fix: { command_argv: ['gbrain', 'skillpack', 'scaffold', localPath] },
          collector: 'uninstalled-brain-pack',
          ask_user: true,
          workspace_dependent: true,
        });
      } catch {
        continue;
      }
    }
    return findings;
  },
};
