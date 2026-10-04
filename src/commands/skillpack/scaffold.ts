/**
 * `gbrain skillpack scaffold` — bundled-skill scaffold + third-party sources.
 *
 * Peeled from src/commands/skillpack.ts (module-size ratchet). Behavior is
 * unchanged from the façade version. Flag-registry note: this file is scanned
 * for skillpack's flag allowlist — spell foreign (non-skillpack) CLI flags
 * WITHOUT leading dashes in comments and strings.
 */

import { join } from 'path';

import {
  bundledSkillSlugs,
  findGbrainRoot,
  loadBundleManifest,
  BundleError,
} from '../../core/skillpack/bundle.ts';
import { runScaffold, ScaffoldError } from '../../core/skillpack/scaffold.ts';
import {
  RemoteSourceError,
  classifySpec,
  resolveSource,
} from '../../core/skillpack/remote-source.ts';
import {
  ScaffoldThirdPartyError,
  runScaffoldThirdParty,
} from '../../core/skillpack/scaffold-third-party.ts';
import { SkillpackManifestError } from '../../core/skillpack/manifest-v1.ts';
import { VERSION } from '../../version.ts';
import { findGbrainOrDie, resolveWorkspace } from './shared.ts';
import { consentGate } from '../../core/consent-cli.ts';

