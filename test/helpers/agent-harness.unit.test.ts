/**
 * Unit coverage for the real-agent door harness that needs NO real binary and
 * pays ZERO API cost. Exercises:
 *   - parseClaudeStream against a captured `claude -p --output-format
 *     stream-json` NDJSON fixture (tool_use names + final result text).
 *   - parseCodexJsonl against a captured `codex exec --json` JSONL fixture
 *     (command_execution → toolCalls, agent_message → finalText, reasoning).
 *   - hermeticChildEnv: drops CONDUCTOR_* / CLAUDE_* / GSTACK_* / MCP_* /
 *     GBRAIN_*, promotes GSTACK_ANTHROPIC_API_KEY, honors extraAllow, and lets
 *     overrides win.
 *   - resolveClaudeBinary / resolveCodexBinary SMOKE (whatever this machine
 *     has — assertion is only that the result is a string-or-null, plus a note
 *     printed when found).
 *
 * The env test mutates process.env and restores it in finally so it never
 * leaks into sibling tests.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseClaudeStream,
  parseCodexJsonl,
  hermeticChildEnv,
  hermesChildEnv,
  promotedEnv,
  resolveClaudeBinary,
  resolveCodexBinary,
  resolveHermesBinary,
  hasHermesAuth,
  parseDotenvFile,
  seedHermesHome,
} from './agent-harness.ts';
import { withEnv } from './with-env.ts';

// A captured claude stream-json turn: a system init line, an assistant text +
// tool_use turn, a tool_result user line, a second assistant text turn, and the
// terminal result line. Trailing blank + one malformed line prove the parser
// tolerates both.
const CLAUDE_NDJSON = [
  '{"type":"system","subtype":"init","session_id":"abc","tools":["mcp__gbrain__recall"]}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"Let me search the brain."},{"type":"tool_use","id":"tu_1","name":"mcp__gbrain__recall","input":{"query":"fulfillment center"}}]}}',
  '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_1","content":"Summit Robotics runs the Rivermouth fulfillment center."}]}}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"Summit Robotics runs the Rivermouth fulfillment center."}]}}',
  '',
  'this is not json and must be skipped',
  '{"type":"result","subtype":"success","is_error":false,"result":"Summit Robotics runs the Rivermouth fulfillment center.","num_turns":2,"total_cost_usd":0.01}',
];

// A captured codex exec --json turn: thread.started, a reasoning item, a
// command_execution item, an agent_message item, turn.completed, plus a blank
// and a malformed line.
const CODEX_JSONL = [
  '{"type":"thread.started","thread_id":"th_123"}',
  '{"type":"item.completed","item":{"type":"reasoning","text":"I should read the file to answer."}}',
  '{"type":"item.completed","item":{"type":"command_execution","command":"cat facts.md","exit_code":0}}',
  '{"type":"item.completed","item":{"type":"agent_message","text":"The fulfillment center is Rivermouth."}}',
  '',
  '{oops not json',
  '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":20}}',
];

describe('parseClaudeStream', () => {
  test('extracts tool_use names and the final result text', () => {
    const parsed = parseClaudeStream(CLAUDE_NDJSON);
    expect(parsed.toolCalls).toEqual(['mcp__gbrain__recall']);
    expect(parsed.finalText).toBe('Summit Robotics runs the Rivermouth fulfillment center.');
  });

  test('falls back to last assistant text when no result line', () => {
    const noResult = CLAUDE_NDJSON.filter((l) => !l.includes('"type":"result"'));
    const parsed = parseClaudeStream(noResult);
    expect(parsed.finalText).toBe('Summit Robotics runs the Rivermouth fulfillment center.');
    expect(parsed.toolCalls).toEqual(['mcp__gbrain__recall']);
  });

  test('empty input yields empty result, never throws', () => {
    expect(parseClaudeStream([])).toEqual({ finalText: '', toolCalls: [] });
  });
});

describe('parseCodexJsonl', () => {
  test('extracts command executions, agent message, and reasoning', () => {
    const parsed = parseCodexJsonl(CODEX_JSONL);
    expect(parsed.toolCalls).toEqual(['cat facts.md']);
    expect(parsed.finalText).toBe('The fulfillment center is Rivermouth.');
    expect(parsed.reasoning).toEqual(['I should read the file to answer.']);
  });

  test('empty input yields empty result, never throws', () => {
    expect(parseCodexJsonl([])).toEqual({ finalText: '', toolCalls: [], reasoning: [] });
  });
});

describe('promotedEnv', () => {
  test('promotes GSTACK_ANTHROPIC_API_KEY when canonical is unset', () => {
    const out = promotedEnv({ GSTACK_ANTHROPIC_API_KEY: 'sk-gstack' } as NodeJS.ProcessEnv);
    expect(out.ANTHROPIC_API_KEY).toBe('sk-gstack');
  });

  test('does NOT clobber an existing canonical key', () => {
    const out = promotedEnv({
      ANTHROPIC_API_KEY: 'sk-real',
      GSTACK_ANTHROPIC_API_KEY: 'sk-gstack',
    } as NodeJS.ProcessEnv);
    expect(out.ANTHROPIC_API_KEY).toBe('sk-real');
  });
});

describe('hermeticChildEnv', () => {
  test('drops CONDUCTOR_*/CLAUDE_*/GSTACK_*/MCP_*/GBRAIN_*, keeps PATH/HOME, promotes GSTACK key', async () => {
    // Contaminate the process env with everything a real Conductor + Claude
    // Code session would carry (ANTHROPIC_API_KEY unset so promotion shows).
    await withEnv(
      {
        CONDUCTOR_WORKSPACE_PATH: '/should/drop',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        CLAUDECODE: '1',
        MCP_SERVER: 'gbrain',
        GBRAIN_HOME: '/operator/.gbrain',
        GSTACK_HOME: '/operator/.gstack',
        ANTHROPIC_API_KEY: undefined,
        GSTACK_ANTHROPIC_API_KEY: 'sk-promote-me',
      },
      () => {
        const env = hermeticChildEnv({ HOME: '/tmp/hermetic-home', GBRAIN_HOME: '/tmp/hermetic-gbrain' });

        // Dropped.
        expect(env.CONDUCTOR_WORKSPACE_PATH).toBeUndefined();
        expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
        expect(env.CLAUDECODE).toBeUndefined();
        expect(env.MCP_SERVER).toBeUndefined();
        expect(env.GSTACK_HOME).toBeUndefined();
        // GSTACK_ANTHROPIC_API_KEY itself is dropped (prefix), but its value was
        // promoted onto the allowlisted canonical name.
        expect(env.GSTACK_ANTHROPIC_API_KEY).toBeUndefined();
        expect(env.ANTHROPIC_API_KEY).toBe('sk-promote-me');

        // Kept.
        expect(env.PATH).toBe(process.env.PATH);
        // Overrides win — HOME is the temp one, and a GBRAIN_HOME override is
        // honored even though the bare GBRAIN_ prefix is dropped.
        expect(env.HOME).toBe('/tmp/hermetic-home');
        expect(env.GBRAIN_HOME).toBe('/tmp/hermetic-gbrain');
      },
    );
  });

  test('extraAllow admits exact names and PREFIX_* forms (codex auth surface)', async () => {
    await withEnv(
      {
        OPENAI_API_KEY: 'sk-openai',
        CODEX_HOME: '/operator/.codex',
        CODEX_SANDBOX: 'workspace-write',
      },
      () => {
        const env = hermeticChildEnv({}, { extraAllow: ['OPENAI_API_KEY', 'CODEX_*'] });
        expect(env.OPENAI_API_KEY).toBe('sk-openai');
        expect(env.CODEX_HOME).toBe('/operator/.codex');
        expect(env.CODEX_SANDBOX).toBe('workspace-write');

        // Without extraAllow, the same vars are dropped.
        const scrubbed = hermeticChildEnv({});
        expect(scrubbed.OPENAI_API_KEY).toBeUndefined();
        expect(scrubbed.CODEX_HOME).toBeUndefined();
      },
    );
  });
});

