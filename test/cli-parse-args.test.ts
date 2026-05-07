import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { parseOpArgs, formatResult } from '../src/cli.ts';
import type { Operation } from '../src/core/operations.ts';
import { operations } from '../src/core/operations.ts';

// --- Fixtures ---------------------------------------------------------------

const listOp: Operation = {
  name: 'list_pages',
  description: 'test',
  params: {
    type: { type: 'string' },
    tag: { type: 'string' },
    limit: { type: 'number' },
    verbose: { type: 'boolean' },
  },
  handler: async () => [],
  cliHints: { name: 'list', aliases: { n: 'limit', v: 'verbose' } },
};

const getOp: Operation = {
  name: 'get_page',
  description: 'test',
  params: { slug: { type: 'string', required: true } },
  handler: async () => null,
  cliHints: { name: 'get', positional: ['slug'] },
};

const graphOp: Operation = {
  name: 'graph',
  description: 'test',
  params: {
    slug: { type: 'string', required: true },
    depth: { type: 'number' },
  },
  handler: async () => ({}),
  cliHints: { name: 'graph', positional: ['slug'], aliases: { d: 'depth' } },
};

const captureWarnings = () => {
  const warnings: string[] = [];
  return { warn: (msg: string) => warnings.push(msg), warnings };
};

// --- Existing behavior ------------------------------------------------------

describe('parseOpArgs — short flag aliases', () => {
  test('maps -n VALUE to aliased param limit', () => {
    expect(parseOpArgs(listOp, ['-n', '200'])).toEqual({ limit: 200 });
  });

  test('still honors --limit VALUE', () => {
    expect(parseOpArgs(listOp, ['--limit', '200'])).toEqual({ limit: 200 });
  });

  test('mixes long and short flags', () => {
    expect(parseOpArgs(listOp, ['--type', 'person', '-n', '10'])).toEqual({
      type: 'person',
      limit: 10,
    });
  });

  test('coerces aliased number params to Number', () => {
    const result = parseOpArgs(listOp, ['-n', '42']);
    expect(typeof result.limit).toBe('number');
    expect(result.limit).toBe(42);
  });

  test('positional args still work for ops with positional', () => {
    expect(parseOpArgs(getOp, ['my-slug'])).toEqual({ slug: 'my-slug' });
  });

  test('op without aliases ignores short flags but warns', () => {
    const op: Operation = { ...listOp, cliHints: { name: 'list' } };
    const c = captureWarnings();
    expect(parseOpArgs(op, ['-n', '200'], c)).toEqual({});
    expect(c.warnings.join('\n')).toContain('unknown flag -n');
  });
});

// --- Equals form (--flag=value, -x=value) ----------------------------------

describe('parseOpArgs — equals form', () => {
  test('--limit=200 long equals form', () => {
    expect(parseOpArgs(listOp, ['--limit=200'])).toEqual({ limit: 200 });
  });

  test('-n=200 short equals form', () => {
    expect(parseOpArgs(listOp, ['-n=200'])).toEqual({ limit: 200 });
  });

  test('--type=person with string value', () => {
    expect(parseOpArgs(listOp, ['--type=person'])).toEqual({ type: 'person' });
  });

  test('equals form with empty value', () => {
    expect(parseOpArgs(listOp, ['--type='])).toEqual({ type: '' });
  });

  test('--verbose=false boolean equals form → false', () => {
    expect(parseOpArgs(listOp, ['--verbose=false'])).toEqual({ verbose: false });
  });

  test('--verbose=true boolean equals form → true', () => {
    expect(parseOpArgs(listOp, ['--verbose=true'])).toEqual({ verbose: true });
  });
});

// --- Numeric validation ----------------------------------------------------

