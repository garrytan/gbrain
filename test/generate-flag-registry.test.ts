/**
 * Flag-registry attribution — the marker-segmentation rule of
 * scripts/generate-flag-registry.ts.
 *
 * Invariant under test: a `--flag` literal in handleCliOnly belongs to the
 * command named in the `command === 'X'` head of the enclosing `if` / `case`,
 * for EVERY dispatch shape (plain, compound `&& args[0] === 'sub'`,
 * multi-line compound). Pre-fix only the plain shape was a marker, so every
 * `eval <sub>` no-DB bypass block was attributed to the preceding marker
 * (`dream`) and the documented `gbrain eval longmemeval <f> --retrieval-only
 * --by-type --no-trajectory` invocation exited 1 as an unknown flag.
 *
 * Three lanes: (1) pure segmentation on a synthetic snippet, (2) the
 * committed registry's eval row (acceptance) + the rows that used to absorb
 * the misattributed text (regression pins), (3) rejection — the eval row is a
 * UNION across eval subcommands by design (the registry's shape for every
 * multi-subcommand command), so a flag unknown to every subcommand is still
 * refused; per-subcommand rows are a filed TODO, not this lane.
 */
import { describe, test, expect } from 'bun:test';
import ts from 'typescript';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { segmentDispatchBlocks, buildFlagRegistry, isValueOnlyImport, stripComments } from '../scripts/generate-flag-registry.ts';
import { CLI_FLAG_REGISTRY } from '../src/core/cli-flag-registry.generated.ts';
import { validateCommandFlags } from '../src/cli.ts';

/**
 * The flags the plan names for `gbrain eval longmemeval`, plus a sample of
 * the rest of eval-longmemeval.ts parseArgs. Every entry MUST be a literal in
 * src/commands/eval-longmemeval.ts (the generator scans the command module +
 * one import level) — a flag that only ever lived in a helper's prose (the
 * pre-fix `--parity-baseline`, which reached the row via gateway.ts's deps)
 * is exactly the phantom class this file guards against. `--judge-model` was
 * once such a phantom; since the Phase D judge lane it is a REAL longmemeval
 * flag (LME_FLAGS) and is asserted present, not absent.
 */
const LONGMEMEVAL_FLAGS = [
  '--retrieval-only',
  '--by-type',
  '--no-trajectory',
  '--keyword-only',
  '--expansion',
  '--resume-from',
  '--by-type-floor',
  '--capture-pool',
  '--autocut',
  '--reranker',
  '--include-abstention',
  '--output',
  '--limit',
  '--top-k',
  '--mode',
  // Phase D judged-answer lane.
  '--judge',
  '--judge-model',
  '--max-usd',
  '--yes',
  '--judge-concurrency',
  '--allow-incomplete-judgments',
  '--search-pin',
];

/** Real `gbrain agent register` flags (src/commands/agent-register.ts parseArgs / help). */
const AGENT_REGISTER_FLAGS = [
  '--harness',
  '--preset',
  '--reissue',
  '--token-ttl',
  '--allow-old-serve',
  '--scopes',
  '--show-token',
  '--federated-read',
  '--surface',
  '--url',
  '--port',
];

/**
 * Flags of the `uninstall` / `sources` / `connect` surfaces that reach the
 * agent-register pre-connect guard ONLY through helper imports
 * (`./core/bootstrap/uninstall.ts`, and agent-register.ts's own deps via the
 * value-only `THIN_CLIENT_REGISTER_MESSAGE` import). None is an agent flag.
 */
const AGENT_PHANTOM_FLAGS = ['--delete-brain', '--confirm-destructive', '--break-lock', '--force', '--remove', '--home', '--project', '--workspace'];

