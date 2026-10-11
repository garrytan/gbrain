import type {BrainEngine} from '../engine.ts';

export const PMBRAIN_SCHEMA_VERSION_KEY='pmbrain.schema.version';
const upstreamVersions:Record<number,number>={131:150,132:206,133:214};
export async function readPmbrainSchemaVersion(engine:BrainEngine):Promise<number>{
  const value=await engine.getConfig(PMBRAIN_SCHEMA_VERSION_KEY);
  const legacy=await engine.getConfig('version');
  const n=parseInt(value ?? legacy ?? '1',10);
  if(!Number.isSafeInteger(n)||n<1)throw new Error('PMBrain schema version is invalid');
  if(!value&&n>133)throw new Error('Unclassified legacy schema version; use the full-engine compatibility import instead of treating GBrain numbers as PMBrain migrations');
  return n;
}
export async function preparePmbrainMigrationLedger(engine:BrainEngine,migrations:Array<{version:number;name:string}>,current:number):Promise<void>{
  await engine.executeRaw(`CREATE TABLE IF NOT EXISTS pmbrain_schema_migrations(
    namespace TEXT NOT NULL DEFAULT 'pmbrain',version INTEGER NOT NULL,name TEXT NOT NULL,
    upstream_version INTEGER,adopted_legacy BOOLEAN NOT NULL DEFAULT false,applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(namespace,version))`);
  if(await engine.getConfig(PMBRAIN_SCHEMA_VERSION_KEY))return;
  await engine.transaction(async tx=>{
    await tx.executeRaw(`INSERT INTO pmbrain_schema_migrations(namespace,version,name,upstream_version,adopted_legacy)
      SELECT 'pmbrain',m.version,m.name,m.upstream_version,true
      FROM unnest($1::int[],$2::text[],$3::int[]) AS m(version,name,upstream_version)
      ON CONFLICT(namespace,version) DO NOTHING`,[migrations.filter(m=>m.version<=current).map(m=>m.version),migrations.filter(m=>m.version<=current).map(m=>m.name),migrations.filter(m=>m.version<=current).map(m=>upstreamVersions[m.version]??null)]);
    await tx.setConfig(PMBRAIN_SCHEMA_VERSION_KEY,String(current));
  });
}
export async function recordPmbrainMigration(engine:BrainEngine,migration:{version:number;name:string},adopted=false):Promise<void>{
  await engine.executeRaw(`INSERT INTO pmbrain_schema_migrations(namespace,version,name,upstream_version,adopted_legacy)
    VALUES('pmbrain',$1,$2,$3,$4) ON CONFLICT(namespace,version) DO NOTHING`,[migration.version,migration.name,upstreamVersions[migration.version] ?? null,adopted]);
}
