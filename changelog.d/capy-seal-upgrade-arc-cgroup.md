**The bun-link upgrade test no longer fails on CI runners whose own systemd unit shows up in its process scan.**

### For contributors
- `test/upgrade-bun-link-arc.serial.test.ts` sets `GBRAIN_TEST_UPGRADE_CGROUP` to a cgroup with no systemd unit, so the restart preflight's unit lookup for another brain's `gbrain serve --http` never records a `systemctl show` call. A probe test proves a cgroup naming a unit reproduces the runner failure. With the variable unset, `gbrain upgrade` reads `/proc/<pid>/cgroup` as before, and a `.env` in the working folder cannot set it.
