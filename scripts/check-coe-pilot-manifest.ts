import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parsePilotManifest } from "../src/coe/registry/index.ts";

const manifestPath = resolve("fixtures/coe/pilot/science-one-coe/manifest.json");
const manifest = parsePilotManifest(JSON.parse(await readFile(manifestPath, "utf8")));
process.stdout.write(`CoE pilot manifest valid: ${manifest.corpus_id} (${manifest.entries.length} entries)\n`);
