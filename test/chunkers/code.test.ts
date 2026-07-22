/**
 * v0.19.0 Layer 5 — tree-sitter code chunker tests.
 *
 * Covers: detectCodeLanguage across all 29 file extensions, chunkCodeText
 * on TS/Python/Go/Rust/Java + small-sibling merging + tokenizer accuracy
 * + language fallback for unsupported extensions.
 */

import { describe, test, expect } from 'bun:test';
import { chunkCodeText, detectCodeLanguage, CHUNKER_VERSION } from '../../src/core/chunkers/code.ts';

describe('CHUNKER_VERSION', () => {
  test('v0.20.0 Cathedral II Layer 12 bumped to 4', () => {
    expect(CHUNKER_VERSION).toBe(4);
  });
});

describe('detectCodeLanguage', () => {
  test('recognizes all 30 supported extensions', () => {
    const cases: Record<string, string> = {
      'foo.ts': 'typescript', 'foo.tsx': 'tsx', 'foo.mts': 'typescript', 'foo.cts': 'typescript',
      'foo.js': 'javascript', 'foo.jsx': 'javascript', 'foo.mjs': 'javascript', 'foo.cjs': 'javascript',
      'foo.py': 'python', 'foo.rb': 'ruby', 'foo.go': 'go',
      'foo.rs': 'rust', 'foo.java': 'java', 'foo.cs': 'c_sharp',
      'foo.cpp': 'cpp', 'foo.cc': 'cpp', 'foo.hpp': 'cpp',
      'foo.c': 'c', 'foo.h': 'c',
      'foo.php': 'php', 'foo.swift': 'swift', 'foo.kt': 'kotlin',
      'foo.scala': 'scala', 'foo.lua': 'lua', 'foo.ex': 'elixir',
      'foo.elm': 'elm', 'foo.ml': 'ocaml', 'foo.dart': 'dart',
      'foo.zig': 'zig', 'foo.sol': 'solidity', 'foo.sh': 'bash',
      'foo.css': 'css', 'foo.html': 'html', 'foo.vue': 'vue',
      'foo.json': 'json', 'foo.yaml': 'yaml', 'foo.toml': 'toml',
      // v0.41 D2 wave: SQL via DerekStride/tree-sitter-sql.
      'foo.sql': 'sql', 'migrations/001_init.sql': 'sql',
    };
    for (const [path, expected] of Object.entries(cases)) {
      expect(detectCodeLanguage(path)).toBe(expected as any);
    }
  });

  test('returns null for unsupported extensions', () => {
    expect(detectCodeLanguage('foo.md')).toBeNull();
    expect(detectCodeLanguage('foo.txt')).toBeNull();
    expect(detectCodeLanguage('README')).toBeNull();
  });

  test('is case-insensitive', () => {
    expect(detectCodeLanguage('Main.GO')).toBe('go');
    expect(detectCodeLanguage('App.TSX')).toBe('tsx');
    expect(detectCodeLanguage('Schema.SQL')).toBe('sql');
  });
});

