**docs/RELEASING.md now says how a pull request lands on master: as one commit titled with the pull request's title and number.**

### Changed

- docs/RELEASING.md, "Releases per batch", has a "How a PR lands" paragraph: each pull request, release pull requests included, lands as one squashed commit whose subject is its title followed by `(#<number>)`, with other authors credited by `Co-authored-by:` trailers, while branches keep bringing master in with merge commits and are never rebased.
- The contributor audit's offline fixture now includes a squashed `(#<number>)` commit next to its "Merge pull request" merges, so the audit's tests cover both commit shapes it reads.
