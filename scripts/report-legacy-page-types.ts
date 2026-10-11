import { createEngine } from '../src/core/engine-factory.ts';
import { reportLegacyPageTypes } from '../src/core/pmbrain-adapters/legacy-page-type-report.ts';
const databaseUrl=process.argv.find(arg=>arg.startsWith('--database-url='))?.slice(15);
const databasePath=process.argv.find(arg=>arg.startsWith('--database-path='))?.slice(16);
const sourceId=process.argv.find(arg=>arg.startsWith('--source-id='))?.slice(12);
if(!!databaseUrl===!!databasePath)throw new Error('请明确提供一个 --database-url=Postgres地址 或 --database-path=PGLite副本目录。报告只读，沿用 PGLite 单 Owner 锁，不会停止正在使用的数据库。');
const options=databaseUrl?{engine:'postgres' as const,database_url:databaseUrl}:{engine:'pglite' as const,database_path:databasePath};
const engine=await createEngine(options);
await engine.connect(options);
try {
  await engine.executeRaw('SET default_transaction_read_only=true');
  process.stdout.write(JSON.stringify(await reportLegacyPageTypes(engine,sourceId),null,2)+'\n');
}finally{await engine.disconnect();}
