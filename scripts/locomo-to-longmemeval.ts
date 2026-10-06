#!/usr/bin/env bun
/**
 * Convert LoCoMo conversations into a LongMemEval-format dataset for
 * `gbrain eval longmemeval`. Conversion rules: src/eval/longmemeval/locomo.ts.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { convertLocomo, LOCOMO_SEALED_CONVERSATIONS, type LocomoSample } from '../src/eval/longmemeval/locomo.ts';

const HELP = `Usage: bun scripts/locomo-to-longmemeval.ts --input locomo10.json --conversations conv-44,conv-47 --output out.json [--custodian]

Writes one LongMemEval question per LoCoMo QA (category 5, adversarial, is
excluded) for the listed conversations only; there is no default list.

  --input FILE           LoCoMo locomo10.json
                         (https://raw.githubusercontent.com/snap-research/locomo/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/data/locomo10.json)
  --conversations LIST   Comma-separated sample ids to convert (required).
  --output FILE          LongMemEval-format JSON array.
  --custodian            Required to convert a sealed conversation.

The sealed LoCoMo split (${LOCOMO_SEALED_CONVERSATIONS.join(', ')}) is run only by the eval custodian.
Development runs use the other conversations.
`;

function main(argv: string[]): void {
  const opts: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { process.stdout.write(HELP); return; }
    if (a === '--custodian') { opts.custodian = true; continue; }
    if (a === '--input' || a === '--conversations' || a === '--output') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new Error(`${a} requires a value`);
      opts[a.slice(2)] = v;
      continue;
    }
    throw new Error(`unknown argument ${a} (see --help)`);
  }
  if (typeof opts.input !== 'string' || typeof opts.conversations !== 'string' || typeof opts.output !== 'string') {
    throw new Error('--input, --conversations and --output are required (see --help)');
  }
  const conversations = opts.conversations.split(',').map(s => s.trim()).filter(Boolean);
  const samples = JSON.parse(readFileSync(opts.input, 'utf8')) as LocomoSample[];
  const { questions, skipped } = convertLocomo(samples, conversations, { custodian: opts.custodian === true });
  writeFileSync(opts.output, JSON.stringify(questions));
  for (const c of conversations) {
    const n = questions.filter(q => q.question_id.startsWith(`${c}_q`)).length;
    process.stderr.write(`${c}: ${n} question(s); skipped ${skipped[c].adversarial} adversarial, ${skipped[c].no_evidence} without usable evidence\n`);
  }
  process.stderr.write(`wrote ${questions.length} question(s) to ${opts.output}\n`);
}

try {
  main(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