describe('segmentDispatchBlocks — every if/case shape is a marker for its command', () => {
  const SNIPPET = [
    `  if (command === 'alpha') {`,
    `    args.includes('--alpha-flag');`,
    `  }`,
    `  if (command === 'beta' && args[0] === 'sub') {`,
    `    args.includes('--beta-sub-flag');`,
    `  }`,
    `  if (`,
    `    command === 'gamma' &&`,
    `    (args.length === 0 || args[0] === '--help')`,
    `  ) {`,
    `    args.includes('--gamma-flag');`,
    `  }`,
    `  const degradable =`,
    `    command === 'serve' &&`,
    `    process.env.X !== '0';`,
    `  switch (command) {`,
    `      case 'beta': {`,
    `        args.includes('--beta-case-flag');`,
    `      }`,
    `      case 'delta': {`,
    `        args.includes('--delta-flag');`,
    `      }`,
    `  }`,
  ].join('\n');

  test('plain, compound, and multi-line compound `if` heads each own their block', () => {
    const blocks = segmentDispatchBlocks(SNIPPET);
    expect(blocks.get('alpha')).toContain('--alpha-flag');
    expect(blocks.get('alpha')).not.toContain('--beta-sub-flag');
    // Compound condition: the block belongs to beta, NOT to the preceding
    // marker (alpha) — the pre-fix misattribution.
    expect(blocks.get('beta')).toContain('--beta-sub-flag');
    // Multi-line compound: `if (\n    command === 'gamma' &&`.
    expect(blocks.get('gamma')).toContain('--gamma-flag');
    expect(blocks.get('beta')).not.toContain('--gamma-flag');
  });

  test('a command with an `if` bypass AND a `case` label unions both blocks', () => {
    const blocks = segmentDispatchBlocks(SNIPPET);
    expect(blocks.get('beta')).toContain('--beta-sub-flag');
    expect(blocks.get('beta')).toContain('--beta-case-flag');
    expect(blocks.get('delta')).toContain('--delta-flag');
    expect(blocks.get('delta')).not.toContain('--beta-case-flag');
  });

  test('a bare `command === X` in a non-if expression is NOT a marker', () => {
    // The serve `degradable` const in cli.ts: its text stays with the
    // enclosing block (gamma here), and no 'serve' block is minted.
    const blocks = segmentDispatchBlocks(SNIPPET);
    expect(blocks.has('serve')).toBe(false);
    expect(blocks.get('gamma')).toContain('degradable');
  });

  test('a comment between two markers registers no flags for the preceding marker', () => {
    // cli.ts: the `reindex --help` bypass is introduced by a comment naming
    // "the --multimodal flags the dispatcher parses"; that comment sits AFTER
    // the storage marker and BEFORE the reindex marker, so storage grew a
    // phantom --multimodal. Comments are prose, not consumption.
    const snippet = [
      `  if (command === 'storage' && args.includes('--help')) {`,
      `    const { runStorage } = await import('./commands/storage.ts');`,
      `  }`,
      ``,
      `  // reindex --help — the usage block (incl. the --multimodal flags`,
      `  // the dispatcher parses) lives in reindex.ts. /* --block-comment-flag */`,
      `  /* a block comment`,
      `     mentioning --spanning-flag too */`,
      `  if (command === 'reindex' && args.includes('--help')) {`,
      `    printReindexHelp(); // prints --real-reindex-flag help`,
      `    const url = 'https://example.invalid/not-a-comment --in-string-flag';`,
      `  }`,
    ].join('\n');
    const blocks = segmentDispatchBlocks(snippet);
    expect(blocks.get('storage')).not.toContain('--multimodal');
    expect(blocks.get('storage')).not.toContain('--block-comment-flag');
    expect(blocks.get('storage')).not.toContain('--spanning-flag');
    expect(blocks.get('reindex')).not.toContain('--real-reindex-flag'); // trailing // comment
    expect(blocks.get('reindex')).toContain('--in-string-flag'); // a `//` inside a string literal is not a comment
    expect(blocks.get('reindex')).toContain('printReindexHelp');
    expect(blocks.get('storage')).toContain(`import('./commands/storage.ts')`);
    // Line structure survives stripping (isValueOnlyImport scans by line):
    // the storage block has exactly as many lines as its raw slice.
    const rawStorage = snippet.slice(0, snippet.indexOf(`  if (command === 'reindex'`));
    expect(blocks.get('storage')!.split('\n').length).toBe(rawStorage.split('\n').length);
  });

  test('stripComments: line + block comments go, newlines and string literals stay', () => {
    const src = "a(); // --c1\nb('x // --c2'); /* --c3\n --c4 */ c(); `t // --c5 ${d}`\n\"q /* --c6 */\"";
    const out = stripComments(src);
    expect(out).toBe("a(); \nb('x // --c2'); \n c(); `t // --c5 ${d}`\n\"q /* --c6 */\"");
    expect(out.split('\n').length).toBe(src.split('\n').length);
    // An unterminated block comment strips to the end without throwing.
    expect(stripComments('x /* never closed --c7')).toBe('x ');
  });

  test('stripComments never deletes a real flag from any scanned source file (TS-AST ground truth)', () => {
    // stripComments does not model regex literals: a `//` at a code-classified
    // position (`split(/\//)`, a `[//]` char class) deletes the rest of that
    // line. Today no src file trips it, but a future one would regenerate
    // IDENTICALLY on both sides of the freshness gate — the registry would
    // silently lose a real flag and the validator would reject a working
    // invocation. Ground truth here is the real TypeScript parser: every
    // --flag inside a string/template literal must survive stripComments.
    const FLAG_RE = /--[a-z0-9][a-z0-9-]*/g;
    const flagsIn = (t: string) => new Set([...t.matchAll(FLAG_RE)].map(m => m[0]).filter(f => !f.endsWith('-')));
    const astFlags = (src: string): Set<string> => {
      const out = new Set<string>();
      const sf = ts.createSourceFile('f.ts', src, ts.ScriptTarget.Latest, false);
      const walk = (n: ts.Node) => {
        if (ts.isStringLiteralLike(n) || ts.isTemplateLiteralToken(n)) {
          for (const f of flagsIn(n.text)) out.add(f);
        }
        n.forEachChild(walk);
      };
      sf.forEachChild(walk);
      return out;
    };
    const files: string[] = [];
    const collect = (dir: string) => {
      for (const e of readdirSync(dir)) {
        const full = join(dir, e);
        if (statSync(full).isDirectory()) collect(full);
        else if (e.endsWith('.ts')) files.push(full);
      }
    };
    collect(join(import.meta.dir, '../src'));
    const losses: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf-8').replace(/\r\n/g, '\n');
      if (!src.includes('--')) continue;
      const kept = flagsIn(stripComments(src));
      for (const flag of astFlags(src)) {
        if (!kept.has(flag)) losses.push(`${f}: ${flag}`);
      }
    }
    expect(losses).toEqual([]);
  });

  test('committed registry: storage does not carry the phantom --multimodal (reindex still does)', () => {
    expect(CLI_FLAG_REGISTRY.storage).not.toContain('--multimodal');
    expect(CLI_FLAG_REGISTRY.reindex).toContain('--multimodal');
  });

  test('the real handleCliOnly yields one block per eval bypass sub-owner', () => {
    // Pin against src/cli.ts: every sub-owned no-DB bypass must land on eval.
    const fresh = buildFlagRegistry();
    for (const f of LONGMEMEVAL_FLAGS) expect(fresh.eval).toContain(f);
  });
});