describe('binary resolution SMOKE', () => {
  test('resolveClaudeBinary returns a string or null', () => {
    const bin = resolveClaudeBinary();
    expect(bin === null || typeof bin === 'string').toBe(true);
    if (bin) console.log(`[smoke] claude resolved at: ${bin}`);
  });

  test('resolveCodexBinary returns a string or null', () => {
    const bin = resolveCodexBinary();
    expect(bin === null || typeof bin === 'string').toBe(true);
    if (bin) console.log(`[smoke] codex resolved at: ${bin}`);
  });

  test('resolveHermesBinary returns a string or null', () => {
    const bin = resolveHermesBinary();
    expect(bin === null || typeof bin === 'string').toBe(true);
    if (bin) console.log(`[smoke] hermes resolved at: ${bin}`);
  });

  test('hasHermesAuth returns a boolean', () => {
    expect(typeof hasHermesAuth()).toBe('boolean');
  });
});

describe('hasHermesAuth truth table (env leg — pins the anthropic-only, non-empty-value gate)', () => {
  // The .env-file leg reads the operator's real ~/.hermes/.env, so only the
  // env-var leg is exercised hermetically here; the file PARSING contract is
  // pinned by the parseDotenvFile + seedHermesHome describes below.
  const CLEAR = {
    ANTHROPIC_API_KEY: undefined,
    GSTACK_ANTHROPIC_API_KEY: undefined,
    OPENAI_API_KEY: undefined,
    GSTACK_OPENAI_API_KEY: undefined,
    OPENROUTER_API_KEY: undefined,
  } as const;

  /** True only when the operator's real ~/.hermes/.env carries an anthropic key. */
  const fileLegHasAnthropicKey = () =>
    Boolean(parseDotenvFile(join(process.env.HOME ?? '', '.hermes', '.env')).ANTHROPIC_API_KEY?.trim());

  test('non-empty anthropic env key → true', async () => {
    await withEnv({ ...CLEAR, ANTHROPIC_API_KEY: 'sk-test-nonempty' }, () => {
      expect(hasHermesAuth()).toBe(true);
    });
  });

  test('GSTACK_-prefixed anthropic key promotes → true', async () => {
    await withEnv({ ...CLEAR, GSTACK_ANTHROPIC_API_KEY: 'sk-test-promoted' }, () => {
      expect(hasHermesAuth()).toBe(true);
    });
  });

  test('BLANK env value → does NOT count as auth (a blank CI secret must skip, not fail paid)', async () => {
    await withEnv({ ...CLEAR, ANTHROPIC_API_KEY: '   ' }, () => {
      expect(hasHermesAuth()).toBe(fileLegHasAnthropicKey());
    });
  });

  test('a NON-anthropic provider key alone → false (door is anthropic-pinned; a second provider mis-routes provider-auto)', async () => {
    await withEnv({ ...CLEAR, OPENAI_API_KEY: 'sk-openai-only' }, () => {
      expect(hasHermesAuth()).toBe(fileLegHasAnthropicKey());
    });
  });
});

