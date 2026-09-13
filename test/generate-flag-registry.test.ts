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