describe('committed registry — eval row attribution (acceptance)', () => {
  test('eval row carries every documented longmemeval flag', () => {
    const missing = LONGMEMEVAL_FLAGS.filter(f => !CLI_FLAG_REGISTRY.eval.includes(f));
    expect(missing).toEqual([]);
  });

  test('the documented invocation passes the pre-dispatch validator', () => {
    expect(validateCommandFlags('eval', [
      'longmemeval', 'test/fixtures/longmemeval-mini.jsonl',
      '--retrieval-only', '--by-type', '--no-trajectory', '--keyword-only',
      '--output', '/tmp/x.jsonl',
    ])).toBeNull();
    expect(validateCommandFlags('eval', [
      'longmemeval', 'f.jsonl', '--expansion', '--resume-from', 'prev.jsonl',
      '--by-type-floor', '0.5', '--capture-pool', '--autocut', 'off', '--reranker', 'off',
      '--mode', 'tokenmax', '--top-k', '5', '--limit', '10',
    ])).toBeNull();
    expect(validateCommandFlags('eval', [
      'longmemeval', 'f.jsonl', '--no-trajectory', '--judge', '--judge-model', 'openai:gpt-4o',
      '--max-usd', '5', '--yes', '--judge-concurrency', '2', '--allow-incomplete-judgments',
    ])).toBeNull();
  });

  test('the rows that used to absorb bypass text no longer carry it (regression pins)', () => {
    // dream sat immediately before the eval bypass chain in handleCliOnly and
    // owned every longmemeval flag pre-fix.
    for (const f of ['--retrieval-only', '--keyword-only', '--no-trajectory', '--by-type-floor', '--resume-from']) {
      expect(CLI_FLAG_REGISTRY.dream).not.toContain(f);
    }
    // status sat before the `<cmd> --help` pre-engine branches and absorbed
    // sync's / extract's / eval's whole flag surface.
    expect(CLI_FLAG_REGISTRY.status).not.toContain('--pace-max-concurrency');
    expect(CLI_FLAG_REGISTRY.status).not.toContain('--retrieval-only');
    // backup sat before the `sweep --help` branch.
    expect(CLI_FLAG_REGISTRY.backup).not.toContain('--budget-ms');
    // ...and the rightful owners still hold them.
    expect(CLI_FLAG_REGISTRY.sync).toContain('--pace-max-concurrency');
    expect(CLI_FLAG_REGISTRY.sweep).toContain('--budget-ms');
  });
});

