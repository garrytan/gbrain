import type { FactsFenceParseResult } from './facts-fence.ts';

/** Exact-content LRU: no page/source identity, ledger state, or derived privacy view is cached. */
export class FactsFenceCache {
  private readonly entries = new Map<string, FactsFenceParseResult>();
  private characters = 0;
  private rows = 0;

  constructor(private readonly limits = { entries: 8, characters: 16 * 1024 * 1024, rows: 65_536, minimum: 16_384 }) {}

  parse(body: string, parse: (body: string) => FactsFenceParseResult): FactsFenceParseResult {
    if (body.length < this.limits.minimum || body.length > this.limits.characters) return parse(body);
    const hit = this.entries.get(body);
    if (hit) {
      this.entries.delete(body);
      this.entries.set(body, hit);
      return this.copy(hit);
    }
    const result = parse(body);
    // Warnings can contain complete malformed rows. Keep their diagnostic allocation transient.
    if (result.warnings.length || result.facts.length > this.limits.rows) return result;
    while (this.entries.size && (this.entries.size >= this.limits.entries
      || this.characters + body.length > this.limits.characters || this.rows + result.facts.length > this.limits.rows)) {
      const oldest = this.entries.keys().next().value!;
      this.characters -= oldest.length;
      this.rows -= this.entries.get(oldest)!.facts.length;
      this.entries.delete(oldest);
    }
    this.entries.set(body, result);
    this.characters += body.length;
    this.rows += result.facts.length;
    return this.copy(result);
  }

  private copy(result: FactsFenceParseResult): FactsFenceParseResult {
    // ParsedFact contains only primitives. Existing callers mutate rows/arrays, so never share them.
    return { facts: result.facts.map(fact => ({ ...fact })), warnings: [...result.warnings] };
  }
}
