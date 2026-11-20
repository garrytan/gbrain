// Feeds doctor checks an engine whose reads throw (as a lost connection or a missing table would),
// then grades the checks with the real computeDoctorReport.
import { quarantineEntry } from '/code/garrytan/gbrain/src/commands/doctor/checks/content-quality.ts';
import { checkLinkResolutionOpportunity } from '/code/garrytan/gbrain/src/commands/doctor/checks/calibration.ts';
import { checkSearchMode } from '/code/garrytan/gbrain/src/commands/doctor/checks/search-eval.ts';
import { computeDoctorReport } from '/code/garrytan/gbrain/src/commands/doctor.ts';
const boom = async () => { throw new Error('connection terminated unexpectedly'); };
const engine: any = new Proxy({ kind: 'pglite' }, { get: (t: any, k) => (k in t ? t[k] : boom) });
const progress: any = { heartbeat() {}, start() {}, tick() {}, finish() {}, child() { return progress; } };
const checks: any[] = [];
checks.push(...await quarantineEntry.run({ engine, progress, args: [], tier: 'standard' } as any));
checks.push(await checkLinkResolutionOpportunity(engine));
checks.push(await checkSearchMode(engine));
for (const c of checks) console.log(JSON.stringify({ name: c.name, status: c.status, message: c.message, details: c.details ?? null }));
const r = computeDoctorReport(checks);
console.log(JSON.stringify({ status: r.status, health_score: r.health_score, unknown_scores: r.unknown_scores ?? null, unknown_count: r.unknown_count ?? null }));
