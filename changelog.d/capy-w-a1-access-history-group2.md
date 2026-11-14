**The first import of a folder's access rules no longer fails on a shallow checkout that has no committed rule history, `gbrain access rule migrate` moves rules between git and the database, renamed pages keep their atom lineage, connection strings lose their password whatever the scheme, and a policy-only mirror no longer trips the git convergence check.** Community wave W-A1, second part: bug reports verified on master and fixed with our own code.

### Fixed
- **First access-rule import (GST-2638).** The first import of a source's access rules refused when it could not read their git history. It now tells a missing history apart from an unreadable one. An unreadable history refuses with the new code `access_policy_history_unreadable`, and the fix it names is `git -C <source root> fetch --unshallow` and then the same command again. A plain sync on a shallow checkout whose rules do have committed history still fails closed. `gbrain access rule migrate --to git|database` moves the rules from one store to the other, the preview shows when only the owner can read pending pages, and the command exits 1 when the result would be invalid.
- **Policy-only mirrors (GST-2634).** `gbrain doctor`'s git_convergence check no longer flags a source whose mirror holds only access policy.
- **Ingest refusals (#8982).** A refused `POST /ingest` now carries a code, a fix and a docs link.
- **Renamed pages, config secrets and root metadata deletes (#8920).** Atom origin lookups also follow slug renames. Config secret keys are redacted, and the password in a connection URL is removed for any scheme. Deleting a root metadata file publishes the change to the database only.

<!-- behavior-change: access_first_import_history_gst2638 -->
