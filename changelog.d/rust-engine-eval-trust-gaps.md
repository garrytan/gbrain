**The memory-trust evals' pause now survives a change to one source, keeps both errors when a run and its restore fail, and the text scan finds and leaves out the same rows on every engine.**

### Fixed
- The evals' pause of managed persistence now restores the brain after a change to one source during the run, such as adding a source or connecting a company brain. Only a brain-wide change, such as a deactivation, keeps the brain paused and is reported.
- On PGLite and Postgres the pause reads the prior state after it takes the brain lock, so a change that commits while the pause waits is part of what it restores against.
- When the run fails and the restore also fails, the caller now gets both errors. The restore error is attached to the run's error, or both are in one `AggregateError` when the run's error is a string or a frozen object.
- The text scan with live rows only now leaves out the wanted links and aliases of a deleted page and a fact whose end date has passed. The live facts read by exact text leaves out that fact too.
- Equal values in the text scan now come back in the same order on every engine, so a limit keeps the same hits.
- On the Rust engine the text scan now finds a token in a config key, a page alias, a whole jsonb number or boolean, and a wanted link, link relationship or link transition, as the SQL engines do. With live rows only, it also leaves out the sealed search timeline of a deleted page.
- On Postgres the scan's row-security check now counts a column whose type is a domain over text, so a role that row security filters is refused instead of answered with nothing.
