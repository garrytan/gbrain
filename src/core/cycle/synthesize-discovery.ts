import { join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { PhaseResult } from '../cycle.ts';
import { claudeCliSelfSessionIds } from '../ai/providers/claude-cli-scratch.ts';
import { loadPatternsOutputSlugPrefix } from './patterns.ts';
import { noCandidates, partitionCompletedSynthesis } from './synthesize-completion.ts';
import { keepSessionSourceTranscripts, type SessionSourceRouting } from './synthesize-source-routing.ts';
import type { SynthConfig, SynthesizePhaseOpts } from './synthesize.ts';
import { discoverTranscripts, readSingleTranscript, withConversationPages, type DiscoveredTranscript } from './transcript-discovery.ts';

export async function discoverSynthesisCandidates(engine: BrainEngine, opts: SynthesizePhaseOpts, config: SynthConfig,
  routing: SessionSourceRouting, summaryDir: string, sinceMs?: number) {
  const { brainDir, inputFile, date, from, to, sourceId, bypassDreamGuard, dryRun, sessionsOnly } = opts;
  const { corpusDir, meetingTranscriptsDir, minChars, excludePatterns } = config;
  let corpus: DiscoveredTranscript[] = [];
  if (inputFile) {
    const transcript = readSingleTranscript(inputFile, { minChars, excludePatterns, bypassGuard: bypassDreamGuard, sinceMs });
    if (transcript) corpus.push(transcript);
  } else if (corpusDir) {
    corpus = discoverTranscripts({
      corpusDir, meetingTranscriptsDir: meetingTranscriptsDir ?? undefined, minChars, excludePatterns,
      date, from, to, sinceMs, bypassGuard: bypassDreamGuard,
      excludeDirs: bypassDreamGuard || brainDir === null ? [] : [
        config.reflectionsPrefix, config.originalsPrefix, await loadPatternsOutputSlugPrefix(engine, config.outputRoot), summaryDir,
      ].map(prefix => join(brainDir, prefix)),
      selfCaptureSessionIds: claudeCliSelfSessionIds(),
    });
  }
  return keepSessionSourceTranscripts(engine, await withConversationPages(engine, { ...opts, sinceMs }, config, corpus),
    { corpusDir, sourceId: sourceId ?? 'default', readOnly: dryRun, sessionsOnly }, routing);
}

export async function previewSynthesisCandidates(engine: BrainEngine, transcripts: DiscoveredTranscript[],
  sourceId: string, since: string): Promise<PhaseResult> {
  const alreadySynthesized = transcripts.length
    ? (await partitionCompletedSynthesis(engine, transcripts, sourceId, null, true)).completed.size : 0;
  const candidates = transcripts.length - alreadySynthesized;
  const details = { since, transcripts_discovered: transcripts.length,
    synthesis_state: { candidates, already_synthesized: alreadySynthesized }, dryRun: true };
  if (!transcripts.length) return noCandidates(`no transcripts to process (since ${since})`, details);
  return { phase: 'synthesize', status: 'ok', duration_ms: 0,
    summary: `dry-run: ${candidates} transcript candidate(s) (since ${since}); no triage run`,
    details: { ...details, transcripts_processed: 0, pages_written: 0 } };
}
