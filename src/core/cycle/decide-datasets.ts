/**
 * Dataset adapters and `gbrain decide dataset --from` builders for the
 * dream-cycle decide slots. Adapters rebuild the production request shape
 * (S7: one request per turn window, transcript value = max window; S8: one
 * request per claim unit over its selected source windows) so calibration,
 * qualification and evals share the production pack shape and reducer.
 *
 *   --from cat35 <corpus dir>        S7 items from the Cat 35 transcript-distill
 *                                    corpus: gold/<id>.json (`expected_triage`
 *                                    high|low) + transcripts-txt/<date>-<id>.txt
 *   --from grounding-labels <jsonl>  S8 items: {"id","page","claim","label",
 *                                    "transcript" | "transcript_path"}; label
 *                                    true/"supported" or false/"unsupported"
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerDatasetAdapter, registerDatasetBuilder, stableSplit, type DatasetItem } from '../ai/decide/dataset.ts';
import { embed, getEmbeddingModel, isAvailable } from '../ai/gateway.ts';
import { groundingQuestion, indexSourceWindows, reduceGrounding, selectSourceWindows } from './grounding-decide.ts';
import { reduceTriage, splitTurnWindows, triageQuestion } from './triage-decide.ts';

function windowBucket(n: number): string {
  return n <= 4 ? 'windows:1-4' : n <= 8 ? 'windows:5-8' : n <= 16 ? 'windows:9-16' : 'windows:17+';
}

/** Registers the S7/S8 adapters and builders (called by the write-path lane module). */
export function registerWritePathDatasets(): void {
  registerDatasetAdapter({
    slot: 'triage',
    callSite: 'dream',
    unpacked: true,
    aggregate: 'max',
    request(family) {
      const itemFor: Record<string, DatasetItem> = {};
      const questions = family.flatMap((it) => splitTurnWindows(it.inputs.transcript ?? '').map((w) => {
        const q = { ...triageQuestion(w.index, w.text, it.id), id: `triage:${it.id}:${w.index}` };
        itemFor[q.id] = it;
        return q;
      }));
      questions.forEach((q, i) => { q.rank = i; });
      return { state: {}, questions, itemFor };
    },
    harmfulActions(family, values, policy) {
      // S7's harmful action is a rejection of a transcript that deserved synthesis.
      return family.filter((it) => reduceTriage(values[it.id] ?? null, policy) === 'reject').map((it) => ({ item: it, correct: it.label === false }));
    },
  });

  registerDatasetAdapter({
    slot: 'grounding',
    callSite: 'dream',
    unpacked: true,
    request(family) {
      const itemFor: Record<string, DatasetItem> = {};
      const questions = family.map((it, i) => {
        // The builder stored the production window selection; only the sources text is replayed.
        const q = groundingQuestion(i, it.inputs.claim ?? '', { windows: [], coverage: it.protected ? 'weak' : 'adequate' }, it.id);
        if (it.inputs.sources) q.inputs!.sources = { ...q.inputs!.sources!, text: it.inputs.sources };
        itemFor[q.id] = it;
        return q;
      });
      return { state: {}, questions, itemFor };
    },
    harmfulActions(family, values, policy) {
      // S8's harmful action is quarantining a supported claim.
      return family.filter((it) => reduceGrounding(values[it.id] ?? null, it.protected ? 'weak' : 'adequate', policy) === 'quarantine')
        .map((it) => ({ item: it, correct: it.label === false }));
    },
  });

  registerDatasetBuilder('cat35', async (dir, opts) => {
    const txtDir = join(dir, 'transcripts-txt');
    const txt = readdirSync(txtDir).filter((f) => f.endsWith('.txt'));
    const items: DatasetItem[] = [];
    for (const g of readdirSync(join(dir, 'gold')).filter((f) => f.endsWith('.json')).sort()) {
      const gold = JSON.parse(readFileSync(join(dir, 'gold', g), 'utf8')) as { transcript_id?: string; expected_triage?: string; scenario?: string };
      const id = gold.transcript_id ?? g.replace(/\.json$/, '');
      const file = txt.find((f) => f.endsWith(`-${id}.txt`) || f === `${id}.txt`);
      if (!file || !gold.expected_triage) continue;
      const transcript = readFileSync(join(txtDir, file), 'utf8');
      items.push({
        id, family: id, slot: opts.slot, split: stableSplit(id, opts.calibrateShare), slice: windowBucket(splitTurnWindows(transcript).length),
        state: {}, inputs: { transcript }, label: gold.expected_triage !== 'low',
      });
    }
    if (items.length === 0) throw new Error(`cat35: no gold/*.json with a matching transcripts-txt/*-<id>.txt under ${dir}`);
    return items;
  });

  registerDatasetBuilder('grounding-labels', async (path, opts) => {
    const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim());
    const items: DatasetItem[] = [];
    const transcripts = new Map<string, string>();
    for (const [n, line] of lines.entries()) {
      const raw = JSON.parse(line) as { id?: string; page?: string; claim?: string; label?: unknown; transcript?: string; transcript_path?: string };
      if (!raw.id || !raw.page || !raw.claim) throw new Error(`grounding-labels line ${n + 1}: id, page and claim are required`);
      const transcript = raw.transcript ?? (raw.transcript_path ? transcripts.get(raw.transcript_path) ?? readFileSync(raw.transcript_path, 'utf8') : undefined);
      if (transcript === undefined) throw new Error(`grounding-labels line ${n + 1}: transcript or transcript_path is required`);
      if (raw.transcript_path) transcripts.set(raw.transcript_path, transcript);
      const index = indexSourceWindows([{ path: raw.transcript_path ?? raw.page, content: transcript }]);
      let vector: Float32Array | undefined;
      if (isAvailable('embedding')) {
        try {
          const vectors = await embed([raw.claim, ...index.map((w) => w.text)], { embeddingModel: getEmbeddingModel() });
          index.forEach((w, i) => { w.embedding = vectors[i + 1]; });
          vector = vectors[0];
        } catch { /* substring + keyword selection only, as in production without an embedding provider */ }
      }
      const sel = selectSourceWindows(raw.claim, index, vector);
      const sources = groundingQuestion(0, raw.claim, sel, raw.page).inputs!.sources!.text;
      items.push({
        id: raw.id, family: raw.page, slot: opts.slot, split: stableSplit(raw.page, opts.calibrateShare), slice: sel.coverage,
        state: {}, inputs: { claim: raw.claim, sources }, label: raw.label === true || raw.label === 'supported',
        ...(sel.coverage === 'weak' ? { protected: true } : {}),
      });
    }
    return items;
  });
}
