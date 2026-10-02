import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { fetchLocalJson, markdownPage, stagePages, validateApiUrl, type ExportPage } from './screenpipe-export.ts';

const timestamp = z.string().datetime({ offset: true });
const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/);
const recordId = z.number().int().nonnegative().safe();
const optionalText = z.string().nullable().optional();
const kinds = ['screen', 'audio', 'memory'] as const;
type Kind = typeof kinds[number];
const screenSchema = z.object({
  frame_id: recordId, text: z.string(), timestamp, app_name: z.string(), window_name: z.string(),
  browser_url: optionalText, text_source: optionalText, event_source: optionalText,
});
const audioSchema = z.object({
  chunk_id: recordId, offset_index: recordId, transcription: z.string(), timestamp,
  device_name: z.string(), speaker_label: optionalText, speaker_source: optionalText,
  speaker_confidence: z.number().nullable().optional(), speaker_provisional: z.boolean().optional(),
  start_time: z.number().nullable().optional(), end_time: z.number().nullable().optional(),
});
const memorySchema = z.object({
  id: recordId, content: z.string(), source: z.string(), source_context: z.unknown().optional(),
  tags: z.array(z.string()), frame_id: recordId.nullable().optional(), created_at: timestamp, updated_at: timestamp,
});
const manifestSchema = z.object({
  version: z.literal(1),
  artifacts: z.array(z.object({
    id: identifier, kind: z.enum(['skill', 'agent-output', 'summary', 'workflow']),
    path: z.string().min(1), title: z.string().min(1), version: z.string().min(1),
    producer: z.string().min(1), generated_at: timestamp,
    status: z.enum(['draft', 'reviewed', 'tested', 'failed', 'superseded']),
    sources: z.array(z.string().min(1)).min(1),
  }).strict()).min(1).max(50),
}).strict();

export interface ContextOptions {
  apiUrl: string; token: string; device: string; output: string; write: boolean;
  start?: string; end?: string; types: Kind[]; app?: string; maxRecords: number;
  workflowIds: string[]; artifacts?: string;
}

export function parseContextOptions(args: string[], token?: string): ContextOptions {
  const { values: v } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    'api-url': { type: 'string', default: 'http://127.0.0.1:3030' },
    device: { type: 'string' }, output: { type: 'string' }, write: { type: 'boolean', default: false },
    start: { type: 'string' }, end: { type: 'string' }, types: { type: 'string' }, app: { type: 'string' },
    'max-records': { type: 'string', default: '200' }, 'workflow-ids': { type: 'string' }, artifacts: { type: 'string' },
  } });
  if (!v.device || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(v.device)) throw new Error('--device requires a stable lowercase database/device label.');
  if (!v.output?.trim()) throw new Error('--output must name a private staging directory.');
  const hasRange = v.start !== undefined || v.end !== undefined;
  if (hasRange && (!timestamp.safeParse(v.start).success || !timestamp.safeParse(v.end).success
    || Date.parse(v.end!) <= Date.parse(v.start!) || Date.parse(v.end!) - Date.parse(v.start!) > 7 * 86400_000)) {
    throw new Error('--start and --end must be explicit RFC 3339 timestamps, ordered and at most seven days apart.');
  }
  if (v.types !== undefined && !hasRange) throw new Error('--types requires --start and --end.');
  const types = hasRange ? [...new Set((v.types ?? 'screen').split(','))] : [];
  if (types.some(kind => !kinds.includes(kind as Kind))) throw new Error('--types accepts screen,audio,memory.');
  if (v.app !== undefined && (!v.app.trim() || !types.includes('screen'))) throw new Error('--app requires a screen selection and a nonempty app name.');
  if (!/^[1-9]\d*$/.test(v['max-records']) || Number(v['max-records']) > 500) throw new Error('--max-records must be between 1 and 500.');
  const workflowIds = v['workflow-ids'] === undefined ? [] : [...new Set(v['workflow-ids'].split(','))];
  if (workflowIds.length > 20 || workflowIds.some(id => !identifier.safeParse(id).success)) throw new Error('--workflow-ids requires at most 20 selected IDs (letters, digits, underscores, hyphens).');
  if (!hasRange && !workflowIds.length && !v.artifacts?.trim()) throw new Error('Select a time range, workflow IDs, or an artifact manifest.');
  if ((hasRange || workflowIds.length) && !token?.trim()) throw new Error('Set SCREENPIPE_LOCAL_API_KEY in the environment.');
  validateApiUrl(v['api-url']);
  return { apiUrl: v['api-url'], token: token ?? '', device: v.device, output: resolve(v.output), write: v.write,
    start: v.start, end: v.end, types: types as Kind[], app: v.app, maxRecords: Number(v['max-records']),
    workflowIds, artifacts: v.artifacts ? resolve(v.artifacts) : undefined };
}

