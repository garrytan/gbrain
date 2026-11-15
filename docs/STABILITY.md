# Stability: which gbrain you get and how it changes

gbrain ships new releases many times a day. Most people should not run every one of them, and by default they don't: a normal install follows the **stable channel**, which only moves to a release after it has passed extra testing. This page says what that means in practice and how to choose something slower or faster.

## What the default install gives you

The install command in the README, `bun install -g github:garrytan/gbrain#stable`, installs the current stable release. `git clone --branch stable` does the same. A new brain created by `gbrain init` (no earlier config file) is set to the stable channel, and an install with no channel set follows stable too. Every update path follows the channel in effect: the update notice, `gbrain check-update`, `gbrain upgrade`, `gbrain self-upgrade` and the opt-in automatic upgrades.

Check which channel you are on with `gbrain doctor`, which prints `channel=<channel>` when one is set.

## How a release becomes stable

1. **Every release passes the full test suite first.** A release is published only after the full unit and end-to-end test runs pass on its exact code.
2. **A stable candidate then passes a production-shaped test.** gbrain runs a two-hour load test on a brain of 600,000 pages, at two network delays (2 ms and 65 ms), with privacy probes. It must pass the privacy-leak, read-error, version-skew, process-health and session checks in every run. The test has to have run on the release's exact files; a test of a nearby commit doesn't count.
3. **Stable moves only for a reason.** A scheduled check runs twice a day (05:17 and 13:17 UTC). It promotes the newest release that passed step 2, and only when there is a reason to move:
   - an important fix (a security, regression or data-loss fix, or a fix for something that blocks people) has been released but is not in stable yet, or
   - stable is more than 7 days old and a newer release exists.

   With no reason, stable stays where it is.
4. **The record is public.** Each promotion writes `stable.json` on the `stable-record` branch (version, commit, the test run that qualified it, and any withdrawn releases) and a permanent `stable-v<version>` tag. Your gbrain reads that file and refuses an update whose record is missing or incomplete; it never falls back to a non-stable release.

## How often stable moves

The scheduled check can move it at most twice a day; a maintainer can also promote, or roll back, by hand. An important fix can move it on any day. If nothing important is waiting, the 7-day rule is the next reason for stable to move, though it still waits for a release that passed the test in step 2.

What that has meant so far: the first stable release was v0.60.474.0 on 28 October 2026. Between then and 15 November 2026 stable moved 9 more times: once on 6 November, 9.7 days later, and then on each of the 8 days from 8 to 15 November, because an important fix was waiting on each of those days. Each move carried every change released since the one before. To see the current pace, list every stable release:

```bash
git ls-remote --tags --refs https://github.com/garrytan/gbrain 'refs/tags/stable-v*'
```

## Staying on stable

Do nothing; it is the default. To set it explicitly, or to come back to it from the fast channel:

```bash
gbrain config set self_upgrade.channel stable
gbrain upgrade --dry-run --json   # what an upgrade would install, installing nothing
```

gbrain never downgrades you by itself. If you ran ahead on the fast channel and switch back, you stay on your release until stable passes it. The one exception is a release that was withdrawn (listed as `known_bad` in the stable record): an install on it is offered the current stable release, even when that is older.

Updates are not applied by themselves unless you opt in. The default `self_upgrade.mode` is `notify`: you are told an update exists and nothing is installed without your say-so.

## Pinning a version

Install an exact release tag with this command. Its first line checks that the tag exists. Its second line removes any gbrain Bun already has installed, because installing one tag over another can leave the old version running and damage Bun's global package list. Its third line installs the tag:

```bash
git ls-remote --exit-code --tags https://github.com/garrytan/gbrain refs/tags/v<version> >/dev/null && \
  { ! bun pm ls -g 2>/dev/null | grep -q 'gbrain@' || bun remove -g gbrain; } && \
  bun add -g --backend=copyfile github:garrytan/gbrain#v<version>
```

Replace `<version>` with a release number, for example `0.60.722.0`. The second line skips the removal when Bun has no gbrain installed, so the same command works on a machine that never had gbrain.

A tag-pinned install stays on that release through `bun update`. `gbrain upgrade` is what moves it, so don't run it while you want to stay put. To stop update checks and update notices as well:

```bash
gbrain config set self_upgrade.mode off
```

## Going back to an earlier release

Nothing is rolled back for you. To return to an earlier release, reinstall its tag:

```bash
git ls-remote --exit-code --tags https://github.com/garrytan/gbrain refs/tags/v<previous> >/dev/null && \
  { ! bun pm ls -g 2>/dev/null | grep -q 'gbrain@' || bun remove -g gbrain; } && \
  bun add -g --backend=copyfile github:garrytan/gbrain#v<previous>
```

The first line checks that the tag exists before anything is removed. If an upgrade fails to start, `gbrain upgrade` prints the steps for your install type. A bun-link (git clone) install goes back with `git -C <clone> checkout <previous sha> && bun install`.

Know one limit before you go back. Upgrades can move your database to a newer schema, and an older gbrain will then refuse to set up that schema, with the code `client_behind`. Reads and ordinary commands on the older gbrain still work. The fix is to upgrade that copy again.

## Where changes that need your attention are announced

- **The upgrade notice.** After an upgrade, the first command (or the first tool result an agent gets) shows a one-time `behavior_changes` notice. It lists each behaviour change in the releases you skipped over, in plain sentences, often naming the setting that turns it off. Read it again at any time with `gbrain doctor --only behavior_changes`.
- **The changelog.** [CHANGELOG.md](../CHANGELOG.md) has an entry for every release.
- **The GitHub release.** When stable moves, its GitHub release becomes "Latest" and its notes list every changelog entry since the previous stable release. While this rule is new, Latest can still point at a newer release that is not stable; that ends the first time stable passes it.

## What the fast builds are for

Every release is also published on the **alpha** channel, as a GitHub pre-release. Alpha is for people who want each fix the hour it lands, and its releases are the pool stable promotes from. Switch with `gbrain config set self_upgrade.channel alpha` (`latest` is accepted as another name for it), or try one upgrade without changing your setting with `gbrain upgrade --channel alpha`. The git tag that tracks alpha is called `latest-stable` for historical reasons. It is the alpha line, not the stable channel.

## More detail

- [Upgrades and auto-update](guides/upgrades-auto-update.md): channels, the stable record, automatic upgrades, restarts and recovery.
- [Releasing](RELEASING.md#daily-stable-check): the daily stable check and promotion rules, for maintainers.
