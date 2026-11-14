---
important: security
---

**Three ways a commit could reach the remote past the push secret scan are closed, and the scan can no longer be skipped.** In a managed root that sits in a subfolder of its repository, a commit could change that root's own `.gbrain-scan-allow` (for example to allow every path) and be pushed along with the secret it hid; it is now held for review like one at the top level. A strict (`canonical: git`) source's commit is now trusted only when its files are exactly what gbrain wrote, so anything a Git clean filter added is scanned. Git replace refs can no longer slip files into a page-write commit the scan trusts. `commitAndPush` also lost its unscanned mode, so no caller and no push handed over from a busy publish lock can publish without the scan; it reads only the commits the remote lacks, fetching a missing remote-tracking branch first.

<!-- behavior-change: managed_push_scan_every_publish_gst2650 -->

### Fixed
- In a managed root below its repository's top level, the allowlist's path globs match paths relative to that root.
- A strict-source commit made before this release that is still unpushed is scanned once when it is pushed.
- A page-write commit whose staged file another process reset at the same moment is no longer reported as committed with the old content; the write fails and is retried.
- The shared-checkout guide says that an uncommitted `.gbrain-scan-allow` is honoured, because it is the user's own answer to the scan.
