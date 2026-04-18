import type { BrainEngine } from '../core/engine.ts';
import {
  buildDoctorReport,
  collectDoctorInputs,
  doctorExitCode,
  formatDoctorReport,
} from '../core/services/doctor-service.ts';

export async function runDoctor(engine: BrainEngine, args: string[]) {
  const jsonOutput = args.includes('--json');
  const report = buildDoctorReport(await collectDoctorInputs(engine));

  if (jsonOutput) {
    console.log(JSON.stringify(report));
  } else {
    console.log(formatDoctorReport(report));
  }

  process.exit(doctorExitCode(report));
}
