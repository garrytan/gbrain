# changelog.d

One file per PR: the PR's CHANGELOG entry, without a version heading. gstack
`/ship` writes it as `changelog.d/<branch-slug>.md`; nobody edits VERSION,
the package.json version or CHANGELOG.md in a PR.

```markdown
**What changed, in one sentence.**

### Fixed
- ...
```

Optional front matter marks the change important for the stable channel
(`important: security|regression|data-loss|blocker`), which makes the merge
lane open a release right after it lands the PR. Releases are PATCH only, so
a `bump:` line other than `patch` is refused (scripts/build-behavior-changes.ts).
A PR that changes behavior also names its behavior-changes.d row here
(`<!-- behavior-change: <id> -->`, see behavior-changes.d/README.md).

The release PR (`gstack-release-stamp open`) folds every fragment into one
`## [<version>]` section, deletes the fragments and writes the version
stamps. Format and rules: docs/RELEASING.md#releases-per-batch.