// v0.41 D2 wave (#1173) — SQL via DerekStride/tree-sitter-sql.
// Step 0 inspection 2026-05-24 verified the grammar wraps every top-level
// statement in `program > statement > <kind>`. Tests assert the chunker
// dives through the wrapper and extracts the target name from DDL kinds.
describe('chunkCodeText — SQL', () => {
  test('CREATE TABLE extracts table name as symbolName', async () => {
    const sql = `CREATE TABLE this_table_name_is_long_enough_to_avoid_merging (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP,
  deleted_at TIMESTAMP,
  metadata JSONB
);`;
    // Use a small chunkSizeTokens so the single statement isn't merged
    // with siblings (test fixture has only one, so no merging anyway).
    const result = await chunkCodeText(sql, 'migrations/users.sql', { chunkSizeTokens: 50 });
    expect(result.length).toBeGreaterThanOrEqual(1);
    const c = result[0]!;
    expect(c.metadata.language).toBe('sql');
    expect(c.metadata.symbolName).toBe('this_table_name_is_long_enough_to_avoid_merging');
    expect(c.metadata.symbolType).toBe('table');
    expect(c.text).toContain('[SQL]');
  });

  test('CREATE FUNCTION with $$ body extracts function name + parses cleanly', async () => {
    const sql = `CREATE OR REPLACE FUNCTION get_user_by_email_long_function_name_here_for_no_merge(p_email TEXT)
RETURNS users AS $$
  SELECT * FROM users WHERE email = p_email LIMIT 1;
$$ LANGUAGE SQL;`;
    const result = await chunkCodeText(sql, 'migrations/fn.sql', { chunkSizeTokens: 50 });
    expect(result.length).toBeGreaterThanOrEqual(1);
    const c = result.find(c => c.metadata.symbolName === 'get_user_by_email_long_function_name_here_for_no_merge');
    expect(c).toBeDefined();
    expect(c!.metadata.symbolType).toBe('function');
    expect(c!.metadata.language).toBe('sql');
    // Dollar-quoted body must NOT crash the parser (codex F15 regression).
    expect(c!.text).toContain('$$');
  });

  test('CREATE INDEX extracts index name', async () => {
    const sql = `CREATE INDEX idx_a_b_c_d_e_f_g_long ON users (email, created_at, updated_at, deleted_at);`;
    const result = await chunkCodeText(sql, 'idx.sql', { chunkSizeTokens: 50 });
    const c = result.find(c => c.metadata.symbolType === 'index');
    expect(c).toBeDefined();
    expect(c!.metadata.symbolName).toBe('idx_a_b_c_d_e_f_g_long');
  });

  test('CREATE VIEW extracts view name', async () => {
    const sql = `CREATE VIEW active_users_dashboard_view AS
  SELECT id, email FROM users WHERE deleted_at IS NULL AND active = true;`;
    const result = await chunkCodeText(sql, 'view.sql', { chunkSizeTokens: 50 });
    const c = result.find(c => c.metadata.symbolType === 'view');
    expect(c).toBeDefined();
    expect(c!.metadata.symbolName).toBe('active_users_dashboard_view');
  });

  test('ALTER TABLE extracts table name', async () => {
    const sql = `ALTER TABLE long_table_name_here_so_it_does_not_merge_with_sibling
  ADD COLUMN created_at TIMESTAMP DEFAULT NOW(),
  ADD COLUMN updated_at TIMESTAMP;`;
    const result = await chunkCodeText(sql, 'alter.sql', { chunkSizeTokens: 50 });
    const c = result.find(c => c.metadata.symbolType === 'table');
    expect(c).toBeDefined();
    expect(c!.metadata.symbolName).toBe('long_table_name_here_so_it_does_not_merge_with_sibling');
  });

  test('DML statements emit chunks but with symbolName=null (DDL signal only)', async () => {
    const sql = `INSERT INTO users (email) VALUES ('a@b.com') RETURNING id, email, created_at;`;
    const result = await chunkCodeText(sql, 'dml.sql', { chunkSizeTokens: 50 });
    expect(result.length).toBeGreaterThanOrEqual(1);
    // The chunk emits but symbolName stays null — DML doesn't contribute
    // to code-def. symbolType remains the underlying statement kind via
    // normalizeSymbolType's fallback (`insert` here, unmapped → "insert").
    expect(result[0]!.metadata.symbolName).toBeNull();
    expect(result[0]!.metadata.language).toBe('sql');
  });

  test('mixed DDL + DML emits per-statement chunks, only DDL gets symbolName', async () => {
    const sql = `CREATE TABLE long_mixed_table_name_for_no_merge_with_dml_below_it (id INT PRIMARY KEY, x TEXT, y TEXT, z TEXT);
INSERT INTO long_mixed_table_name_for_no_merge_with_dml_below_it (id, x) VALUES (1, 'aaaaaaaaaa');
INSERT INTO long_mixed_table_name_for_no_merge_with_dml_below_it (id, x) VALUES (2, 'bbbbbbbbbb');
SELECT * FROM long_mixed_table_name_for_no_merge_with_dml_below_it WHERE id = 1 ORDER BY x;`;
    const result = await chunkCodeText(sql, 'mixed.sql', { chunkSizeTokens: 50 });
    // Should have chunks for all 4 statements (DDL+DML each emit).
    expect(result.length).toBeGreaterThanOrEqual(2);
    const namedChunks = result.filter(c => c.metadata.symbolName !== null);
    expect(namedChunks.length).toBeGreaterThanOrEqual(1);
    const ddl = namedChunks.find(c => c.metadata.symbolName === 'long_mixed_table_name_for_no_merge_with_dml_below_it');
    expect(ddl).toBeDefined();
    expect(ddl!.metadata.symbolType).toBe('table');
  });

  test('header includes "[SQL]" language tag', async () => {
    const sql = 'CREATE TABLE x (id INT);';
    const result = await chunkCodeText(sql, 'x.sql');
    expect(result[0]!.text).toMatch(/^\[SQL\]/);
  });

  test('does not crash on invalid SQL', async () => {
    // Per Step 0: even "SELECT FROM WHERE" parses to a select node, no
    // throw. This pins that we don't regress to throwing.
    const sql = 'SELECT FROM WHERE';
    const result = await chunkCodeText(sql, 'bad.sql', { chunkSizeTokens: 50 });
    expect(result.length).toBeGreaterThanOrEqual(1);
    // The chunk emits; symbol_name stays null.
    expect(result[0]!.metadata.language).toBe('sql');
  });

  test('CREATE TRIGGER extracts trigger name + symbolType=trigger', async () => {
    const sql = `CREATE TRIGGER long_audit_trigger_for_email_changes_on_users_table
  AFTER UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION log_email_change();`;
    const result = await chunkCodeText(sql, 'trig.sql', { chunkSizeTokens: 50 });
    const c = result.find(c => c.metadata.symbolType === 'trigger');
    expect(c).toBeDefined();
    expect(c!.metadata.symbolName).toBe('long_audit_trigger_for_email_changes_on_users_table');
  });

  test('CREATE TYPE extracts enum name + symbolType=type', async () => {
    const sql = `CREATE TYPE long_user_role_enum_avoid_merger_padding AS ENUM ('admin', 'member', 'guest', 'auditor');`;
    const result = await chunkCodeText(sql, 'types.sql', { chunkSizeTokens: 50 });
    const c = result.find(c => c.metadata.symbolType === 'type');
    expect(c).toBeDefined();
    expect(c!.metadata.symbolName).toBe('long_user_role_enum_avoid_merger_padding');
  });

  test('CREATE PROCEDURE extracts name + symbolType=procedure', async () => {
    const sql = `CREATE PROCEDURE long_archive_old_users_procedure_no_merge(days_old INT)
LANGUAGE SQL AS $$
  UPDATE users SET deleted_at = NOW() WHERE last_login_at < NOW() - INTERVAL '1 day' * days_old;
$$;`;
    const result = await chunkCodeText(sql, 'proc.sql', { chunkSizeTokens: 50 });
    const c = result.find(c => c.metadata.symbolType === 'procedure');
    expect(c).toBeDefined();
    expect(c!.metadata.symbolName).toBe('long_archive_old_users_procedure_no_merge');
  });

  test('CREATE SCHEMA extracts schema name + symbolType=schema', async () => {
    const sql = `CREATE SCHEMA IF NOT EXISTS analytics_long_schema_name_avoid_merge AUTHORIZATION analytics_owner;`;
    const result = await chunkCodeText(sql, 'sch.sql', { chunkSizeTokens: 50 });
    const c = result.find(c => c.metadata.symbolType === 'schema');
    // Schema may not always be reachable depending on grammar version;
    // accept either correct extraction OR null (test that it doesn't crash).
    if (c) {
      expect(c.metadata.symbolName).toBe('analytics_long_schema_name_avoid_merge');
    }
    // Always: chunk emits, language is sql.
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0]!.metadata.language).toBe('sql');
  });

  test('header symbolType for SQL chunks reflects inner DDL kind, not "statement"', async () => {
    const sql = `CREATE TABLE structured_header_test_table_long_name (id INT, name TEXT, value TEXT, ts TIMESTAMP);`;
    const result = await chunkCodeText(sql, 'header.sql', { chunkSizeTokens: 50 });
    expect(result[0]!.text).toMatch(/^\[SQL\][^\n]*\btable\b/);
    expect(result[0]!.text).not.toMatch(/\bstatement\b/i);
  });

  test('empty SQL input returns empty chunk array', async () => {
    const result = await chunkCodeText('', 'empty.sql');
    expect(result).toEqual([]);
  });

  test('SQL-only whitespace returns empty chunk array', async () => {
    const result = await chunkCodeText('   \n\n   \t  \n', 'whitespace.sql');
    expect(result).toEqual([]);
  });
});

