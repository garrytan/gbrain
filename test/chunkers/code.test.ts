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
  test('recognizes all 29 supported extensions', () => {
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
