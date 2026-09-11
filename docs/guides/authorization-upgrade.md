# Authorization and worker upgrade

This upgrade adds owner approval for OAuth authorization-code connections and durable authorization
for queued work. It requires a coordinated worker cutover. Back up the database
and source repositories before applying migrations.

**Say to your agent:** *"Plan my GBrain upgrade, preserve my connections, and
show me which queued jobs need review before services restart."* Your agent
uses `gbrain jobs authorize-legacy` to preview selected work for review.

## Runtime and outbound requests

Use Bun **1.3.11 or newer**. CI covers 1.3.11 and the build runtime, 1.3.13.
Compiled distributions include their Bun runtime.

URL reachability checks, HTTP integration checks, and remote image loading use
direct connections to validated destinations. If they return
`PROXY_NOT_SUPPORTED`, remove `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and their
lowercase variants from the service environment, then restart GBrain. A
`NO_PROXY` exception does not enable these requests. This requirement concerns
these guarded URL operations; configure provider connections separately.

Remote images have a 2 MiB decoded limit; local images retain the 10 MiB limit.
HTTP checks read response headers only. Redirects share the original deadline;
HTTPS cannot redirect to HTTP. Checks carrying configured headers, credentials,
or bodies stay on the original origin through redirects.

## Connecting an OAuth client

An authorization request opens the existing admin login and then an approval
page. Review the client, redirect destination, requested scopes, administrative
capabilities, and source before approving. The page preserves the pending
request through password or magic-link login. Authorization grants require
S256 PKCE for both public and confidential clients.

Pending requests expire after ten minutes and are held only in server memory.
After expiry, server restart, a policy change, or an uncertain approval result,
restart the connection from the client. Repeated clicks cannot produce another
code. At most 1,000 requests can be pending; retry when capacity is available.

Existing access tokens, refresh tokens, and unexpired authorization codes for
active clients remain valid. There is no session purge or retroactive approval
requirement. Review existing clients in **Admin → Agents**, narrow their grants
where appropriate, and revoke clients that should no longer connect. Revoking
a client invalidates its outstanding grants and prevents its queued work from
starting. Rotating or expiring an individual OAuth credential does not cancel
work already accepted for that client. Revoking or deleting a legacy bearer
token prevents work accepted under that token from starting.

## Generic remote background jobs

`submit_job` accepts four generic filesystem jobs for the authenticated source:

| Name | Caller `data` | Execution |
| --- | --- | --- |
| `sync` | Absent, empty, or boolean `pull` / legacy `noPull`; never both | Registered root, configured concurrency, no embedding, extraction, or embed backfill |
| `import` | Absent or empty | Registered root, authenticated source, no embedding |
| `lint` | Absent or empty | Inspect the registered root |
| `lint-fix` | Absent or empty | Fix files inside the registered root |

The source must be active, have a valid filesystem configuration (`kind` absent
or null), and have an existing registered directory. Connector and unknown
source kinds require their dedicated operations. A path, source override,
GitHub-item parameter, or unknown field is rejected.

Pull defaults on only for a source covering the entire Git worktree. Nested
sources default off and cannot explicitly enable pull. `sync` requires an
existing Git worktree; use `import` for an ordinary non-Git directory.

Generic background submission requires a durable authenticated principal.
Stdio agents should use the local CLI or a dedicated authorized operation.
Local application maintenance retains its existing job and budget restrictions.

`gbrain remote ping` previously submitted an `autopilot-cycle` job and now
receives the generic-job denial. Run the existing maintenance workflow on the
brain host, or use dedicated authorized operations such as `sync_brain` and
`connector_sync`. `gbrain remote doctor` remains available with its required
scope.

Execution rechecks the original authorization against current principal and
source policy. Revocation, narrowed permissions, incompatible bindings,
archiving, or a changed source root stops execution. Retry, replay, and
coalescing preserve the original authority. Cancel jobs through the existing
job controls when their work is no longer wanted.

Delegated tools exclude `file_list`, `file_url`, and every `localOnly` operation.
Update existing bindings referencing removed tools before resubmission. Remote
tool bindings must be nonempty. Internally, an explicit empty tool list means
no tools; only an absent trusted-local binding uses the default registry.

## Queue cutover

1. Pause HTTP ingress, schedules, producers, and automatic upgraders so no new
   work enters. Let active work drain, then stop supervisors, workers, reapers,
   and every other process sharing the database. Back up the stopped database,
   repositories, service configuration, and compatible application version.
   Keep services stopped throughout review and migration.
2. Install the same new application version everywhere without running
   post-upgrade helpers or package lifecycle scripts. For a **published binary**
   installation, use `gbrain upgrade --swap-only`. For a **Bun package**
   installation, replace `vX.Y.Z.W` below with the exact release being installed:

   ```sh
   bun install --global --ignore-scripts github:garrytan/gbrain#vX.Y.Z.W
   ```

   For a linked source checkout, update that checkout to the chosen release
   through its normal Git workflow, then run `bun install --ignore-scripts`.
   Do not use `gbrain upgrade --swap-only` for this source/package cutover: its
   underlying Bun installation can still run postinstall. Plain `gbrain upgrade`,
   `gbrain post-upgrade`, and `gbrain apply-migrations --yes` can run pending
   setup phases that start autopilot or perform other maintenance.

   Verify the installed version, then apply only schema migrations:

   ```sh
   gbrain --version
   gbrain apply-migrations --force-schema --yes
   ```

   `--force-schema` runs pending schema migrations and returns before setup
   orchestrators. It does not approve queued work or bypass the drain check.
   The nullable `submission_authority` column leaves historical rows untrusted.
   Protocol checks reject old producer inserts and worker claims. Do not run
   old workers, reapers, or supervisors against this queue. If active historical
   work blocks migration and the new CLI cannot inspect or cancel it, restore
   compatible pre-upgrade application and database state, resolve that work
   locally, and repeat the cutover.
3. Inspect outstanding jobs with local job controls. Preview only explicitly
   selected legacy rows whose `submission_authority` is **SQL NULL**:

   ```sh
   gbrain jobs authorize-legacy --ids 101,102 --json
   ```

   Review the payloads, schedules, attempts, and transitive dependency effects. The command
   does not authorize or mutate work without the apply flags.
   Non-NULL authority is never rewritten by this command, including future
   versions, malformed objects, and JSON `null`. Use matching application and
   database versions to interpret that work, or explicitly cancel it locally.
4. Apply exactly the reviewed snapshot digest:

   ```sh
   gbrain jobs authorize-legacy --ids 101,102 --expect <snapshot_digest> --yes --json
   ```

   A changed snapshot or dependency graph refuses approval; preview and review
   again. Only selected SQL-NULL rows receive application authority. IDs, schedules, attempts, and
   dependencies remain intact. Dependencies require their own explicit review.
5. Explicitly authorize or cancel every nonterminal legacy job before restarting
   services. Worker startup refuses unresolved work. Historical terminal rows
   remain unchanged; review them explicitly before a later local replay.
   Remote replay cannot authorize legacy rows.
6. Start the matching application, producers, and workers and inspect job
   diagnostics for bounded authorization denials. Resume normal post-upgrade
   setup and automatic-upgrade schedules only after the queue review is complete
   and every process uses the matching version.

For rollback, stop all services and restore compatible application and database
state together. An older worker must never run against the enforced queue.

For installations using automatic upgrades, pause the automatic upgrade
schedule before this cutover and keep it paused until every worker runs the
matching version. If the new binary has already migrated the database, stop all
old processes immediately and continue with the local queue review above.
Keep preview output and backup contents private; they can contain job payloads.

## Files and documents

Frontmatter accepts data-only YAML and JSON, preserving existing scalar types.
Unsupported language selectors and malformed documents return errors, including
in import summaries. An import with per-file failures exits nonzero and reports
`status: "partial"` in JSON; its checkpoint retains completed files for retry.
No bulk reserialization, reindex, or content migration is needed; document
bodies remain opaque to serialization.

Filesystem jobs validate registered canonical roots and reject escaping paths
and symlink targets. POSIX final files are opened with `O_NOFOLLOW` and accessed
through that descriptor. Platforms without `O_NOFOLLOW` support refuse remote
file access. Cooperating writers share root and source locks.
Local filesystem writers and source ancestors remain trusted; these checks do
not provide an OS sandbox against hostile directory replacement.
