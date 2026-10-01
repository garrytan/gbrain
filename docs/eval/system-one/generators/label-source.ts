/**
 * Stamp label provenance onto a `gbrain decide dataset` output.
 *
 *   bun docs/eval/system-one/generators/label-source.ts <in.jsonl> <out.jsonl> <label_source> [design.json | source.jsonl]
 *
 * Adds `label_source` to every line. With a know-to-ask-extra `_design.json`
 * it also adds the designed `intent/subtype` as `design`; with a source JSONL
 * (S9 pairs, S8 labels) joined by `id` it copies that line's provenance and
 * baseline fields (label_source, which then overrides the argument, plus any of
 * case, attribute, origin, judge_model, baseline_cosine, baseline_decision,
 * baseline_model, sweep_eligible). The fields the
 * builder wrote are left unchanged, so the split and split_hash are
 * identical to the builder's; `parseDatasetJsonl` ignores the extra keys.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [input, output, labelSource, designPath] = process.argv.slice(2);
if (!input || !output || !labelSource) {
  console.error('usage: label-source.ts <in.jsonl> <out.jsonl> <label_source> [design.json]');
  process.exit(1);
}
const JOIN_FIELDS = ['label_source', 'case', 'attribute', 'origin', 'judge_model', 'baseline_cosine', 'baseline_decision', 'baseline_model', 'sweep_eligible'];
const joined = designPath?.endsWith('.jsonl')
  ? new Map(readFileSync(designPath, 'utf8').split('\n').filter((l) => l.trim()).map((l) => {
    const raw = JSON.parse(l) as Record<string, unknown>;
    return [String(raw.id), Object.fromEntries(JOIN_FIELDS.filter((f) => raw[f] !== undefined).map((f) => [f, raw[f]]))] as const;
  }))
  : undefined;
const design = designPath && !joined
  ? (JSON.parse(readFileSync(designPath, 'utf8')) as { turns: Record<string, { intent: string; subtype: string }> }).turns
  : undefined;
const lines = readFileSync(input, 'utf8').split('\n').filter((l) => l.trim());
const out = lines.map((line) => {
  const item = JSON.parse(line) as Record<string, unknown>;
  const d = design?.[String(item.id)];
  const j = joined?.get(String(item.id));
  if (joined && !j) throw new Error(`no source line for id ${String(item.id)}`);
  return JSON.stringify({ ...item, label_source: labelSource, ...(d ? { design: `${d.intent}/${d.subtype}` } : {}), ...(j ?? {}) });
});
writeFileSync(output, out.join('\n') + (out.length ? '\n' : ''));
console.error(`${out.length} lines -> ${output}`);