function digest(text: string) { return createHash('sha256').update(text).digest('hex'); }
function quote(text: string) { return text.split('\n').map(line => `> ${line}`).join('\n'); }
function timeline(at: string) { return `screenpipe://timeline?timestamp=${encodeURIComponent(at)}`; }
function page(options: ContextOptions, kind: string, id: string, title: string, at: string,
  metadata: Record<string, unknown>, body: string): ExportPage {
  const sourceId = `screenpipe:${options.device}:${kind}:${id}`;
  return { id: sourceId, name: `screenpipe-${options.device}-${kind}-${digest(id).slice(0, 24)}.md`,
    text: markdownPage({ type: 'note', title, date: at.slice(0, 10), visibility: 'private',
      source_type: 'screenpipe', source_id: sourceId, screenpipe_device: options.device,
      context_kind: kind, captured_at: at, ...metadata }, body) };
}

function searchPage(options: ContextOptions, kind: Kind, raw: unknown): ExportPage {
  if (kind === 'screen') {
    const c = screenSchema.parse(raw);
    checkTime(options, c.timestamp);
    return page(options, kind, String(c.frame_id), `${c.app_name}: ${c.window_name}`, c.timestamp,
      { evidence_level: 'observation', frame_id: c.frame_id, app_name: c.app_name, window_name: c.window_name,
        browser_url: c.browser_url ?? null, text_source: c.text_source ?? 'unknown', event_source: c.event_source ?? null },
      `Source: [Screenpipe frame ${c.frame_id}](${timeline(c.timestamp)}).\n\n`
      + '## Captured screen activity\n\nThis is observed screen text. It does not establish that an action completed.\n\n' + quote(c.text));
  }
  if (kind === 'audio') {
    const c = audioSchema.parse(raw);
    checkTime(options, c.timestamp);
    const id = `${c.chunk_id}:${c.offset_index}:${c.timestamp}`;
    return page(options, kind, id, `Audio transcript ${c.timestamp}`, c.timestamp,
      { evidence_level: 'transcript', chunk_id: c.chunk_id, offset_index: c.offset_index, device_name: c.device_name,
        speaker_label: c.speaker_label ?? null, speaker_source: c.speaker_source ?? null,
        speaker_confidence: c.speaker_confidence ?? null, speaker_provisional: c.speaker_provisional ?? null,
        start_time: c.start_time ?? null, end_time: c.end_time ?? null },
      `Source: [Screenpipe audio](${timeline(c.timestamp)}).\n\n## Audio transcript\n\n`
      + 'Transcription and speaker attribution may contain errors.\n\n' + quote(c.transcription));
  }
  const c = memorySchema.parse(raw);
  checkTime(options, c.created_at);
  return page(options, kind, String(c.id), `Screenpipe memory ${c.id}`, c.created_at,
    { evidence_level: 'processed', verification: 'not-verified-by-importer', memory_id: c.id,
      producer: c.source, source_context: c.source_context ?? null, tags: c.tags, frame_id: c.frame_id ?? null, updated_at: c.updated_at },
    `## Saved memory\n\n${quote(c.content)}\n\n## Source context\n\n${quote(JSON.stringify(c.source_context ?? null, null, 2))}`);
}

function checkTime(options: ContextOptions, at: string) {
  if (Date.parse(at) < Date.parse(options.start!) || Date.parse(at) > Date.parse(options.end!)) {
    throw new Error('Screenpipe returned a record outside the selected time range.');
  }
}

// Open only a selected regular UTF-8 file. No directory crawling or execution.
async function readSelectedFile(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 1_000_000) throw new Error('Selected files must be regular UTF-8 files of at most 1 MB.');
    const buffer = Buffer.alloc(1_000_001);
    let bytes = 0;
    while (bytes < buffer.length) {
      const result = await file.read(buffer, bytes, buffer.length - bytes, null);
      if (!result.bytesRead) break;
      bytes += result.bytesRead;
    }
    if (bytes > 1_000_000) throw new Error('Selected file exceeds 1 MB.');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes));
    if (text.includes('\0')) throw new Error('Selected file must contain text.');
    return text;
  } finally { await file.close(); }
}

