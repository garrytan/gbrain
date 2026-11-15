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
import type { ArchiveConversation, ArchiveReader } from './archive.ts';

const NO_SESSIONS = (harness: string) => 'no readable sessions for ' + harness + '; use gbrain connectors or an export with gbrain transcripts ingest';

export function fileReader(root: HarnessRoot): ArchiveReader {
  const present = existsSync(root.root);
  return {
    harness: root.format,
    name: root.format + '-files',
    ...(present ? {} : { unavailable: NO_SESSIONS(root.format) }),
    async list({ sinceMs }) {
      const out: ArchiveConversation[] = [];
      for (const file of discoverTranscriptFiles([root])) {
        if (sinceMs !== undefined) {
          try { if (lstatSync(file.path).mtimeMs < sinceMs) continue; } catch { continue; }
        }
        const detected = detectAdapter(file.path, { explicitFormat: file.format });
        if (!detected.ok) continue;
        const gen = detected.adapter.parse(file.path);
        try {
          for (let step = await gen.next(); !step.done; step = await gen.next()) {
            const session = step.value;
            if (session.messages.length) out.push({ harness: session.meta.harness, conversationKey: session.meta.sessionId, session, via: 'file' });
          }
        } catch {
          // One unreadable or oversized file never stops the harness; ingest's drift report names it.
        }
      }
      return out;
    },
  };
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
