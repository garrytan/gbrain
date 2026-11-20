// Preload fault injector for PGlite.query/exec.
// INJECT_LOG=file : append one line per query "<n>\t<hash>\t<sql head>"
// INJECT_HASH=h   : throw on every query whose normalized SQL hash == h
// INJECT_SQL=re   : throw on queries matching regex
import { PGlite } from "/code/garrytan/gbrain/node_modules/@electric-sql/pglite/dist/index.js";
import { appendFileSync } from "fs";
import { createHash } from "crypto";
const re = process.env.INJECT_SQL ? new RegExp(process.env.INJECT_SQL, "s") : null;
const target = process.env.INJECT_HASH || null;
const logf = process.env.INJECT_LOG || null;
const msg = process.env.INJECT_MSG || 'permission denied for table injected_audit';
let n = 0; let fired = 0;
const norm = (s: string) => s.replace(/\$\d+/g, '$').replace(/\s+/g, ' ').trim();
function check(sql: unknown) {
  if (typeof sql !== 'string') return;
  n++;
  const h = createHash('sha1').update(norm(sql)).digest('hex').slice(0, 10);
  if (logf) appendFileSync(logf, `${n}\t${h}\t${norm(sql).slice(0, 160)}\n`);
  if ((target && h === target) || (re && re.test(sql))) {
    fired++;
    if (process.env.INJECT_FIREDLOG) appendFileSync(process.env.INJECT_FIREDLOG, `fired ${h}\n`);
    const e: any = new Error(msg); e.code = process.env.INJECT_CODE || '42501'; throw e;
  }
}
for (const m of ["query", "exec"] as const) {
  const orig = (PGlite.prototype as any)[m];
  (PGlite.prototype as any)[m] = async function (sql: any, ...rest: any[]) { check(sql); return orig.call(this, sql, ...rest); };
}
const origTx = (PGlite.prototype as any).transaction;
(PGlite.prototype as any).transaction = function (cb: any, ...rest: any[]) {
  return origTx.call(this, async (tx: any) => {
    for (const m of ["query", "exec"]) { const o = tx[m]; if (typeof o === 'function') tx[m] = async (sql: any, ...r: any[]) => { check(sql); return o.call(tx, sql, ...r); }; }
    return cb(tx);
  }, ...rest);
};
