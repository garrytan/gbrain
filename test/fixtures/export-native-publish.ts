import { ExportStage } from '../../src/core/export-stage.ts';
import { publishExport } from '../../src/core/export-publish.ts';

const destination = process.argv[2];
if (!destination) throw new Error('A synthetic destination is required');
const stage = new ExportStage();
try {
  stage.add('first.md', 'file', 'Synthetic first page\n');
  stage.add('nested/second.md', 'file', 'Synthetic second page\n');
  await publishExport(stage, destination, () => {
    if (process.argv[3] === 'kill') {
      console.log('EXPORT_FIXTURE_KILLING');
      process.kill(process.pid, 'SIGKILL');
    }
  });
  console.log('EXPORT_FIXTURE_COMPLETE');
} finally { stage.close(); }
