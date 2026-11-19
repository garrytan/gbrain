**`gbrain sources refresh` no longer stops and asks for the user when a local commit lands while it publishes the checkout's earlier local commits.**

### Fixed
- On a managed brain whose refresh publishes local commits by itself (Git durability on, or `sources.refresh_publish_diverged` true), a commit made on the checkout after that publish and before the fast-forward ended the run with `refresh_diverged` and a fix that said to ask the user, although nothing was lost and the next refresh succeeded. The refresh now retries once from a fresh check in the same run, which publishes the new commit too. If that retry is refused as well, the refusal still says the first commits were already published.