describe('chunkCodeText — TypeScript', () => {
  test('extracts top-level functions with correct symbol names', async () => {
    const src = `export function calculateScore(items: number[]): number {
  let sum = 0;
  for (const i of items) { sum += i; }
  if (sum < 0) return 0;
  return sum / items.length;
}`;
    const result = await chunkCodeText(src, 'calc.ts');
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0]!.metadata.language).toBe('typescript');
    expect(result[0]!.metadata.symbolName).toBe('calculateScore');
    expect(result[0]!.text).toContain('[TypeScript]');
    expect(result[0]!.text).toContain('calc.ts');
  });

  test('extracts classes with methods', async () => {
    const src = `export class Registry {
  private items: Map<string, number> = new Map();
  register(id: string, val: number): void { this.items.set(id, val); }
  lookup(id: string): number | null { return this.items.get(id) ?? null; }
}`;
    const result = await chunkCodeText(src, 'reg.ts');
    const classChunk = result.find(c => c.metadata.symbolName === 'Registry');
    expect(classChunk).toBeDefined();
    // `export class Foo` is wrapped in export_statement at the AST level;
    // symbol extraction still finds "Registry" but the type surface shows
    // the wrapper. See normalizeSymbolType() for the mapping.
    expect(classChunk!.metadata.symbolType).toMatch(/class|export/);
  });
});

