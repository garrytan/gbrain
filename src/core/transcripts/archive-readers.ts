/**
 * archive-readers.ts — where the conversation archive reads sessions on this machine (GST-2768).
 *
 * One reader per harness root from harnessRoots() (Claude Code, Codex, OpenClaw files including the archived
 * .jsonl.reset.* / .jsonl.deleted.* variants, Hermes, Grok), parsed by the existing adapters, plus the OpenClaw
 * Gateway reader when the openclaw CLI is on PATH (or GBRAIN_OPENCLAW_GATEWAY_URL names a Gateway). A harness with
 * nothing on this machine is an informational line, never an error. Consumer chat apps have no local store: their
 * history arrives through gbrain connectors or an export.
 */

import { existsSync, lstatSync } from 'node:fs';
import { detectAdapter, harnessRoots, type HarnessRoot } from './detect.ts';
import { discoverTranscriptFiles } from './discover.ts';
import { openclawGatewayReader } from './openclaw-gateway.ts';
import { archiveMessageId, type ArchiveConversation, type ArchiveReader } from './archive.ts';
import type { ParsedSession, TranscriptFormat, TranscriptMessage } from './types.ts';

const NO_SESSIONS = (harness: string) => 'no readable sessions for ' + harness + '; use gbrain connectors or an export with gbrain transcripts ingest';

export function fileReader(root: HarnessRoot): ArchiveReader {
  const present = existsSync(root.root);
  return {
    harness: root.format,
    name: root.format + '-files',
    ...(present ? {} : { unavailable: NO_SESSIONS(root.format) }),
    async *scan({ sinceMs, minMtimeMs, dayOf }) {
      const floor = minMtimeMs ?? sinceMs;
      const found = new Map<string, { harness: TranscriptFormat; sessionId: string; dayIds: Map<string, Set<string>>; newest?: string; paths: string[] }>();
      for (const file of discoverTranscriptFiles([root], { includeArchived: true })) {
        if (floor !== undefined) {
          try { if (lstatSync(file.path).mtimeMs < floor) continue; } catch { continue; }
        }
        for await (const session of parseFile(file.path, file.format)) {
          const key = session.meta.harness + '\u0000' + session.meta.sessionId;
          const seen = found.get(key) ?? { harness: session.meta.harness, sessionId: session.meta.sessionId, dayIds: new Map<string, Set<string>>(), paths: [] };
          found.set(key, seen);
          if (!seen.paths.includes(file.path)) seen.paths.push(file.path);
          for (const m of session.messages) {
            if (!m.timestamp) continue;
            const day = dayOf(m.timestamp);
            const ids = seen.dayIds.get(day) ?? new Set<string>();
            seen.dayIds.set(day, ids.add(archiveMessageId(m)));
            if (!seen.newest || m.timestamp > seen.newest) seen.newest = m.timestamp;
          }
        }
      }
      for (const s of found.values()) {
        yield {
          harness: s.harness, conversationKey: s.sessionId, sessionId: s.sessionId, via: 'file' as const,
          days: [...s.dayIds.keys()], dayIds: Object.fromEntries([...s.dayIds].map(([d, ids]) => [d, [...ids]])), ...(s.newest ? { newest: s.newest } : {}),
          load: () => loadSession(s.harness, s.sessionId, s.paths),
        };
      }
    },
  };
}

async function* parseFile(path: string, format: TranscriptFormat): AsyncGenerator<ParsedSession> {
  const detected = detectAdapter(path, { explicitFormat: format });
  if (!detected.ok) return;
  const gen = detected.adapter.parse(path);
  try {
    for (let step = await gen.next(); !step.done; step = await gen.next()) {
      if (step.value.messages.length) yield step.value;
    }
  } catch {
    // One unreadable or oversized file never stops the harness; ingest's drift report names it.
  }
}

/** One session read again from every file that holds it (live, rotated, reset, deleted), messages merged once each, oldest first. */
async function loadSession(harness: TranscriptFormat, sessionId: string, paths: string[]): Promise<ArchiveConversation | null> {
  let meta: ParsedSession['meta'] | undefined;
  let metaNewest = '';
  const seen = new Set<string>();
  const messages: TranscriptMessage[] = [];
  for (const path of paths) {
    for await (const session of parseFile(path, harness)) {
      if (session.meta.harness !== harness || session.meta.sessionId !== sessionId) continue;
      const last = session.messages[session.messages.length - 1]?.timestamp ?? '';
      if (!meta || last > metaNewest) { meta = session.meta; metaNewest = last; }
      for (const m of session.messages) {
        const id = archiveMessageId(m);
        if (seen.has(id)) continue;
        seen.add(id);
        messages.push(m);
      }
    }
  }
  if (!meta || messages.length === 0) return null;
  messages.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  return { harness, conversationKey: sessionId, session: { meta, messages }, via: 'file' };
}

export function fileArchiveReaders(roots?: HarnessRoot[]): ArchiveReader[] {
  const readers = harnessRoots(roots).map(fileReader);
  const bun = (globalThis as { Bun?: { which?: (bin: string) => string | null } }).Bun;
  const gateway = !!process.env.GBRAIN_OPENCLAW_GATEWAY_URL || !!bun?.which?.('openclaw');
  readers.push(gateway ? openclawGatewayReader() : {
    harness: 'openclaw', name: 'openclaw-gateway', list: async () => [],
    unavailable: 'no OpenClaw Gateway on this machine (openclaw is not on PATH); OpenClaw conversations come only from its session files',
  });
  return readers;
}
