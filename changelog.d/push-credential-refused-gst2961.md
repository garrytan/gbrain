**gbrain git commit-push stops and says so when the Git host refuses the push for the account git used, naming the credential helper that answered instead of retrying quietly.**

<!-- behavior-change: push_credential_refused_gst2961 -->

### Fixed
- A push the host refuses with "Repository not found" (HTTP 404) or HTTP 403 is now a credential fault: `gbrain git commit-push` exits 1 with `push_credential_refused` (not retryable) after one attempt, instead of exit 4 `push_unconfirmed`, which the post-commit hook, autopilot's git reconcile and agents read as transient while commits stayed local for hours. The message names the credential helpers git asked, in order, with the scope and config file of each, which one answered and its account login; the secret is never printed, logged or stored, and a helper's arguments or inline body are never shown.
- The refusal is recorded for the checkout until a push lands: doctor `git_convergence` warns about it at once (`credential_refused` in the root's details), put_page's `lastPushStatus` reads `needs_attention`, and the push log line says the push was refused rather than that the remote could not be reached. A dropped connection keeps `push_unconfirmed` and its retries.
