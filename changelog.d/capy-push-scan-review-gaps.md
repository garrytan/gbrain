---
important: security
---

**A managed worktree now scans every push for secrets, including the pushes that used to skip the scan.** The generated-page commits the dream cycle writes through, and a push handed over from a busy publish lock, went out to the remote without the secret scan. Now every push a managed worktree makes is scanned, and only the commits the remote does not already have are read; when the remote-tracking branch is missing, gbrain fetches it first instead of scanning the whole history. A credential found in an unpushed commit holds the push with `publish_secret_found`, which names the file, line and rule but never the value.

<!-- behavior-change: managed_push_scan_every_publish_gst2650 -->

### Fixed
- In a managed root that sits in a subfolder of its repository, a commit that changes that root's own `.gbrain-scan-allow` is now held for review like one at the top level, and the allowlist's path globs match paths relative to that root.
- A strict (`canonical: git`) source's commit is trusted only when its files are exactly what gbrain wrote. When a Git clean filter changed them, the commit is scanned; it is still pushed if the scan finds nothing.
- Git replace refs no longer change what a page-write commit holds.
- A page-write commit whose staged file another process reset at the same moment is no longer reported as committed with the old content; the write fails and is retried.
- The shared-checkout guide says that an uncommitted `.gbrain-scan-allow` is honoured, because it is the user's own answer to the scan.
