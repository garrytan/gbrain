import { chunkCodeText } from '../src/core/chunkers/code.ts';

// Large function body so it doesn't merge with siblings — the CI guard
// needs at least one chunk with a concrete symbol name to prove the
// tree-sitter WASM is actually resolving (not just recursive fallback).
const src = `export function calculateScore(
  items: Array<{ value: number; weight: number }>,
  opts: { normalize?: boolean; cap?: number } = {}
): number {
  if (items.length === 0) return 0;
  const sum = items.reduce((acc, it) => acc + it.value * it.weight, 0);
  const totalWeight = items.reduce((acc, it) => acc + it.weight, 0);
  if (totalWeight === 0) return 0;
  const raw = sum / totalWeight;
  if (opts.normalize) {
    const clamped = Math.max(0, Math.min(1, raw));
    return opts.cap !== undefined ? Math.min(opts.cap, clamped) : clamped;
  }
  return opts.cap !== undefined ? Math.min(opts.cap, raw) : raw;
}

export class UserRegistry {
  private users: Map<string, { name: string; score: number }> = new Map();

  register(id: string, name: string, score: number): void {
    this.users.set(id, { name, score });
  }

  lookup(id: string): { name: string; score: number } | null {
    return this.users.get(id) ?? null;
  }

  topK(k: number): Array<{ id: string; name: string; score: number }> {
    const entries = Array.from(this.users.entries());
    entries.sort((a, b) => b[1].score - a[1].score);
    return entries.slice(0, k).map(([id, v]) => ({ id, ...v }));
  }
}

export type UserId = string;
`;
const result = await chunkCodeText(src, 'smoketest.ts');
const hasSymbolNames = result.some(c => c.metadata.symbolName !== null);
const hasTypeScriptHeader = result.some(c => c.text.startsWith('[TypeScript]'));
console.log(JSON.stringify({
  count: result.length,
  has_symbol_names: hasSymbolNames,
  has_typescript_header: hasTypeScriptHeader,
  first_header: result[0]?.text.split('\n')[0],
  symbol_names: result.map(c => c.metadata.symbolName),
}, null, 2));
