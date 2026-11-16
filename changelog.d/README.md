# changelog.d

One file per PR: the PR's CHANGELOG entry, without a version heading. gstack
`/ship` writes it as `changelog.d/<branch-slug>.md`; nobody edits VERSION,
the package.json version or CHANGELOG.md in a PR. Every PR needs one, a
tests-only PR included: the release folds only fragments, so a change without
one is missing from the release notes, and a release with nothing to fold is
refused. The fragment's first bold line becomes that change's line at the top
of the GitHub release notes.

```markdown
**What changed, in one sentence.**

### Fixed
- ...
```

Optional front matter marks the change important for the stable channel
(`important: security|regression|data-loss`, where regression means a
regression in a release that is on stable), which makes the merge lane open a
release right after it lands the PR. Any other class is refused
(docs/RELEASING.md#daily-stable-check); a fix that only unblocks someone rides
the weekly cut. Releases are PATCH only, so
a `bump:` line other than `patch` is refused (scripts/build-behavior-changes.ts).
A PR that changes behavior also names its behavior-changes.d row here
(`<!-- behavior-change: <id> -->`, see behavior-changes.d/README.md).

The release PR (`gstack-release-stamp open`) folds every fragment into one
`## [<version>]` section, deletes the fragments and writes the version
stamps. Format and rules: docs/RELEASING.md#releases-per-batch.
