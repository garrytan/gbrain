#!/usr/bin/env bash
# Print the latest Expo SDK major version.
#
# Usage: latest-sdk.sh
#
# The `expo` package's major version IS the SDK version (expo@56.x -> SDK 56).
# Uses bun to run `npm view expo dist-tags --json` (so it honors the local npm
# registry / proxy / auth config rather than hardcoding registry.npmjs.org),
# JSON.parse the result, and take the major via the `semver` package (falling
# back to a numeric split if semver can't be resolved). Run via the skill's
# `bash *expo-skill-eval/scripts/*` rule so SDK detection stays prompt-free —
# the npm child runs under bun, not as its own Bash tool call.
set -euo pipefail

exec bun -e '
  let out;
  try {
    out = await Bun.$`npm view expo dist-tags --json`.text();
  } catch (e) {
    console.error("error: `npm view expo` failed: " + (e?.message ?? e));
    process.exit(1);
  }
  let latest;
  try {
    latest = JSON.parse(out)?.latest;
  } catch {
    console.error("error: could not JSON.parse `npm view` output");
    process.exit(1);
  }
  if (!latest) {
    console.error("error: no `latest` dist-tag for expo");
    process.exit(1);
  }
  let major;
  try {
    const semver = await import("semver");
    major = (semver.default ?? semver).major(latest);
  } catch {
    major = Number.parseInt(String(latest).split(".")[0], 10);
  }
  if (!Number.isInteger(major)) {
    console.error(`error: could not parse SDK major from "${latest}"`);
    process.exit(1);
  }
  console.log(major);
'
