**GitHub's "Latest" release is now the stable release, with notes covering everything since the previous stable; every batch release is published as a pre-release.** Installs and `gbrain upgrade` already followed the stable tag, so nothing changes for anyone on the documented install. The Releases page and its Latest badge now show that same release, about once a day, instead of every batch release. Anyone who downloads from `releases/latest` by hand now gets the stable release. People watching the repository for releases are still notified of pre-releases, because GitHub has no setting to skip them.

### Changed
- `.github/workflows/release.yml` publishes each release with `prerelease: true` and `make_latest: false`.
- `scripts/promote-stable.ts` ends every promotion by marking the release Latest. A forward promotion also replaces its notes with every CHANGELOG entry since the previous stable; the oldest entries drop, with a link, past GitHub's size limit.
- Alpha binary self-update reads `VERSION` at the `latest-stable` tag and downloads that exact release instead of `releases/latest`.
- The upgrade matrix counts pre-releases as releases.
- The macOS 26 signature check takes its tag from `latest-stable`.

### Added
- `scripts/release-channel.ts` has three commands. `backfill` brings releases published before this change in line. `undo` takes the rule back out. `preview-promotion` shows what a promotion would write. `backfill` and `undo` only print their plan unless given `--apply`.
- Docs: docs/RELEASING.md, "Which release GitHub calls Latest".