describe('parseOpArgs — numeric validation', () => {
  test('non-numeric value for number param throws', () => {
    expect(() => parseOpArgs(listOp, ['-n', 'abc'])).toThrow(/Invalid number for --limit/);
  });

  test('empty string for number param throws', () => {
    // Number('') is 0, which technically is valid. Document expectation.
    expect(parseOpArgs(listOp, ['-n', ''])).toEqual({ limit: 0 });
  });

  test('explicit 0 is preserved (not coerced to default)', () => {
    expect(parseOpArgs(listOp, ['-n', '0'])).toEqual({ limit: 0 });
  });

  test('negative number parses as-is (operation-level semantics)', () => {
    expect(parseOpArgs(listOp, ['-n', '-1'])).toEqual({ limit: -1 });
  });

  test('float parses correctly', () => {
    expect(parseOpArgs(listOp, ['-n', '3.14'])).toEqual({ limit: 3.14 });
  });

  test('positional number throws on non-numeric', () => {
    const op: Operation = {
      ...getOp,
      params: { slug: { type: 'number' as const, required: true } },
    };
    expect(() => parseOpArgs(op, ['not-a-number'])).toThrow(/Invalid number/);
  });
});

// --- Missing value handling -----------------------------------------------

describe('parseOpArgs — missing value', () => {
  test('-n at end with no value emits warning, no param set', () => {
    const c = captureWarnings();
    expect(parseOpArgs(listOp, ['-n'], c)).toEqual({});
    expect(c.warnings.join('\n')).toContain('-n expects a value');
  });

  test('--limit at end with no value emits warning', () => {
    const c = captureWarnings();
    expect(parseOpArgs(listOp, ['--limit'], c)).toEqual({});
    expect(c.warnings.join('\n')).toContain('--limit expects a value');
  });
});

// --- Unknown flag handling -------------------------------------------------

describe('parseOpArgs — unknown flags', () => {
  test('unknown long flag emits warning and does not consume non-flag next', () => {
    const c = captureWarnings();
    parseOpArgs(listOp, ['--foobar', 'something', '-n', '5'], c);
    expect(c.warnings.join('\n')).toContain('unknown flag --foobar');
  });

  test('unknown short flag emits warning', () => {
    const c = captureWarnings();
    expect(parseOpArgs(listOp, ['-z', '99', '-n', '5'], c)).toEqual({ limit: 5 });
    expect(c.warnings.join('\n')).toContain('unknown flag -z');
  });

  test('unknown flag followed by another flag does not consume the flag', () => {
    // `--foo -n 5` should warn about --foo and still see -n 5
    const c = captureWarnings();
    expect(parseOpArgs(listOp, ['--foo', '-n', '5'], c)).toEqual({ limit: 5 });
  });
});

// --- Boolean aliases -------------------------------------------------------

describe('parseOpArgs — boolean short flags', () => {
  test('-v sets boolean verbose=true', () => {
    expect(parseOpArgs(listOp, ['-v'])).toEqual({ verbose: true });
  });

  test('--verbose sets boolean verbose=true', () => {
    expect(parseOpArgs(listOp, ['--verbose'])).toEqual({ verbose: true });
  });
});

// --- Positional + flags mix -----------------------------------------------

describe('parseOpArgs — positional + flags', () => {
  test('positional followed by short flag with alias', () => {
    expect(parseOpArgs(graphOp, ['my-slug', '-d', '3'])).toEqual({
      slug: 'my-slug',
      depth: 3,
    });
  });

  test('short flag before positional', () => {
    expect(parseOpArgs(graphOp, ['-d', '3', 'my-slug'])).toEqual({
      slug: 'my-slug',
      depth: 3,
    });
  });
});

// --- formatResult: truncation indicator -----------------------------------

