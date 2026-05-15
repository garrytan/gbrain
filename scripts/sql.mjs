#!/usr/bin/env bun
import { loadConfig, toEngineConfig } from '../src/core/config.ts';
import { createEngine } from '../src/core/engine-factory.ts';

const sql = process.argv[2];
if (!sql) { console.error('usage: sql.mjs "<query>"'); process.exit(1); }
const cfg = loadConfig();
if (!cfg) { console.error('no config'); process.exit(1); }
const ec = toEngineConfig(cfg);
const engine = await createEngine(ec);
await engine.connect(ec);
const rows = await engine.executeRaw(sql);
console.log(JSON.stringify(rows, (k,v) => typeof v === 'bigint' ? Number(v) : v, 2));
process.exit(0);
