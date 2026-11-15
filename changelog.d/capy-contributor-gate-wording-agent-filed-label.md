**Outside contributors now get an accurate picture of what happens to their pull requests, and issues our own automation files are labelled so community reports are easy to find.** The comment posted on an outside pull request and the new "How an outside pull request is handled" section of CONTRIBUTING.md describe what really happens: docs-only changes can be merged as they are after a read, small plainly correct fixes are rebuilt with credit to the author, every PR lands as one squashed commit with outside authors credited by a `Co-authored-by:` trailer, and the three-open-PR limit never applies to anyone who had a PR taken in the last 90 days. Every issue the repo's scripts and CI open now carries the `agent-filed` label, and the new-issue page links to a "Community issues" search that leaves those out.

### Itemized changes

- `scripts/fix-wave-gate.ts`, `scripts/fix-wave-closeout.ts`: the gate and close-out comments describe the current rules and link to the new CONTRIBUTING section.
- `scripts/lib/gh-issue.ts`: `createIssue` always adds `agent-filed`; `scripts/upgrade-matrix.ts` and `scripts/lib/master-red.ts` keep it on every issue they open.
- `.github/ISSUE_TEMPLATE/config.yml`: a "Community issues" contact link.
- Docs: CONTRIBUTING.md, README.md, docs/RELEASING.md and the CI key-files page.
- Tests: new `test/scripts/gh-issue-agent-filed.test.ts`; the nightly-issue, fix-wave-gate and fix-wave-closeout tests updated.