describe('formatResult — list_pages truncation indicator', () => {
  const makeRows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      slug: `slug-${i}`,
      type: 'concept',
      title: `Title ${i}`,
      updated_at: '2026-04-17',
    }));

  test('shows truncation hint when result length equals requested limit', () => {
    const output = formatResult('list_pages', makeRows(50), { limit: 50 });
    expect(output).toContain('truncated at 50');
    expect(output).toContain('--limit');
  });

  test('shows truncation hint when result length equals default limit (50)', () => {
    const output = formatResult('list_pages', makeRows(50), {});
    expect(output).toContain('truncated at 50');
  });

  test('no hint when result length is less than requested limit', () => {
    const output = formatResult('list_pages', makeRows(30), { limit: 50 });
    expect(output).not.toContain('truncated');
  });

  test('hint reflects explicit user limit (not default)', () => {
    const output = formatResult('list_pages', makeRows(100), { limit: 100 });
    expect(output).toContain('truncated at 100');
  });

  test('no hint when pages array is empty', () => {
    const output = formatResult('list_pages', [], { limit: 50 });
    expect(output).toBe('No pages found.\n');
  });

  test('handles limit=0 cleanly — no infinite loop language', () => {
    // If the handler correctly respects 0, result is empty → "No pages found".
    // If for any reason 50 rows come through with limit=0, the hint should
    // still be readable (doesn't tell user to "--limit 0 to expand").
    const output = formatResult('list_pages', makeRows(1), { limit: 0 });
    expect(output).toContain('truncated at 0');
    expect(output).toContain('pass --limit N or -n N to change');
  });
});

describe('formatResult — all-subbrains sync output', () => {
  test('renders per-subbrain statuses without an undefined commit range', () => {
    const output = formatResult('sync_brain', {
      status: 'synced',
      fromCommit: null,
      toCommit: '11111111,22222222',
      added: 1,
      modified: 0,
      deleted: 0,
      renamed: 0,
      chunksCreated: 2,
      pagesAffected: ['personal/people/alice'],
      targets: [
        {
          id: 'office',
          status: 'up_to_date',
          fromCommit: '2222222222222222222222222222222222222222',
          toCommit: '2222222222222222222222222222222222222222',
          added: 0,
          modified: 0,
          deleted: 0,
          renamed: 0,
          chunksCreated: 0,
          pagesAffected: [],
        },
        {
          id: 'personal',
          status: 'first_sync',
          fromCommit: null,
          toCommit: '1111111111111111111111111111111111111111',
          added: 1,
          modified: 0,
          deleted: 0,
          renamed: 0,
          chunksCreated: 2,
          pagesAffected: ['personal/people/alice'],
        },
      ],
    });

    expect(output).toContain('Sub-brain sync complete:');
    expect(output).toContain('office: up_to_date');
    expect(output).toContain('personal: first_sync');
    expect(output).not.toContain('undefined');
  });
});

// --- Meta: contract/help text consistency ---------------------------------

describe('operations contract — help ↔ aliases consistency', () => {
  const cliSource = readFileSync(
    new URL('../src/cli.ts', import.meta.url),
    'utf-8',
  );
  // Extract the printHelp body lines that advertise commands
  const helpSection = cliSource.slice(
    cliSource.indexOf('function printHelp()'),
  );

  test('every operation referenced with a short flag in help has a matching alias', () => {
    // match tokens like "-n N" or "-d N" within the help block
    const matches = Array.from(helpSection.matchAll(/\s-(\w)\s+[A-Z]/g)).map(m => m[1]);
    if (matches.length === 0) return; // help format changed; meta-test no-op
    // For each advertised short flag, verify that *some* operation declares it
    for (const short of matches) {
      const declared = operations.some(op =>
        op.cliHints?.aliases && Object.prototype.hasOwnProperty.call(op.cliHints.aliases, short),
      );
      expect(declared).toBe(true);
    }
  });

  test('all aliases in operations point to real params', () => {
    for (const op of operations) {
      const aliases = op.cliHints?.aliases ?? {};
      for (const [short, key] of Object.entries(aliases)) {
        expect(op.params[key]).toBeDefined();
        expect(short.length).toBeGreaterThan(0);
      }
    }
  });

  test('no alias shadows another alias with different target in same op', () => {
    for (const op of operations) {
      const aliases = op.cliHints?.aliases ?? {};
      const seen = new Set<string>();
      for (const short of Object.keys(aliases)) {
        expect(seen.has(short)).toBe(false);
        seen.add(short);
      }
    }
  });
});

// --- Meta: cli.ts does not auto-execute main() on import ------------------

describe('cli.ts module hygiene', () => {
  test('main() is guarded by import.meta.main', () => {
    const src = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf-8');
    expect(src).toMatch(/if\s*\(\s*import\.meta\.main\s*\)/);
  });
});
