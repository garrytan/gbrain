import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  COE_CANONICALIZATION_PROFILE,
  COE_JSON_SCHEMA_DIALECT,
  COE_SCHEMA_VERSION,
  COE_SCHEMAS_V1,
  coeJsonSchema,
  sha256Bytes,
} from "../src/coe/contracts/index.ts";

const outputDirectory = resolve(import.meta.dir, "../schemas/coe/v1");
const checkOnly = process.argv.includes("--check");

async function assertCurrent(path: string, expected: string): Promise<void> {
  let actual: string;
  try {
    actual = await readFile(path, "utf8");
  } catch {
    throw new Error(`Missing generated CoE schema artifact: ${path}`);
  }
  if (actual !== expected) {
    throw new Error(`Stale generated CoE schema artifact: ${path}`);
  }
}

await mkdir(outputDirectory, { recursive: true });

const artifacts: Array<{ name: string; file: string; sha256: string }> = [];
for (const schemaName of Object.keys(COE_SCHEMAS_V1).sort() as Array<keyof typeof COE_SCHEMAS_V1>) {
  const filename = `${schemaName}.schema.json`;
  const serialized = `${JSON.stringify(coeJsonSchema(schemaName), null, 2)}\n`;
  const path = resolve(outputDirectory, filename);
  if (checkOnly) await assertCurrent(path, serialized);
  else await writeFile(path, serialized, "utf8");
  artifacts.push({ name: schemaName, file: filename, sha256: sha256Bytes(serialized) });
}

const manifest = {
  schema_version: COE_SCHEMA_VERSION,
  json_schema_dialect: COE_JSON_SCHEMA_DIALECT,
  canonicalization_profile: COE_CANONICALIZATION_PROFILE,
  generated_from: "src/coe/contracts/v1.ts",
  artifacts,
};
const serializedManifest = `${JSON.stringify(manifest, null, 2)}\n`;
const manifestPath = resolve(outputDirectory, "manifest.json");
if (checkOnly) await assertCurrent(manifestPath, serializedManifest);
else await writeFile(manifestPath, serializedManifest, "utf8");

console.log(`${checkOnly ? "Checked" : "Generated"} ${artifacts.length} CoE Lite v1 schemas`);
