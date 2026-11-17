**Contributors: the pre-merge check now accepts changes to the macOS helper's files under `apple/helper/`, which build and test only in their own macOS workflow.**

### Changed
- `.gstack/pregate.json` lists `apple/helper/**` as having no local test run, the same way `scripts/bench/**` is listed. The helper's Swift tests run on every change to `apple/**` in the `Apple helper` workflow. Nothing changes for gbrain users. (#9627)
