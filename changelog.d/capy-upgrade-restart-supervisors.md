**Self-upgrade restarts finish under containers, your own supervisors and a second brain on the same host, and never leave autopilot dead.**

<!-- behavior-change: upgrade_restart_supervisors_8840 -->

### Fixed
- An autopilot that nothing relaunches (the ephemeral-container start script runs it once at container boot, or it was started by hand) exited after a self-upgrade swap and stayed down until the container restarted. It now starts itself again. A detached shell waits for the old process to exit (also when its parent never reaps it) and runs the same command line, which takes the autopilot lock. Under launchd, systemd, this brain's gbrain cron line or a declared `self_upgrade.autopilot_launcher` it still exits for that supervisor, and if no relaunch can be set up it keeps running its old build instead of exiting. (#8840, reported by @cupit01)
- On macOS, `gbrain upgrade` counted every gbrain process on the host as this brain's, because it could not read a process's `GBRAIN_HOME` there, so another brain's `gbrain serve` made every restart refuse. It now reads `GBRAIN_HOME` (else `HOME`) from `ps -E`, as Linux reads `/proc`, and leaves other brains' processes alone. (#9725, reported by @JRUHF77)
- A serve run by a systemd unit you named yourself, or by a container's process manager, refused every upgrade with `restart_refused` and no exact command. The refusal now names `systemctl --user restart <unit>` for the unit the serve runs in (found from its cgroup, any name, whatever `HOME` the upgrade runs with), else the command line serve was started with. (#9483, reported by @coolmanns and @exGeni)

### Added
- `gbrain config set self_upgrade.serve_launcher external` tells upgrades that something outside gbrain's serve service runs serve: `gbrain upgrade` and the autopilot's post-upgrade serve restart then run that systemd unit's restart command, or stop serve (only one whose environment shows this brain's home) and wait up to 6 minutes for your supervisor to start the new build, naming serve's command line if it does not come back. Unset, upgrades never restart that serve themselves.
