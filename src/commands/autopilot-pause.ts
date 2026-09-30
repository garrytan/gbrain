/**
 * `gbrain autopilot pause [--reason <text>]` and `gbrain autopilot resume`:
 * the operator's own hold on this host's autopilot daemon and job workers.
 * Engine-free (a live PGLite daemon holds the database lock). The pause is
 * its own marker, so `gbrain upgrade` and `gbrain autopilot --install` keep it,
 * and resume clears only it — never a migration or backup-restore hold.
 */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { hostname } from 'os';
import { autopilotOperatorPauseMarkerPath, autopilotPausedMarkerPath } from '../core/autopilot-paths.ts';

function read(path: string): string | null {
  try { return readFileSync(path, 'utf-8').trim(); } catch { return null; }
}

export function runAutopilotPauseCommand(args: string[]): void {
  const json = args.includes('--json');
  const operator = autopilotOperatorPauseMarkerPath();
  const at = args.indexOf('--reason');
  const reason = at >= 0 ? args[at + 1] : undefined;
  if (at >= 0 && (!reason || reason.startsWith('--'))) { console.error('--reason requires a value.'); process.exit(2); }
  let action: string;
  if (args.includes('--pause')) {
    const existing = read(operator);
    if (existing === null || reason !== undefined) {
      mkdirSync(dirname(operator), { recursive: true });
      writeFileSync(operator, `operator pause since ${new Date().toISOString()} on ${hostname()}: ${reason ?? 'no reason given'}\n`, { mode: 0o600 });
    }
    action = existing === null ? 'paused' : 'already_paused';
  } else {
    try { unlinkSync(operator); action = 'resumed'; } catch { action = 'not_paused'; }
  }
  const operatorPause = read(operator);
  const hold = read(autopilotPausedMarkerPath());
  if (json) {
    console.log(JSON.stringify({ action, operator_pause: operatorPause, other_hold: hold, paused: operatorPause !== null || hold !== null }));
    return;
  }
  if (action === 'paused' || action === 'already_paused') {
    console.log(`Autopilot ${action === 'paused' ? 'paused' : 'is already paused'} on this host: ${operatorPause}`);
    console.log('The daemon skips cycles and workers stop claiming jobs at their next poll; an in-flight job finishes.');
    console.log('`gbrain upgrade` and `gbrain autopilot --install` keep this pause. Resume with: gbrain autopilot resume');
  } else {
    console.log(action === 'resumed' ? 'Operator pause cleared; autopilot resumes at its next poll.' : 'No operator pause was set on this host.');
  }
  if (hold !== null) console.log(`Another hold is still present and was not touched (it clears when its operation finishes): ${hold}`);
}