export async function cmdScaffold(args: string[]): Promise<void> {
  // Harness lane (cathedral-7): `--harness <h>` installs a persona-curated
  // set into a harness's native skills dir instead of a workspace.
  if (args.some(a => a === '--harness' || a.startsWith('--harness='))) {
    const { cmdScaffoldHarness } = await import('./harness.ts');
    await cmdScaffoldHarness(args);
    return;
  }
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      'gbrain skillpack scaffold <name> | <source> | --all [--workspace PATH] [--dry-run] [--trust] [--no-cache] [--json]\n\n' +
      '<name>   — bundled skill slug (e.g. `book-mirror`)\n' +
      '<source> — third-party skillpack source. Accepted shapes:\n' +
      '             owner/repo                (expands to https://github.com/owner/repo)\n' +
      '             https://...git            (verbatim https URL)\n' +
      '             ./local/dir/              (local pack root)\n' +
      '             ./local/pack.tgz          (local tarball)\n' +
      '\nFlags:\n' +
      '  --workspace PATH    Target workspace (default: auto-detected)\n' +
      '  --all               Scaffold every bundled skill (gbrain only)\n' +
      '  --dry-run           Validate + report; no writes\n' +
      '  --trust             The user\'s approval to trust a new third-party author + pin\n' +
      '                      (without it a non-interactive run writes nothing and exits 3)\n' +
      '  --no-cache          Force fresh clone/extract for third-party sources\n' +
      '  --json              Stable JSON envelope for agent consumption',
    );
    process.exit(0);
  }
  const json = args.includes('--json');
  const dryRun = args.includes('--dry-run');
  const all = args.includes('--all');
  const trustFlag = args.includes('--trust');
  const noCache = args.includes('--no-cache');
  let name: string | null = null;
  let workspace: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--workspace') {
      workspace = args[i + 1] ?? null;
      i++;
    } else if (a?.startsWith('--workspace=')) {
      workspace = a.slice('--workspace='.length) || null;
    } else if (a && !a.startsWith('--') && !name) {
      name = a;
    }
  }
  if (!all && !name) {
    console.error('Error: pass a skill name, third-party source, or --all.');
    process.exit(2);
  }

  // Disambiguate bundled-skill name vs third-party source.
  //
  // Routing rules (in priority order):
  //   1. `--all`                                       → bundled --all sweep
  //   2. Spec contains `/` / `://` / ends in .tgz      → third-party direct
  //   3. Bare kebab AND matches a bundled-skill slug   → bundled (v0.36 path)
  //   4. Bare kebab AND NOT a bundled-skill slug       → third-party via registry
  const targetWorkspace = resolveWorkspace({ workspace });

  const isThirdPartyShape = !all && name !== null && /[\/:]|\.(tgz|tar\.gz)$/.test(name);

  if (!all && name !== null && !isThirdPartyShape) {
    // Check if the kebab name matches a bundled-skill slug.
    const gbrainRoot = findGbrainRoot();
    if (gbrainRoot) {
      try {
        const manifest = loadBundleManifest(gbrainRoot);
        const slugs = bundledSkillSlugs(manifest);
        if (!slugs.includes(name)) {
          // Not a bundled slug — try the registry.
          await runThirdPartyScaffold({
            spec: name,
            targetWorkspace,
            dryRun,
            trustFlag,
            noCache,
            json,
            args,
          });
          return;
        }
      } catch {
        // Fall through to the bundled path; it'll surface a clearer error.
      }
    }
  } else if (isThirdPartyShape) {
    await runThirdPartyScaffold({
      spec: name!,
      targetWorkspace,
      dryRun,
      trustFlag,
      noCache,
      json,
      args,
    });
    return;
  }

  const gbrainRoot = findGbrainOrDie();
  try {
    const result = runScaffold({
      gbrainRoot,
      targetWorkspace,
      skillSlug: all ? null : name!,
      dryRun,
    });
    if (json) {
      console.log(JSON.stringify({ ok: true, dryRun: result.dryRun, summary: result.summary, files: result.files }, null, 2));
    } else {
      console.log(
        `${dryRun ? 'scaffold --dry-run' : 'scaffold'}: ${result.summary.wroteNew} wrote, ${result.summary.skippedExisting} skipped (already present), ${result.summary.pairedSourcesWritten} paired source(s)`,
      );
      // Next-action hint for the agent + the operator. Print only on
      // actual writes (re-runs that just skip are noise-quieter).
      if (!dryRun && result.summary.wroteNew > 0) {
        // Display-only hint path; targetWorkspace is the operator's own
        // --workspace flag on the local CLI plane (no untrusted input).
        // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
        const onboardingPath = join(targetWorkspace, 'skills', '_AGENT_README.md');
        console.log(
          `\nNext: your agent walks \`skills/*/SKILL.md\` frontmatter \`triggers:\` for routing.\nIf this is a fresh install, read ${onboardingPath} for the agent contract.\nWhen gbrain ships an update later, run \`gbrain skillpack reference --all\` to sweep.`,
        );
      }
    }
    process.exit(0);
  } catch (err) {
    if (err instanceof ScaffoldError || err instanceof BundleError) {
      console.error(`skillpack scaffold: ${(err as Error).message}`);
      process.exit(2);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// scaffold — third-party source path (new in v0.37)
// ---------------------------------------------------------------------------

interface ThirdPartyScaffoldOptions {
  spec: string;
  targetWorkspace: string;
  dryRun: boolean;
  trustFlag: boolean;
  noCache: boolean;
  json: boolean;
  /** Raw argv, for the consent request (`--yes`, `--trust`). */
  args: readonly string[];
}

async function runThirdPartyScaffold(opts: ThirdPartyScaffoldOptions): Promise<void> {
  // Step 1: resolve the source. Kebab names get a registry lookup first;
  // everything else hits the direct resolveSource() path.
  let resolved;
  let registryTier: 'endorsed' | 'community' | 'experimental' | 'dead' | undefined;
  try {
    const cls = classifySpec(opts.spec);
    if (cls.kind === 'kebab') {
      // Registry path: load catalog, find pack, follow to URL.
      const { loadRegistry, findPackWithTier } = await import('../../core/skillpack/registry-client.ts');
      const loaded = await loadRegistry({});
      const found = findPackWithTier(loaded, cls.normalized);
      if (!found) {
        console.error(
          `Error: no skillpack named "${cls.normalized}" in the registry (${loaded.registry_url}).\n` +
            `Run \`gbrain skillpack search ${cls.normalized}\` for matches, or pass a full source (owner/repo, https URL, ./path, ./*.tgz).`,
        );
        process.exit(2);
      }
      registryTier = found.tier;
      resolved = resolveSource(found.entry.source.url, { noCache: opts.noCache });
    } else {
      resolved = resolveSource(opts.spec, { noCache: opts.noCache });
    }
  } catch (err) {
    if (err instanceof RemoteSourceError) {
      console.error(`skillpack scaffold: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }

  // Step 2: orchestrator handles manifest validation, trust prompt, copy,
  // state.json update, and bootstrap display.
  try {
    const scaffold = (trustFlag: boolean) => runScaffoldThirdParty(
      {
        resolved,
        targetWorkspace: opts.targetWorkspace,
        trustFlag,
        dryRun: opts.dryRun,
        tier: registryTier,
      },
      VERSION,
    );
    let result = await scaffold(opts.trustFlag);
    // A4: no human to answer the trust prompt. The user decides whether this
    // author + pin is trusted: refuse with the consent payload (exit 3), or
    // proceed when the caller already carries the approval (--yes). A generic
    // persistent_install preapproval never trusts third-party code.
    if (result.status === 'aborted_no_trust' && result.trustDecision.reason === 'non_tty_no_trust_flag') {
      const m = result.manifest;
      const pin = result.resolved.pinned_commit ? `commit ${result.resolved.pinned_commit.slice(0, 12)}`
        : result.resolved.tarball_sha256 ? `tarball sha256:${result.resolved.tarball_sha256.slice(0, 12)}` : 'unpinned';
      const auth = await consentGate({
        command: 'skillpack scaffold', effects: ['persistent_install'], actor: 'agent',
        what: `Install the third-party skillpack ${m.name}@${m.version} by ${m.author}`,
        why: `Adds ${m.name}'s skills to this workspace (${m.description}).`,
        risk: `Copies third-party skills from ${result.resolved.source} (${pin}) into ${opts.targetWorkspace}; your agent will follow them as instructions, including any scripts they reference. `
          + 'Trust is recorded for this exact author and pin; a different author or pin asks again.',
        user_message: `Install the skillpack ${m.name} by ${m.author} from ${result.resolved.source} (${pin})? Its skills become instructions your agent follows.`,
        argv: ['gbrain', 'skillpack', 'scaffold', opts.spec, ...opts.args.filter(a => a !== opts.spec && a !== '--yes' && a !== '--trust')],
        args: opts.args,
      }, { json: opts.json, env: { preapprovals: {} } });
      if (!auth) return;
      result = await scaffold(true);
    }

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            ok: result.status !== 'aborted_no_trust',
            status: result.status,
            pack: {
              name: result.manifest.name,
              version: result.manifest.version,
              author: result.manifest.author,
            },
            source: result.resolved.source,
            source_kind: result.resolved.kind,
            pinned_commit: result.resolved.pinned_commit,
            tarball_sha256: result.resolved.tarball_sha256,
            cache_hit: result.resolved.cache_hit,
            trust: { trusted: result.trustDecision.trusted, reason: result.trustDecision.reason },
            copy: result.copy?.summary ?? null,
            bootstrap_shown: result.bootstrap.shown,
          },
          null,
          2,
        ),
      );
    } else {
      if (result.status === 'aborted_no_trust') {
        console.error(
          `skillpack scaffold: aborted (trust decision: ${result.trustDecision.reason}). No files written.`,
        );
        process.exit(1);
      }
      const m = result.manifest;
      const summary = result.copy?.summary;
      console.log(
        `${opts.dryRun ? 'scaffold (dry-run)' : 'scaffold'}: ${m.name}@${m.version} by ${m.author}` +
          (summary
            ? ` — ${summary.wroteNew} wrote, ${summary.skippedExisting} skipped`
            : ''),
      );
      if (result.resolved.kind !== 'local') {
        console.log(
          `Source: ${result.resolved.source}` +
            (result.resolved.pinned_commit ? ` @ ${result.resolved.pinned_commit.slice(0, 12)}` : ''),
        );
      }
      if (result.bootstrap.shown) {
        // Bootstrap framing on stderr so stdout stays clean for the agent contract.
        process.stderr.write('\n' + result.bootstrap.text + '\n');
      }
      if (!opts.dryRun && summary && summary.wroteNew > 0) {
        console.log(
          `\nNext: your agent walks skills/*/SKILL.md frontmatter triggers: for routing.\n` +
            `Run \`gbrain skillpack reference ${m.name}\` later if upstream changes.`,
        );
      }
    }
    process.exit(result.status === 'aborted_no_trust' ? 1 : 0);
  } catch (err) {
    if (err instanceof ScaffoldThirdPartyError || err instanceof SkillpackManifestError) {
      console.error(`skillpack scaffold: ${(err as Error).message}`);
      process.exit(2);
    }
    throw err;
  }
}
