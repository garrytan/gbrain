/** One resumable, non-root local setup path. It never creates a personal identity or server. */
import { randomUUID } from 'node:crypto';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PGLiteEngine } from '../pglite-engine.ts';
import { PgliteBusyError } from '../pglite-lock.ts';
import { acquireBootstrapLock } from '../bootstrap/lock.ts';
import { harnessAdapter } from '../harness/registry.ts';
import { renderAgentLauncher } from './launcher.ts';
import { shellQuote } from '../mcp-registration.ts';
import {
  AgentInstallError, checkedRoot, confinedPath, installReceiptPath, isolatedAgentEnv, privateWrite,
  readFileConfigState, readInstallReceipt, sha256, writeInstallReceipt,
  type AgentHarness, type AgentInstallReceipt, type InstallArtifact,
} from './state.ts';

export interface AgentSetupOptions {
  root: string;
  harness: AgentHarness;
  /** Private bundle prepared by setup-in-agent.sh: bun + app/node_modules/gbrain. */
  bundle: string;
  sourceRef: string;
  adopt?: boolean;
  upgrade?: boolean;
}
export interface AgentSetupResult {
  status: 'installed' | 'repaired' | 'unchanged';
  root: string;
  launcher: string;
  repair: string;
  receipt: string;
  instructions: string;
  maintenance: string;
  native_verification: 'unverified';
  search_mode_confirmation_required: boolean;
}