describe('committed registry — eval row rejection (union-by-design)', () => {
  test('a flag unknown to every eval subcommand is still refused', () => {
    // The eval row is a UNION across eval subcommands (longmemeval, brainbench,
    // cross-modal, chronicle, …) — the registry's existing shape for every
    // multi-subcommand CLI_ONLY command. Widening attribution must not turn
    // the row into an accept-anything list: a typo still fails loud.
    expect(validateCommandFlags('eval', ['longmemeval', 'x', '--frobnicate'])).toBe('--frobnicate');
    expect(validateCommandFlags('eval', ['longmemeval', 'x', '--retrieval-only', '--frobnicate'])).toBe('--frobnicate');
    // Case typo stays an unknown flag (handlers are case-sensitive).
    expect(validateCommandFlags('eval', ['longmemeval', 'x', '--Retrieval-Only'])).toBe('--Retrieval-Only');
  });
});

describe('block-level module scan — only ./commands/*.ts handlers are command modules', () => {
  test('isValueOnlyImport: a SCREAMING_CASE-only destructure borrows a value, not a handler', () => {
    const line = (head: string) => `${head}await import('./commands/agent-register.ts');`;
    const at = (block: string) => block.indexOf("import('");
    let b = `  if (isThinClient(cfg)) {\n    const { THIN_CLIENT_REGISTER_MESSAGE } = ${line('')}\n  }`;
    expect(isValueOnlyImport(b, at(b))).toBe(true);
    b = `    const { A_CONST, B_CONST2 } = ${line('')}`;
    expect(isValueOnlyImport(b, at(b))).toBe(true);
    // Any callable binding makes it a handler import.
    b = `    const { runAgentRegister } = ${line('')}`;
    expect(isValueOnlyImport(b, at(b))).toBe(false);
    b = `    const { SOME_CONST, runX } = ${line('')}`;
    expect(isValueOnlyImport(b, at(b))).toBe(false);
    // Namespace / bare imports scan as before.
    b = `        const reindex = ${line('')}`;
    expect(isValueOnlyImport(b, at(b))).toBe(false);
    b = `        ${line('')}`;
    expect(isValueOnlyImport(b, at(b))).toBe(false);
  });

  test('agent row: the pre-connect guard helpers do not register phantom flags; real register flags stay', () => {
    // The `command === 'agent' && args[0] === 'register'` pre-connect guard
    // imports ./core/bootstrap/uninstall.ts (uninstall's surface: --delete-brain,
    // --break-lock, …) and borrows THIN_CLIENT_REGISTER_MESSAGE from
    // agent-register.ts. Neither may promote its deps onto the agent row.
    for (const f of AGENT_PHANTOM_FLAGS) expect(CLI_FLAG_REGISTRY.agent, f).not.toContain(f);
    for (const f of AGENT_REGISTER_FLAGS) expect(CLI_FLAG_REGISTRY.agent, f).toContain(f);
    // Same on a fresh generator run (pins the generator, not just the committed file).
    const fresh = buildFlagRegistry();
    for (const f of AGENT_PHANTOM_FLAGS) expect(fresh.agent, f).not.toContain(f);
    for (const f of AGENT_REGISTER_FLAGS) expect(fresh.agent, f).toContain(f);
    // The validator agrees: a destructive uninstall flag is unknown to agent.
    expect(validateCommandFlags('agent', ['register', '--delete-brain'])).toBe('--delete-brain');
    expect(validateCommandFlags('agent', ['register', '--confirm-destructive'])).toBe('--confirm-destructive');
    expect(validateCommandFlags('agent', ['register', '--harness', 'claude-code', '--preset', 'coding'])).toBeNull();
  });

  test('comments in imported MODULE files register no flags (module-depth strip)', () => {
    // The case-block strip alone left module files raw, so any prose --flag
    // in a command module or its one-level deps minted a phantom the
    // validator then accepted (~1,500 entries, a third of the registry).
    // Original repro: bootstrap.ts's "never print a --force-baked
    // registration" comment put --force-baked on the bootstrap row. Durable
    // pins from the same class, each still a comment-only mention today:
    // pglite-repair.ts:'a typo like `--dry-rnu` would run a real WAL reset'
    // — the generator allowlisted the very typo the comment warns about —
    // and friction.ts:'--redact is the default' (code consumes --no-redact).
    expect(CLI_FLAG_REGISTRY['pglite-repair']).not.toContain('--dry-rnu');
    expect(CLI_FLAG_REGISTRY['pglite-repair']).toContain('--dry-run');
    expect(CLI_FLAG_REGISTRY.friction).not.toContain('--redact');
    expect(CLI_FLAG_REGISTRY.friction).toContain('--no-redact');
    // Same on a fresh generator run (pins the generator, not just the file).
    const fresh = buildFlagRegistry();
    expect(fresh['pglite-repair']).not.toContain('--dry-rnu');
    expect(fresh.friction).not.toContain('--redact');
    // The validator agrees: the guarded-against typo now fails loud.
    expect(validateCommandFlags('pglite-repair', ['--dry-rnu'])).toBe('--dry-rnu');
    expect(validateCommandFlags('pglite-repair', ['--dry-run'])).toBeNull();
  });

  test('comments in one-level DEP files register no flags either (dep-scan strip)', () => {
    // The dep scan is a SEPARATE stripComments call site in buildFlagRegistry
    // (module surface and its ./relative imports are stripped independently).
    // Reverting only the dep-site strip re-mints ~1,548 of the ~1,567 swept
    // phantoms while the module-depth pins above still pass — so pin
    // dep-borne phantoms in their own right. reindex's --code and embed's
    // --break-lock both rode in exclusively through comments in one-level
    // deps (mutation-verified: raw-dep regeneration restores exactly these).
    expect(CLI_FLAG_REGISTRY.reindex).not.toContain('--code');
    expect(CLI_FLAG_REGISTRY.embed).not.toContain('--break-lock');
    // Same on a fresh generator run (pins the generator, not just the file).
    const fresh = buildFlagRegistry();
    expect(fresh.reindex).not.toContain('--code');
    expect(fresh.embed).not.toContain('--break-lock');
    expect(validateCommandFlags('reindex', ['--code'])).toBe('--code');
  });

  test('EXTRA_FLAGS: the documented jobs --allow-protected opt-in survives regeneration', () => {
    // `jobs submit` is validator-exempt today, but the registry row is the
    // contract for every other jobs subcommand and for any future exemption
    // narrowing — the documented `gbrain jobs submit unify-types
    // --allow-protected` invocation must never regress to unknown-flag.
    expect(CLI_FLAG_REGISTRY.jobs).toContain('--allow-protected');
    expect(buildFlagRegistry().jobs).toContain('--allow-protected');
  });

  test('reindex-code carries no string-borne --code phantom (error prefix names reindex-code)', () => {
    // The generator keeps string literals by design (help text is
    // consumption), so the old `gbrain reindex --code:` error prefix in
    // reindex-code.ts minted a --code phantom the comment strip cannot
    // remove — the prefix now names the command that actually runs.
    expect(CLI_FLAG_REGISTRY['reindex-code']).not.toContain('--code');
    expect(buildFlagRegistry()['reindex-code']).not.toContain('--code');
    expect(validateCommandFlags('reindex-code', ['--code'])).toBe('--code');
    expect(validateCommandFlags('reindex-code', ['--max-cost-usd', '5'])).toBeNull();
  });

  test('./core/* helper imports inside a dispatch block are not scanned as command modules', () => {
    // think's `if` block reaches ./core/brain-registry.ts (--db-url, --path);
    // doctor's reaches ./core/doctor-remote.ts (whose deps carry OAuth flags);
    // the eval bypasses reach ./core/ai/gateway.ts (whose deps carry model /
    // cost flags). None of those flags is consumed by the owning command.
    expect(CLI_FLAG_REGISTRY.think).not.toContain('--db-url');
    expect(CLI_FLAG_REGISTRY.think).not.toContain('--symbol-kind');
    expect(CLI_FLAG_REGISTRY.doctor).not.toContain('--oauth-client-secret');
    expect(CLI_FLAG_REGISTRY.doctor).not.toContain('--grant-types');
    expect(CLI_FLAG_REGISTRY.eval).not.toContain('--embeddings');
    // --judge-model is now a real LME_FLAGS entry (Phase D), no longer a phantom.
    expect(CLI_FLAG_REGISTRY.eval).toContain('--judge-model');
  });
});