describe('hermesChildEnv — the single-auth-source enforcement point', () => {
  test('scrubs EVERY provider key (incl. allowlisted anthropic vars) and pins HOME/HERMES_HOME', async () => {
    // A regression here (dropping the delete loop) re-leaks the operator's
    // real key into every hermes child and reintroduces the provider-auto
    // 401 mis-route — detectable only in the triple-gated paid lane, so the
    // contract is pinned hermetically here.
    await withEnv({
      ANTHROPIC_API_KEY: 'sk-operator',
      ANTHROPIC_BASE_URL: 'https://operator.example',
      ANTHROPIC_AUTH_TOKEN: 'tok-operator',
      OPENAI_API_KEY: 'sk-openai',
      OPENROUTER_API_KEY: 'sk-openrouter',
      GSTACK_ANTHROPIC_API_KEY: undefined,
      GSTACK_OPENAI_API_KEY: undefined,
      HERMES_HOME: '/operator/.hermes',
    }, () => {
      const env = hermesChildEnv('/tmp/hermes-child-test');
      for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY']) {
        expect(env[k]).toBeUndefined();
      }
      expect(env.HOME).toBe('/tmp/hermes-child-test');
      expect(env.HERMES_HOME).toBe('/tmp/hermes-child-test/.hermes');
    });
  });
});

