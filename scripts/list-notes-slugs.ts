#!/usr/bin/env bun
/**
 * 直接查資料庫取所有 notes/ slug，輸出到 /tmp/notes-slugs.txt
 * Usage: bun scripts/list-notes-slugs.ts
 */
import postgres from "postgres";
import { readFileSync } from "fs";
import { homedir } from "os";

const configPath = `${homedir()}/.gbrain/config.json`;
const config = JSON.parse(readFileSync(configPath, "utf-8"));
const db = postgres(config.database_url, { max: 1 });

const rows = await db`
  SELECT slug FROM pages
  WHERE slug LIKE 'notes/%'
  ORDER BY slug
`;

for (const row of rows) {
  console.log(row.slug);
}

process.stderr.write(`Total notes/ slugs: ${rows.length}\n`);
await db.end();
