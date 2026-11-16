# Stability: which gbrain you get and how it changes

gbrain ships new releases many times a day. Most people should not run every one of them, and by default they don't: a normal install follows the **stable channel**, which only moves to a release after it has passed extra testing. This page says what that means in practice and how to choose something slower or faster.

## What the default install gives you

The install command in the README, `bun install -g github:garrytan/gbrain#stable`, installs the current stable release. `git clone --branch stable` does the same. A new brain created by `gbrain init` (no earlier config file) is set to the stable channel, and an install with no channel set follows stable too. Every update path follows the channel in effect: the update notice, `gbrain check-update`, `gbrain upgrade`, `gbrain self-upgrade` and the opt-in automatic upgrades.

Check which channel you are on with `gbrain doctor`, which prints `channel=<channel>` when one is set.

## What stays the same on stable

Since 16 November 2026, stable comes with a written promise about what a script or an agent built on gbrain can rely on.

**What it covers:**

- Command names and their documented flags (the ones `gbrain <command> --help` and these docs describe).
- MCP tool names and their parameters.
- Documented config keys (`gbrain config set <key>`).
- The page file and frontmatter format.
- Exit codes and the top-level fields of `--json` output for documented commands.
- Upgrading a brain from any stable release of the last six months. The channel started on 28 October 2026, so today that means every stable release.

**How those things may change.** A removal or a rename is announced first, in a stable release: in the one-time upgrade notice and in the release notes. The old name or behaviour keeps working, with a warning that names the new one. It is removed no sooner than 14 days and two stable releases after that announcement. A change that makes a command or tool refuse something it used to accept counts as a break under this rule too.

**The one exception: security and data-loss fixes.** A fix for a security hole or for something that loses data may change behaviour at once. Its upgrade notice says which of the two it is and what you need to do. It may leave out how the problem worked until the fix has had time to reach people.

**What it does not cover:**