async function cli(root: string, artifact: InstallArtifact, args: string[]): Promise<void> {
  const commandArgs = args.includes('--migrate-only') ? [...args, '--json'] : args;
  const child = Bun.spawn([join(root, artifact.directory, 'bun'), '--no-env-file', join(root, artifact.cli), '--brain', 'host', ...commandArgs], {
    cwd: root, env: { ...isolatedAgentEnv(root), DATABASE_URL: '', GBRAIN_DATABASE_URL: '', ...(args[0] === 'init' ? { GBRAIN_IN_AGENT_SETUP: '1' } : {}) },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  const timer = setTimeout(() => child.kill('SIGTERM'), 120_000);
  const killTimer = setTimeout(() => child.kill('SIGKILL'), 125_000);
  try {
    const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    // Preserve the real init [AGENT] search-mode cost matrix for the operator.
    if (output) process.stderr.write(output);
    if (errors) process.stderr.write(errors);
    if (code !== 0) {
      let failure: { error?: string; reason?: string; next_action?: string } | undefined;
      try { failure = JSON.parse(output); } catch { /* ordinary command error remains below */ }
      if (failure?.error === 'pglite_busy') throw new PgliteBusyError(
        failure.next_action ?? 'The database is busy. Wait for its owner to finish and rerun setup; do not remove its lock.',
        failure.reason === 'live_serve' ? 'live_serve' : 'timeout',
      );
      throw new AgentInstallError('setup_command_failed', `GBrain ${args[0]} failed (exit ${code}); rerun setup to resume. Existing data is preserved.`);
    }
  } finally { clearTimeout(timer); clearTimeout(killTimer); }
}

function verifyLocalState(root: string): void {
  const state = readFileConfigState(join(root, '.gbrain', 'config.json'));
  if (state.kind !== 'present' || state.config.remote_mcp || state.config.engine !== 'pglite' || state.config.database_url || state.config.database_path !== join(root, '.gbrain', 'brain.pglite')) {
    throw new AgentInstallError('incompatible_installation', 'This root is not the expected local PGLite installation. Use a different root or an explicit migration.');
  }
}

function artifactFromBundle(bundle: string, sourceRef: string): Omit<InstallArtifact, 'directory' | 'cli' | 'setup_entry'> {
  const root = checkedRoot(bundle);
  const bun = join(root, 'bun');
  const packageDir = join(root, 'app', 'node_modules', 'gbrain');
  const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  if (pkg.name !== 'gbrain' || typeof pkg.version !== 'string' || !existsSync(join(packageDir, 'src', 'cli.ts')) || !existsSync(join(packageDir, 'scripts', 'setup-in-agent.sh'))) {
    throw new AgentInstallError('invalid_artifact', 'Setup bundle does not contain the GBrain package and setup helper.');
  }
  if (!/^[a-f0-9]{40}$/.test(sourceRef)) throw new AgentInstallError('invalid_artifact_ref', 'A resolved 40-character source commit is required.');
  const version = Bun.spawnSync([bun, '--version'], { stdout: 'pipe', stderr: 'pipe' });
  if (version.exitCode !== 0) throw new AgentInstallError('runtime_unusable', 'The staged Bun runtime is not executable on this machine.');
  return { source_ref: sourceRef, version: pkg.version, bun_version: version.stdout.toString().trim(), bun_sha256: sha256(readFileSync(bun)), package_sha256: sha256(readFileSync(join(packageDir, 'package.json'))) };
}

function installArtifact(root: string, options: AgentSetupOptions, identity: ReturnType<typeof artifactFromBundle>): InstallArtifact {
  const directory = `runtime/${identity.version.replace(/[^a-zA-Z0-9.-]/g, '_')}-${randomUUID()}`;
  const target = confinedPath(root, directory);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const stage = `${target}.partial`;
  try {
    // Dereference package-manager links so the installed runtime is independent
    // of the temporary bundle and package cache. Validate the copied entrypoints.
    cpSync(options.bundle, stage, { recursive: true, dereference: true, errorOnExist: true, force: false });
    chmodSync(stage, 0o700); chmodSync(join(stage, 'bun'), 0o700);
    if (sha256(readFileSync(join(stage, 'bun'))) !== identity.bun_sha256) throw new AgentInstallError('artifact_checksum', 'Runtime copy did not match the staged checksum.');
    const cliPath = join(stage, 'app', 'node_modules', 'gbrain', 'src', 'cli.ts');
    if (!realpathSync(cliPath).startsWith(realpathSync(stage) + '/')) throw new AgentInstallError('artifact_escape', 'Package entrypoint escapes the installed artifact.');
    renameSync(stage, target);
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
  return { ...identity, directory, cli: `${directory}/app/node_modules/gbrain/src/cli.ts`, setup_entry: `${directory}/app/node_modules/gbrain/src/core/agent-install/entry.ts` };
}

function artifactUsable(root: string, artifact: InstallArtifact): boolean {
  try {
    if (!existsSync(confinedPath(root, artifact.cli)) || sha256(readFileSync(confinedPath(root, `${artifact.directory}/bun`))) !== artifact.bun_sha256) return false;
    const probe = Bun.spawnSync([join(root, artifact.directory, 'bun'), '--no-env-file', join(root, artifact.cli), '--version'], {
      cwd: root, env: { ...isolatedAgentEnv(root), DATABASE_URL: '', GBRAIN_DATABASE_URL: '' }, stdout: 'pipe', stderr: 'pipe', timeout: 15_000,
    });
    return probe.exitCode === 0;
  } catch { return false; }
}

/** Never overwrite an unowned or user-modified generated file. */
function ownFile(receipt: AgentInstallReceipt, path: string, text: string, mode = 0o600): boolean {
  const target = confinedPath(receipt.root, path);
  const desired = sha256(text);
  const pending = receipt.pending_files?.[path];
  if (existsSync(target)) {
    const actual = sha256(readFileSync(target));
    if (actual !== receipt.owned_files[path] && actual !== pending?.before && actual !== pending?.after) {
      throw new AgentInstallError('modified_owned_file', `Preserve your changes at ${target} before rerunning setup; it will not be overwritten.`);
    }
    if (actual === desired) {
      receipt.owned_files[path] = desired;
      if (receipt.pending_files) delete receipt.pending_files[path];
      writeInstallReceipt(receipt);
      return false;
    }
  }
  // Write-ahead ownership: a killed write can be resumed only for these bytes.
  receipt.pending_files ??= {};
  receipt.pending_files[path] = { before: existsSync(target) ? sha256(readFileSync(target)) : null, after: desired };
  writeInstallReceipt(receipt);
  privateWrite(target, text, mode);
  receipt.owned_files[path] = desired;
  delete receipt.pending_files[path];
  writeInstallReceipt(receipt);
  return true;
}

export function renderLocalInstructions(root: string, sourceId: string): string {
  const launcher = join(root, 'bin', 'gbrain');
  return `# GBrain memory

Use the executable \`${launcher}\` for this installation. It selects the host brain and source \`${sourceId}\`; use this same absolute path from every conversation and native routine.

Recall relevant memory before answering personal or continuing-work questions. Use \`gbrain recall --help\` through this launcher for the installed command schema. Explicitly remember user-requested durable facts, with their source and date. Preserve uncertainty and distinguish what the user said from an inference. Correct or forget outdated facts when asked; verify the change through a fresh recall. Forgetting withdraws active memory; history, source material, and private backups may remain. Never promise physical erasure. Never import connected-service history or enable automatic capture without the user's instruction.

Do not replace the agent's identity. This is one shared local installation, not a boundary between Bots. Memory calls are finite CLI processes. A busy database means another command is running: retry after it finishes; never remove its lock.

Load these instructions as a native saved skill/standing instruction. Confirm that a NEW conversation invokes this executable and recalls a randomized saved fact; platform-native memory alone is not verification. Native installation remains unverified until that test succeeds.
`;
}

export function renderLocalMaintenance(root: string, routineId: string): string {
  return `# GBrain maintenance (${routineId})

Create at most one native scheduled routine with this identifier for the shared installation. Use \`${join(root, 'bin', 'gbrain')}\` with absolute paths. First run \`doctor --fast --json\`; report failures. Run only configured maintenance that does not require missing provider credentials. Paid embedding/extraction is a separate user choice. Do not start serve, cron, or a daemon.

For a complete local backup, pause other memory/file writers and run \`backup create --output /absolute/private/path/unique.gbrain-backup\`. The parent directory must exist. Archives contain sensitive full database state, potentially including credentials; protect any explicitly chosen off-VM copy. Coverage checks and markdown exports are not full database backups.

Restore with \`backup restore /absolute/path/archive.gbrain-backup --into /absolute/new-root\`. Restoration never replaces an existing root and quarantines unfinished jobs. Reinstall the runtime using the setup helper, reconnect excluded credentials/services, and reattach this routine only after verifying the restored brain. No automation starts on restore.
`;
}

export async function setupInAgent(options: AgentSetupOptions): Promise<AgentSetupResult> {
  const root = checkedRoot(options.root);
  const adapter = harnessAdapter(options.harness);
  if (!['grok-bot', 'muse'].includes(adapter.id) || !adapter.modes.includes('local-cli')) throw new AgentInstallError('unsupported_harness', 'This local setup supports Grok Bot and Muse personal agents.');
  if (!existsSync(dirname(root))) throw new AgentInstallError('parent_missing', 'Create and verify the persistent parent directory first.');
  const existed = existsSync(root);
  if (!existed) mkdirSync(root, { mode: 0o700 });
  if (!lstatSync(root).isDirectory()) throw new AgentInstallError('invalid_root', 'Storage root is not a directory.');
  const lock = await acquireBootstrapLock(root);
  let receipt: AgentInstallReceipt | null = null;
  try {
    const restoreReceiptPath = confinedPath(root, 'restore-receipt.json');
    if (existsSync(restoreReceiptPath)) {
      let state: unknown;
      try { state = JSON.parse(readFileSync(restoreReceiptPath, 'utf8')).state; } catch { /* malformed restore state stays blocked */ }
      if (state !== 'ready') throw new AgentInstallError('restore_incomplete', 'This destination has an incomplete restore. Preserve it for inspection and restore into a new absent root before setup.');
    }
    receipt = readInstallReceipt(root);
    const configPath = join(root, '.gbrain', 'config.json');
    const config = readFileConfigState(configPath);
    const hasDb = existsSync(join(root, '.gbrain', 'brain.pglite'));
    if (!receipt) {
      const entries = readdirSync(root).filter(name => name !== '.gbrain-bootstrap.lock');
      if (config.kind === 'invalid') throw new AgentInstallError('invalid_config', 'Existing config is malformed; it will not be replaced.');
      if ((config.kind === 'present' || hasDb || entries.length) && !options.adopt) throw new AgentInstallError('adoption_required', 'This root contains unowned state. Choose an empty root or explicitly --adopt a compatible local brain.');
      if (options.adopt) {
        verifyLocalState(root);
        if (!hasDb) throw new AgentInstallError('missing_database', 'Adoption requires the existing database; setup will not replace it with an empty brain.');
      }
      receipt = {
        format_version: 1, installation_id: randomUUID(), root, harness: options.harness,
        source_id: 'default', database_path: join(root, '.gbrain', 'brain.pglite'), state: 'installing',
        initialized: !!options.adopt, adopted: !!options.adopt, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        managed_paths: options.adopt ? ['instructions'] : ['memory', 'instructions'], owned_files: {},
        native: { skill_id: '', routine_id: '', verification: 'unverified' }, search_mode_confirmation_required: !options.adopt,
      };
      receipt.native.skill_id = `gbrain-${receipt.installation_id}`;
      receipt.native.routine_id = `gbrain-maintenance-${receipt.installation_id}`;
      writeInstallReceipt(receipt);
    } else {
      if (receipt.harness !== options.harness) throw new AgentInstallError('harness_mismatch', `This installation belongs to ${receipt.harness}; reuse its existing launcher.`);
      if (receipt.initialized && (!hasDb || config.kind !== 'present')) throw new AgentInstallError('memory_missing', 'Previously initialized memory/config is missing. Restore a backup; setup will not create a replacement brain.');
      if (config.kind === 'invalid') throw new AgentInstallError('invalid_config', 'Existing config is malformed; recover it before setup.');
      if (config.kind === 'present') verifyLocalState(root);
      // A killed init can leave DB/config before all migrations or its journal
      // update. Their presence proves identity, not schema completion.
      if (!receipt.initialized && config.kind === 'present' && hasDb) {
        receipt.initialized = true; receipt.pending_runtime_migration = true; writeInstallReceipt(receipt);
      }
      if (!receipt.initialized && hasDb && config.kind === 'absent') throw new AgentInstallError('partial_database', 'Initialization left a database without configuration. Preserve it and recover its configuration before continuing.');
    }
    delete receipt.last_failure;
    let changed = false;
    const identity = artifactFromBundle(options.bundle, options.sourceRef);
    if (receipt.artifact && !options.upgrade && identity.source_ref !== receipt.artifact.source_ref) throw new AgentInstallError('artifact_version_mismatch', 'Repair must use the recorded source commit; use --upgrade to explicitly change versions.');
    const upgrade = !!options.upgrade && receipt.artifact?.source_ref !== identity.source_ref;
    if (!receipt.artifact || upgrade || !artifactUsable(root, receipt.artifact)) {
      receipt.artifact = installArtifact(root, options, identity);
      // The artifact pointer commits before migration. Keep the migration stage
      // independently durable so a failed/killed upgrade resumes even though
      // the next invocation now sees the same source ref as the receipt.
      receipt.pending_runtime_migration = receipt.initialized;
      receipt.state = 'installing'; writeInstallReceipt(receipt); changed = true;
    }
    const artifact = receipt.artifact;
    if (!receipt.initialized) {
      for (const path of receipt.managed_paths) mkdirSync(confinedPath(root, path), { recursive: true, mode: 0o700 });
      await cli(root, artifact, ['init', '--pglite', '--no-embedding', '--non-interactive']);
      verifyLocalState(root);
      receipt.initialized = true; writeInstallReceipt(receipt); changed = true;
    }
    if (receipt.pending_runtime_migration) {
      // apply-migrations also runs host harness/automation orchestrators. This
      // isolated installation only owns its configured database schema.
      await cli(root, artifact, ['init', '--migrate-only', '--non-interactive']);
      receipt.pending_runtime_migration = false; writeInstallReceipt(receipt); changed = true;
    }
    // A finite database probe also makes a ready receipt prove the installed
    // memory can actually be opened, rather than only that files exist.
    const engine = new PGLiteEngine();
    try {
      await engine.connect({ engine: 'pglite', database_path: receipt.database_path });
      if (!receipt.adopted) await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = $2 AND local_path IS NULL`, [join(root, 'memory'), receipt.source_id]);
      const sources = await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE id = $1 AND COALESCE(archived, FALSE) = FALSE', [receipt.source_id]);
      if (!sources.length) throw new AgentInstallError('source_missing', 'Configured source is missing or archived; repair source routing before setup.');
      receipt.schema_version = Number(await engine.getConfig('version'));
      receipt.capabilities = { transport: 'local-cli', engine: 'pglite', finite_database_probe: 'passed', native_runtime: 'unverified' };
    } finally { await engine.disconnect(); }
    for (const path of ['bin', 'instructions']) {
      const target = confinedPath(root, path);
      if (!existsSync(target)) mkdirSync(target, { mode: 0o700 });
    }
    const launcher = renderAgentLauncher({ root, bunPath: join(root, artifact.directory, 'bun'), cliPath: join(root, artifact.cli), sourceId: receipt.source_id, repairHint: `Run: bash ${shellQuote(join(root, 'bin', 'gbrain-setup'))}` });
    changed = ownFile(receipt, 'bin/gbrain', launcher, 0o700) || changed;
    const setupScript = readFileSync(join(root, artifact.directory, 'app', 'node_modules', 'gbrain', 'scripts', 'setup-in-agent.sh'), 'utf8');
    changed = ownFile(receipt, 'bin/gbrain-setup', setupScript, 0o700) || changed;
    changed = ownFile(receipt, 'instructions/gbrain-skill.md', renderLocalInstructions(root, receipt.source_id)) || changed;
    changed = ownFile(receipt, 'instructions/maintenance.md', renderLocalMaintenance(root, receipt.native.routine_id)) || changed;
    receipt.state = 'ready'; writeInstallReceipt(receipt);
    return {
      status: !existed ? 'installed' : changed ? 'repaired' : 'unchanged', root,
      launcher: join(root, 'bin', 'gbrain'), repair: join(root, 'bin', 'gbrain-setup'), receipt: installReceiptPath(root),
      instructions: join(root, 'instructions', 'gbrain-skill.md'), maintenance: join(root, 'instructions', 'maintenance.md'),
      native_verification: 'unverified', search_mode_confirmation_required: receipt.search_mode_confirmation_required,
    };
  } catch (error) {
    // Only the lock owner journals a recognized installation; preflight
    // conflicts must never create or adopt somebody else's receipt.
    if (receipt?.harness === options.harness) {
      receipt.state = 'installing';
      receipt.last_failure = { code: error instanceof AgentInstallError || error instanceof PgliteBusyError ? error.code : 'setup_failed', at: new Date().toISOString() };
      try { writeInstallReceipt(receipt); } catch { /* Preserve the original failure if storage itself is unavailable. */ }
    }
    throw error;
  } finally { lock.release(); }
}