describe('parseDotenvFile', () => {
  test('parses KEY=VALUE, skips comments/blanks, strips quotes and export prefixes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-dotenv-'));
    try {
      const f = join(dir, '.env');
      writeFileSync(f, [
        '# comment',
        '',
        'ANTHROPIC_API_KEY=sk-plain',
        'export OPENAI_API_KEY="sk-quoted"',
        "OPENROUTER_API_KEY='sk-single'",
        'BLANK_KEY=',
        'not a kv line',
      ].join('\n'), 'utf-8');
      const parsed = parseDotenvFile(f);
      expect(parsed.ANTHROPIC_API_KEY).toBe('sk-plain');
      expect(parsed.OPENAI_API_KEY).toBe('sk-quoted');
      expect(parsed.OPENROUTER_API_KEY).toBe('sk-single');
      expect(parsed.BLANK_KEY).toBe('');
      expect(Object.keys(parsed)).not.toContain('not a kv line');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('unreadable file → empty object, never throws', () => {
    expect(parseDotenvFile('/nonexistent/path/.env')).toEqual({});
  });
});

describe('seedHermesHome single-key copy (injectable source — never the operator home)', () => {
  test('copies EXACTLY the anthropic key; other providers and behavior knobs stay behind', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-seedhh-'));
    try {
      const src = join(dir, 'source.env');
      writeFileSync(src, [
        'ANTHROPIC_API_KEY=sk-copy-me',
        'OPENAI_API_KEY=sk-openai-stays-home',  // second provider → dropped (mis-routes provider-auto)
        'OPENROUTER_API_KEY=sk-or-stays-home',  // second provider → dropped
        'TELEGRAM_BOT_TOKEN=secret-stays-home', // unlisted → dropped
        'HERMES_BASE_URL=https://internal',     // unlisted → dropped
      ].join('\n'), 'utf-8');

      const home = join(dir, 'home');
      const hermesHome = await withEnv({
        ANTHROPIC_API_KEY: undefined, GSTACK_ANTHROPIC_API_KEY: undefined,
        OPENAI_API_KEY: undefined, GSTACK_OPENAI_API_KEY: undefined, OPENROUTER_API_KEY: undefined,
      }, () => seedHermesHome(home, { sourceEnvPath: src }));

      expect(hermesHome).toBe(join(home, '.hermes'));
      const written = readFileSync(join(hermesHome, '.env'), 'utf-8');
      expect(written).toBe('ANTHROPIC_API_KEY=sk-copy-me\n');
      // seedHermesHome never writes config.yaml (hermes owns that schema —
      // the model pin goes through the hermes CLI instead).
      expect(existsSync(join(hermesHome, 'config.yaml'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('no source file + no env keys → no .env written (gate stays closed)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-seedhh2-'));
    try {
      const home = join(dir, 'home');
      await withEnv({
        ANTHROPIC_API_KEY: undefined, GSTACK_ANTHROPIC_API_KEY: undefined,
        OPENAI_API_KEY: undefined, GSTACK_OPENAI_API_KEY: undefined, OPENROUTER_API_KEY: undefined,
      }, () => seedHermesHome(home, { sourceEnvPath: join(dir, 'missing.env') }));
      expect(existsSync(join(home, '.hermes', '.env'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
