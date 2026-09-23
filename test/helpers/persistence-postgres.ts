import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { assertSafeE2eDatabaseUrl } from './db-guard.ts';

/** Permanent receipt IDs deliberately survive source deletion; use a fresh test brain. */
export async function isolatedPersistencePostgres(databaseUrl:string, connectionStyle:'instance'|'module'='instance'):Promise<{engine:PostgresEngine;close:()=>Promise<void>}> {
  assertSafeE2eDatabaseUrl(databaseUrl);
  const database=`gbrain_test_persistence_${randomUUID().replace(/-/g,'')}`;
  const admin=postgres(databaseUrl,{max:1,prepare:false});
  await admin.unsafe(`CREATE DATABASE ${database}`);
  const url=new URL(databaseUrl);url.pathname=`/${database}`;
  const engine=new PostgresEngine();
  const close=async()=>{await engine.disconnect();await admin.unsafe(`DROP DATABASE ${database} WITH (FORCE)`);await admin.end();};
  try {await engine.connect({database_url:url.toString(),poolSize:connectionStyle==='module'?undefined:4});await engine.initSchema();return{engine,close};}
  catch(error){await close();throw error;}
}
