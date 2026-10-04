/**
 * A1: the CLI process's routing provider for the render-time pin
 * (src/core/fix-routing.ts), installed by src/cli.ts once global flags are parsed.
 */
import { isThinClient, loadConfig } from '../core/config.ts';
import { resolveBrainId } from '../core/brain-resolver.ts';
import { getCliOptions } from '../core/cli-options.ts';
import { resolveSourceIdEngineFree } from '../core/source-resolver.ts';
import { installCliRouting, recordedSource, routingFlagsFor, type FixRouting } from '../core/fix-routing.ts';

/**
 * Install the pin for this invocation. `serve` installs nothing: its fixes are rendered per request by
 * dispatch (the served brain + the request's source), and a long-lived
 * process must not pin the first request's source onto later ones.
 */
export function installCliRoutingFor(currentCommand: () => string | undefined, args: readonly string[]): void {
  if (currentCommand() === 'serve') return;
  installCliRouting(cliRoutingProvider(currentCommand, args));
}

/**
 * A1: the routing every CLI-surface fix in this invocation pins
 * (src/core/fix-routing.ts). Brain: the id connectEngine resolves (flag →
 * GBRAIN_BRAIN_ID → .gbrain-mount → mount path → host). Source: the first
 * source the invocation resolved through the ambient chain, else the
 * engine-free tiers for a command that routes `--source`. A thin client pins
 * nothing: it has no local mounts (`--brain` is refused there) and its remote
 * scopes the source.
 */
export function cliRoutingProvider(currentCommand: () => string | undefined, args: readonly string[]): () => FixRouting | undefined {
  let base: { thin: boolean; brain?: string; source?: string } | null = null;
  return () => {
    if (!base) {
      const thin = isThinClient(loadConfig());
      let brain: string | undefined;
      let source: string | undefined;
      if (!thin) {
        try { brain = resolveBrainId(getCliOptions().brain); } catch { /* unresolvable: no brain pin */ }
        const cmd = currentCommand();
        if (cmd && routingFlagsFor(cmd).source) {
          const end = args.indexOf('--');
          const head = end === -1 ? args : args.slice(0, end);
          const i = head.findIndex(a => a === '--source' || a.startsWith('--source='));
          const explicit = i === -1 ? null : head[i]!.startsWith('--source=') ? head[i]!.slice('--source='.length) : head[i + 1] ?? null;
          try { source = resolveSourceIdEngineFree(explicit) ?? undefined; } catch { /* invalid: no source pin */ }
        }
      }
      base = { thin, brain, source };
    }
    if (base.thin) return undefined;
    const source = recordedSource() ?? base.source;
    return { ...(base.brain ? { brain: base.brain } : {}), ...(source ? { source } : {}) };
  };
}
