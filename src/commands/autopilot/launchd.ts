import {
  autopilotLaunchdLabel,
  autopilotLaunchdLogPaths,
  type AutopilotJob,
} from '../../core/autopilot-paths.ts';

/** Generates the plist without requiring a loaded launchd service.
 *
 * Bash is launchd's local executable; the generated wrapper remains a script
 * argument and can live beside brain data on an external volume. The log
 * descriptor paths are local because launchd opens them before running Bash.
 *
 * ThrottleInterval=60 makes launchd back off after configuration exits.
 * WorkingDirectory must remain a spawn-safe host path, never the repo: if
 * the repo disappears, the wrapper still needs to run its self-disable guard.
 */
export function generateLaunchdPlist(wrapperPath: string, home: string, job?: AutopilotJob): string {
  const { logPath, errPath } = job
    ? autopilotLaunchdLogPaths(home, job.launchdLabel)
    : { logPath: `${home}/.gbrain/autopilot.log`, errPath: `${home}/.gbrain/autopilot.err` };
  const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${escapeXml(job?.launchdLabel ?? autopilotLaunchdLabel())}</string>
  <key>Program</key><string>/bin/bash</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string>
    <string>${escapeXml(wrapperPath)}</string>
  </array>
  <key>WorkingDirectory</key><string>${escapeXml(home)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>${escapeXml(logPath)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(errPath)}</string>
</dict>
</plist>`;
}
