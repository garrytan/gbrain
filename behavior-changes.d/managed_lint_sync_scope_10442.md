---
kind: fix
---
On a managed brain, gbrain lint on a directory, and the cycle's lint phase, now check only the files managed sync imports: plain README-style folder guides, skills/ bundles, skillpack.json and paths matched by sync.exclude are skipped, so their page-format findings no longer turn the lint phase to warn. A typed nested README is still checked, linting one named file still checks that file, and unmanaged brains are unchanged.