- Wording of messages meant for people (not `--json`), and undocumented or internal flags.
- The alpha channel. Its releases can change anything between one build and the next.
- Search ranking, speed and the exact results of model-backed features.
- Very large brains during an upgrade. The upgrade tests build small brains, on PGLite and on Postgres, with and without a git repository. The two-hour load test runs a 600,000-page brain on the new release but does not upgrade one. Until [#9192](https://github.com/garrytan/gbrain/issues/9192) is fixed, a large brain on a remote Postgres database can return no search results for hours after an upgrade while it catches up.

**How it is checked.** Every pull request runs a check (`bun run check:public-surface`) against a list of the commands, MCP tools and their parameters, config keys and exit codes, built from the code into [docs/contracts/public-surface.json](contracts/public-surface.json). The list has the flags of every command defined as an operation, and of the 8 CLI-only commands (out of 132) that have a curated help record; the flags of the other 124, `recall` and `forget` among them, are checked in review. The check refuses a pull request that:

- drops one of them, or changes an exit code, before a [deprecations.d/](../deprecations.d/README.md) record for it has reached its `remove_after` date, unless the pull request adds a behaviour-change row marked `exception: security` or `exception: data-loss`;
- adds a deprecation record whose date is less than 14 days away, or changes what a merged record names, or moves its date earlier;
- adds a behaviour-change row that doesn't say what kind of change it is, or marks a change `breaking` when it is neither a security or data-loss fix nor the removal of a deprecation whose date has passed;
- changes the recorded output of the CLI or of agent errors with no behaviour-change row.

What never reached stable isn't covered. The check compares with the list at the current stable release (the `stable` tag), so something added since then can be removed with no record. When the clone lacks the tag, the check fetches it from GitHub. In CI a fetch that fails or takes more than 20 seconds fails the check and asks for a rerun, so a missing tag never waives the rule; a local run without the tag says so and counts everything as on stable. Until a stable release carries the list, the check says so and counts everything as on stable; a revert then marks its behaviour-change row `exception: revert` and names the pull request it reverts.

The rest is checked when the pull request is reviewed: `--json` fields, the page format, wording, what a command does beyond its name, and the part of the deprecation rule that asks for two stable releases. If a stable release breaks one of these rules anyway, that is a regression, and it is handled like any other: fixed, with the fix sent to stable as an important fix.

## How a release becomes stable

1. **Every release passes the full test suite first.** A release is published only after the full unit and end-to-end test runs pass on its exact code.
2. **A stable candidate then passes a production-shaped test.** gbrain runs a two-hour load test on a brain of 600,000 pages, at two network delays (2 ms and 65 ms), with privacy probes. It must pass the privacy-leak, read-error, version-skew, process-health and session checks in every run. The test has to have run on the release's exact files; a test of a nearby commit doesn't count.
3. **Stable moves only for a reason.** A scheduled check runs twice a day (05:17 and 13:17 UTC). It promotes the newest release that passed step 2, and only when there is a reason to move:
   - an important fix (a security fix, a data-loss fix, or a fix for a regression in a release that is on stable) has been released but is not in stable yet, or
   - stable is more than 7 days old and a newer release exists.

   With no reason, stable stays where it is.
4. **The record is public.** Each promotion writes `stable.json` on the `stable-record` branch (version, commit, the test run that qualified it, and any withdrawn releases) and a permanent `stable-v<version>` tag. Your gbrain reads that file and refuses an update whose record is missing or incomplete; it never falls back to a non-stable release.

## How often stable moves

The rule: an important fix reaches stable within a day once it has passed the full test suite and the load test in step 2; everything else rides a weekly move; and stable never sits more than seven days behind tested changes. The scheduled check can move it at most twice a day; a maintainer can also promote, or roll back, by hand. If nothing important is waiting, the 7-day rule is the next reason for stable to move, though it still waits for a release that passed the test in step 2. A fix for a problem only newer, non-stable releases have, or one that unblocks a single setup, waits for the weekly move; if you need it sooner, install that release by its tag (see "Pinning a version").

What that has meant so far: the first stable release was v0.60.474.0 on 28 October 2026. Between then and 15 November 2026 stable moved 9 more times: once on 6 November, 9.7 days later, and then on each of the 8 days from 8 to 15 November, because an important fix was waiting on each of those days. Each move carried every change released since the one before. Until then an important fix also included a fix for something that blocked people. From the release that carries this change on (decided 16 November 2026), only security, data-loss and stable-regression fixes move stable early, so expect it to move about once a week. To see the current pace, list every stable release:

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
- **The upgrade summary.** Once the new version is installed, `gbrain upgrade` prints a short summary of the behaviour changes since the version you had, before its migrations run: the ones that need you first, then changed defaults, then a count of fixes and additions. Changes from before each one was given a kind are counted as not classified yet.
- **The changelog.** [CHANGELOG.md](../CHANGELOG.md) has an entry for every release.
- **The GitHub release.** When stable moves, its GitHub release becomes "Latest" and its notes open with the same short summary of behaviour changes since the previous stable release, then list every changelog entry since it. While this rule is new, Latest can still point at a newer release that is not stable; that ends the first time stable passes it.

## What the fast builds are for

Every release is also published on the **alpha** channel, as a GitHub pre-release. Alpha is for people who want each fix the hour it lands, and its releases are the pool stable promotes from. Switch with `gbrain config set self_upgrade.channel alpha` (`latest` is accepted as another name for it), or try one upgrade without changing your setting with `gbrain upgrade --channel alpha`. The git tag that tracks alpha is called `latest-stable` for historical reasons. It is the alpha line, not the stable channel.

## More detail

- [Upgrades and auto-update](guides/upgrades-auto-update.md): channels, the stable record, automatic upgrades, restarts and recovery.
- [Releasing](RELEASING.md#daily-stable-check): the daily stable check and promotion rules, for maintainers.
