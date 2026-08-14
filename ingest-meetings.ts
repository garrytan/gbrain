/**
 * ingest-meetings.ts: land a sub-brain's meetings into its source as pages.
 *
 * The live-feed half of the sub-brain loop. Reads a JSON array of meetings
 * (assembled from Granola by a caller with Granola access) and writes each one
 * as a `meeting` page INTO the named source. sub-dream.ts reads all source
 * pages via SQL, so ingested meetings are dreamed over automatically alongside
 * the doc corpus. No chunking required for the dream to see them.
 *
 * Ringfenced: writes only to source_id=<source>, under meetings/<date>-<slug>.
 *
 * Input JSON: [{ "id", "title", "date" (ISO), "summary", "participants"? }]
 *
 * Usage (from ~/gbrain):
 *   bun ingest-meetings.ts --source zen-garden --file /tmp/zen-garden-meetings.json
 */
import { loadConfig, toEngineConfig } from "./src/core/config.ts";
import { createEngine } from "./src/core/engine-factory.ts";
import { connectWithRetry } from "./src/core/db.ts";
import { readFileSync } from "fs";

function argVal(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const SOURCE = argVal("--source", "zen-garden");
const FILE = argVal("--file", `/tmp/${SOURCE}-meetings.json`);

const slugify = (s: string) => (s || "meeting").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

interface MeetingIn { id?: string; title: string; date?: string; summary: string; participants?: string[] }
const meetings = JSON.parse(readFileSync(FILE, "utf8")) as MeetingIn[];
if (!Array.isArray(meetings) || meetings.length === 0) {
  console.error(`[ingest:${SOURCE}] ${FILE} has no meetings. Aborting.`);
  process.exit(1);
}

const config = loadConfig()!;
const engine = await createEngine(toEngineConfig(config));
await connectWithRetry(engine, toEngineConfig(config), { noRetry: false });

let written = 0;
for (const m of meetings) {
  if (!m.title || !m.summary) { console.warn(`[ingest:${SOURCE}] skipping meeting with no title/summary`); continue; }
  const d = (m.date ?? "").slice(0, 10) || new Date().toISOString().slice(0, 10);
  const slug = `meetings/${d}-${slugify(m.title)}`;
  await engine.putPage(
    slug,
    {
      type: "meeting",
      title: m.title,
      compiled_truth: m.summary,
      frontmatter: {
        date: d,
        source_brain: SOURCE,
        participants: m.participants ?? [],
        granola_id: m.id ?? null,
        ingested_meeting: true,
      },
    },
    { sourceId: SOURCE },
  );
  written++;
  console.log(`[ingest:${SOURCE}] wrote ${slug}`);
}
console.log(`[ingest:${SOURCE}] ingested ${written} meeting(s) into source '${SOURCE}'. Re-run sub-dream to fold them in.`);
process.exit(0);