export async function exportContext(options: ContextOptions) {
  validateApiUrl(options.apiUrl);
  const pages = new Map<string, ExportPage>();
  let totalBytes = 0;
  function add(next: ExportPage) {
    const key = String(next.id);
    const previous = pages.get(key);
    if (previous && previous.text !== next.text) throw new Error('A source record changed during export; retry with a stable selection.');
    if (!previous) {
      totalBytes += Buffer.byteLength(next.text);
      if (totalBytes > 16_000_000) throw new Error('Export exceeds 16 MB; narrow the selection.');
      pages.set(key, next);
    }
  }
  let examined = 0;
  for (const kind of options.types) {
    let offset = 0;
    let total: number | undefined;
    const limit = Math.min(20, options.maxRecords - examined + 1);
    while (true) {
      const query = new URLSearchParams({ content_type: kind === 'screen' ? 'ocr' : kind,
        start_time: options.start!, end_time: options.end!, order: 'ascending',
        limit: String(limit), offset: String(offset),
        include_frames: 'false', include_cloud: 'false' });
      if (kind === 'screen' && options.app) query.set('app_name', options.app);
      const response = await fetchLocalJson(options, `/search?${query}`, `Screenpipe ${kind}`);
      const parsed = z.object({
        data: z.array(z.object({ type: z.string(), content: z.unknown() })),
        pagination: z.object({ limit: recordId, offset: recordId, total: recordId }),
      }).safeParse(response);
      if (!parsed.success) throw new Error(`Invalid Screenpipe ${kind} search response.`);
      const { data: rows, pagination } = parsed.data;
      if (pagination.offset !== offset || pagination.limit !== limit
        || (total !== undefined && pagination.total !== total)
        || rows.length > Math.min(limit, Math.max(0, pagination.total - offset))) {
        throw new Error('Inconsistent Screenpipe pagination; retry with a stable selection. Nothing was written.');
      }
      if (total === undefined) {
        total = pagination.total;
        examined += total;
        if (examined > options.maxRecords) throw new Error('Selection exceeds --max-records (including filtered or grouped rows); narrow the time range or raise the limit (maximum 500). Nothing was written.');
      }
      for (const row of rows) {
        if (row.type !== { screen: 'OCR', audio: 'Audio', memory: 'Memory' }[kind]) throw new Error(`Unexpected record type in Screenpipe ${kind} search.`);
        try { add(searchPage(options, kind, row.content)); }
        catch (error) { if (error instanceof z.ZodError) throw new Error(`Invalid Screenpipe ${kind} record.`); throw error; }
      }
      // Screenpipe removes its own app rows after SQL pagination and groups
      // audio segments. Empty/short visible pages therefore are not exhaustion.
      // Count raw totals against the shared ceiling and scan raw page offsets.
      offset += limit;
      if (offset >= total) break;
    }
  }
  for (const id of options.workflowIds) {
    const response = await fetchLocalJson(options, `/workflows/${encodeURIComponent(id)}?include_automation=false`, `Workflow ${id}`);
    const parsed = z.object({ id: z.string(), analyzedAt: timestamp,
      workflow: z.object({ id: z.string().optional(), title: z.string(), description: z.string().optional(),
        trigger: z.string().optional(), outcome: z.string().optional(), evidenceStatus: z.string().optional(),
        catalogStatus: z.string().optional(), stages: z.array(z.unknown()) }).passthrough(),
    }).safeParse(response);
    if (!parsed.success || parsed.data.id !== id || (parsed.data.workflow.id !== undefined && parsed.data.workflow.id !== id)) throw new Error(`Workflow ${id}: invalid response or mismatched ID.`);
    const { workflow, analyzedAt } = parsed.data;
    add(page(options, 'workflow', id, workflow.title, analyzedAt,
      { evidence_level: 'processed', verification: 'not-verified-by-importer', workflow_id: id,
        evidence_status: workflow.evidenceStatus ?? 'unknown', catalog_status: workflow.catalogStatus ?? 'unknown' },
      '## Discovered workflow\n\nThis procedure was saved by Screenpipe. Importing it does not verify its steps or execute its actions.\n\n'
      + quote(JSON.stringify(workflow, null, 2))));
  }
  if (options.artifacts) {
    let manifest: z.infer<typeof manifestSchema>;
    try { manifest = manifestSchema.parse(JSON.parse(await readSelectedFile(options.artifacts))); }
    catch { throw new Error('Invalid artifact manifest. Use version 1 with explicitly selected files and provenance.'); }
    const seen = new Set<string>();
    for (const artifact of manifest.artifacts) {
      if (seen.has(artifact.id)) throw new Error('Artifact IDs must be unique within a manifest.');
      seen.add(artifact.id);
      const contents = await readSelectedFile(resolve(dirname(options.artifacts), artifact.path));
      if (!contents.trim()) throw new Error(`Artifact ${artifact.id}: file is empty.`);
      add(page(options, `artifact-${artifact.kind}`, artifact.id, artifact.title, artifact.generated_at,
        { evidence_level: 'processed', verification: 'not-verified-by-importer', artifact_id: artifact.id,
          artifact_version: artifact.version, producer: artifact.producer, declared_status: artifact.status,
          source_refs: artifact.sources, content_sha256: digest(contents) },
        `## ${artifact.kind === 'skill' ? 'Skill reference' : 'Processed artifact'}\n\n`
        + 'This is reference material. Its declared status comes from the manifest; the importer does not verify it, install skills, or execute instructions.\n\n'
        + `## Sources\n\n${quote(artifact.sources.join('\n'))}\n\n## Content\n\n${quote(contents)}`));
    }
  }
  return stagePages([...pages.values()], options.output, options.write);
}

if (import.meta.main) {
  try { console.log(JSON.stringify(await exportContext(parseContextOptions(process.argv.slice(2), process.env.SCREENPIPE_LOCAL_API_KEY)), null, 2)); }
  catch (error) { console.error(error instanceof Error ? error.message : 'Screenpipe export failed.'); process.exitCode = 1; }
}