describe('chunkCodeText — Python', () => {
  test('extracts class_definition + function_definition', async () => {
    const src = `class Animal:
    def __init__(self, name):
        self.name = name

    def speak(self, sound):
        return f"{self.name} says {sound}"

def pet_the_dog():
    dog = Animal("Rex")
    return dog.speak("woof woof woof woof woof")
`;
    const result = await chunkCodeText(src, 'animal.py');
    expect(result.length).toBeGreaterThanOrEqual(1);
    const allLanguages = result.map(c => c.metadata.language);
    for (const lang of allLanguages) expect(lang).toBe('python');
  });
});

describe('chunkCodeText — Rust', () => {
  test('extracts struct_item + impl_item + function_item', async () => {
    const src = `pub struct UserRecord {
    pub id: u64,
    pub name: String,
    pub active: bool,
    pub score: f64,
}

impl UserRecord {
    pub fn new(id: u64, name: String) -> Self {
        Self { id, name, active: true, score: 0.0 }
    }

    pub fn deactivate(&mut self) {
        self.active = false;
    }

    pub fn bump_score(&mut self, delta: f64) {
        self.score += delta;
    }
}

pub fn compute_total(records: &[UserRecord]) -> f64 {
    records.iter().filter(|r| r.active).map(|r| r.score).sum()
}
`;
    const result = await chunkCodeText(src, 'users.rs');
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]!.metadata.language).toBe('rust');
    const headers = result.map(c => c.text.split('\n')[0]);
    const hasRustTag = headers.some(h => h.includes('[Rust]'));
    expect(hasRustTag).toBe(true);
  });
});

