import postgres from '#postgres'
import { randomUUID } from 'node:crypto';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { assertSafeE2eDatabaseUrl } from './db-guard.ts';

/**
 * Permanent receipt IDs deliberately survive source deletion; use a fresh test brain.
 * `collation: 'C'` creates it with code-point text order (LC_COLLATE 'C') whatever the server's default collation is;
 * `collation: 'en_US'` creates it with the en_US.utf8 locale (see createEnUsDatabase).
 */
export async function isolatedPersistencePostgres(databaseUrl:string, connectionStyle:'instance'|'module'='instance', poolSize=4, opts:{collation?:'C'|'en_US'|'icu-en-US'}={}):Promise<{engine:PostgresEngine;databaseUrl:string;close:()=>Promise<void>}> {
  assertSafeE2eDatabaseUrl(databaseUrl);
  const database=`gbrain_test_persistence_${randomUUID().replace(/-/g,'')}`;
  const admin=postgres(databaseUrl,{max:1,prepare:false});
  if (opts.collation==='en_US') await createEnUsDatabase(admin, database);
  else await admin.unsafe(opts.collation==='C' ? `CREATE DATABASE ${database} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C'`
    // An ICU-default brain (PostgreSQL 15+): text sorts in the en-US locale, not byte order.
    : opts.collation==='icu-en-US' ? `CREATE DATABASE ${database} TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER icu ICU_LOCALE 'en-US' LOCALE 'C.UTF-8'`
    : `CREATE DATABASE ${database}`);
  const url=new URL(databaseUrl);url.pathname=`/${database}`;
  const engine=new PostgresEngine();
  const close=async()=>{await engine.disconnect();await admin.unsafe(`DROP DATABASE ${database} WITH (FORCE)`);await admin.end();};
  try {await engine.connect({database_url:url.toString(),poolSize:connectionStyle==='module'?undefined:poolSize});await engine.initSchema();return{engine,databaseUrl:url.toString(),close};}
  catch(error){await close();throw error;}
}

/**
 * Creates `database` from template0 with the en_US.utf8 locale. The parity harness's Postgres arm uses it, so a text
 * ORDER BY without COLLATE "C" sorts by the locale (which skips punctuation) on every server, not by the server's
 * default collation, which is C.UTF-8 on some local clusters. A server without the locale fails with one line;
 * there is no fall back to C.
 */
export async function createEnUsDatabase(admin:{unsafe:(sql:string)=>Promise<unknown>}, database:string):Promise<void> {
  try {
    await admin.unsafe(`CREATE DATABASE ${database} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'en_US.utf8' LC_CTYPE 'en_US.utf8'`);
  } catch (error) {
    if (/invalid LC_(COLLATE|CTYPE) locale name/i.test(String((error as Error)?.message))) {
      throw new Error(`[parity] the Postgres server at DATABASE_URL has no en_US.utf8 locale; the parity harness needs it (install it with localedef -i en_US -f UTF-8 en_US.UTF-8 and restart the server): ${(error as Error).message}`);
    }
    throw error;
  }
}

/** A fresh database in `encoding` with the C locale, no schema applied; `close` drops it. */
export async function encodedPostgres(databaseUrl:string, encoding:'UTF8'|'SQL_ASCII'|'LATIN1'):Promise<{engine:PostgresEngine;close:()=>Promise<void>}> {
  assertSafeE2eDatabaseUrl(databaseUrl);
  const database=`gbrain_test_encoding_${encoding.toLowerCase()}_${randomUUID().replace(/-/g,'')}`;
  const admin=postgres(databaseUrl,{max:1,prepare:false});
  await admin.unsafe(`CREATE DATABASE ${database} TEMPLATE template0 ENCODING '${encoding}' LC_COLLATE 'C' LC_CTYPE 'C'`);
  const url=new URL(databaseUrl);url.pathname=`/${database}`;
  const engine=new PostgresEngine();
  const close=async()=>{await engine.disconnect();await admin.unsafe(`DROP DATABASE ${database} WITH (FORCE)`);await admin.end();};
  try {await engine.connect({database_url:url.toString(),poolSize:4});return{engine,close};}
  catch(error){await close();throw error;}
}

/**
 * One migrated template per test file: each clone (CREATE DATABASE ... TEMPLATE) is its own fresh brain,
 * so permanent receipt IDs never cross tests, without re-running every migration per test.
 */
export async function persistencePostgresTemplate(databaseUrl:string, poolSize=4, prepare?:(engine:PostgresEngine)=>Promise<void>):Promise<{clone:()=>Promise<{engine:PostgresEngine;close:()=>Promise<void>}>;dispose:()=>Promise<void>}> {
  const template=await isolatedPersistencePostgres(databaseUrl);
  try { await prepare?.(template.engine); } catch (error) { await template.close(); throw error; }
  await template.engine.disconnect();
  const name=new URL(template.databaseUrl).pathname.slice(1);
  const admin=postgres(databaseUrl,{max:1,prepare:false});
  let clones=0;
  return {
    clone:async()=>{
      const database=`${name}_${clones++}`;
      await admin.unsafe(`CREATE DATABASE ${database} TEMPLATE ${name}`);
      const url=new URL(databaseUrl);url.pathname=`/${database}`;
      const engine=new PostgresEngine();
      const close=async()=>{await engine.disconnect();await admin.unsafe(`DROP DATABASE ${database} WITH (FORCE)`);};
      try {await engine.connect({database_url:url.toString(),poolSize});return{engine,close};}
      catch(error){await close();throw error;}
    },
    dispose:async()=>{await admin.end();await template.close();},
  };
}
