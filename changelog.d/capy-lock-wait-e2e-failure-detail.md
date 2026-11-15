**When the lock-wait sync test fails, it now says why a page failed to publish.** It didn't change what it checks.

### Tests

- `test/e2e/persistence-preparation-lock-wait-postgres.test.ts`: when the drain doesn't end `synced`, the test prints every page that didn't commit. For a page that failed with `storage_error`, that printout carried only the generic public message, so a CI failure (one page, `storage_error`, while the test held its lock) couldn't be traced: it passed 44 of 44 times locally, 24 of them with four copies running at once. The printout now includes each page's recorded failure detail (the error class, the database error text, the statement and the source frame), so the next failure names its cause.
