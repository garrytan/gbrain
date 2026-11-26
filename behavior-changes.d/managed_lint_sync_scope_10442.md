---
kind: fix
---
On a managed brain, the cycle's lint phase and the lint and lint-fix jobs now check only the files managed sync imports, judged by each file's path in its registered source and that source's sync strategy: plain README-style folder guides, skills/ bundles, skillpack.json and paths matched by sync.exclude are skipped, so their page-format findings no longer turn the lint phase to warn. A typed nested README is still checked, linting one named file still checks that file, and unmanaged brains are unchanged.