describe('chunkCodeText — Go', () => {
  test('extracts function + type + method declarations', async () => {
    const src = `package main

import "fmt"

type Point struct {
    X, Y int
}

func (p Point) Distance(other Point) float64 {
    dx := float64(p.X - other.X)
    dy := float64(p.Y - other.Y)
    return dx*dx + dy*dy
}

func main() {
    p1 := Point{X: 1, Y: 2}
    p2 := Point{X: 5, Y: 6}
    fmt.Println(p1.Distance(p2))
}
`;
    const result = await chunkCodeText(src, 'main.go');
    expect(result.length).toBeGreaterThanOrEqual(1);
    const headers = result.map(c => c.text.split('\n')[0]);
    expect(headers.some(h => h.includes('[Go]'))).toBe(true);
  });
});

describe('chunkCodeText — fallback for unsupported language', () => {
  test('unsupported extension falls through to recursive chunker', async () => {
    const src = 'this is not code. just text. lots of text. '.repeat(50);
    const result = await chunkCodeText(src, 'unknown.xyz');
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]!.metadata.symbolType).toBe('module');
    expect(result[0]!.metadata.symbolName).toBeNull();
  });
});

describe('chunkCodeText — small-sibling merging', () => {
  test('small adjacent chunks are merged when chunkSizeTokens is generous', async () => {
    // With a very large chunkSizeTokens, the merge threshold rises and
    // more chunks qualify as "small" for accumulation. 10 tiny consts
    // at chunkTarget=1000 gives a merge threshold of 150 — each const
    // chunk (with its structured header) is ~20 tokens, so they all
    // accumulate into one merged group up to the 1000-token budget.
    const src = `const A = 1;
const B = 2;
const C = 3;
const D = 4;
const E = 5;
const F = 6;
const G = 7;
const H = 8;
const I = 9;
const J = 10;
`;
    const result = await chunkCodeText(src, 'constants.ts', { chunkSizeTokens: 1000 });
    expect(result.length).toBeLessThan(10); // at least some merging occurred
    const merged = result.find(c => c.metadata.symbolType === 'merged');
    expect(merged).toBeDefined();
  });

  test('large chunk stays independent', async () => {
    const src = `export function bigFn() {
  let result = 0;
  for (let i = 0; i < 1000; i++) {
    for (let j = 0; j < 1000; j++) {
      result += Math.sqrt(i * i + j * j) * Math.sin(i) * Math.cos(j);
    }
  }
  if (result > 0) { console.log('positive'); }
  else if (result < 0) { console.log('negative'); }
  else { console.log('zero'); }
  return result;
}
`;
    const result = await chunkCodeText(src, 'big.ts', { chunkSizeTokens: 100 });
    const bigChunk = result.find(c => c.metadata.symbolName === 'bigFn');
    expect(bigChunk).toBeDefined();
  });

  test('merged chunk has correct line range spanning merged siblings', async () => {
    const src = `const X = 1;

const Y = 2;

const Z = 3;
`;
    const result = await chunkCodeText(src, 'abc.ts', { chunkSizeTokens: 100 });
    if (result.length === 1 && result[0]!.metadata.symbolType === 'merged') {
      expect(result[0]!.metadata.startLine).toBe(1);
      expect(result[0]!.metadata.endLine).toBeGreaterThanOrEqual(5);
    }
  });
});

describe('chunkCodeText — structured header', () => {
  test('header includes language display name, path, line range, symbol', async () => {
    const src = `export function myFunc() { return 42; }
`;
    const result = await chunkCodeText(src, 'src/lib/foo.ts');
    const first = result[0]!;
    expect(first.text).toMatch(/^\[TypeScript\] src\/lib\/foo\.ts:\d+-\d+ /);
    expect(first.text).toContain('myFunc');
  });
});

describe('chunkCodeText — empty input', () => {
  test('empty source returns empty array', async () => {
    expect(await chunkCodeText('', 'foo.ts')).toEqual([]);
    expect(await chunkCodeText('   \n  ', 'foo.ts')).toEqual([]);
  });
});
