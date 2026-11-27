### Fixed

- Applying an initiative's merge plan no longer copies the initiative's facts into a new project page a second time: the facts table is removed from what the model reads and from new page bodies, so facts reach targets only through the plan's items.
- `initiative_status` now shows each fact's provenance and the finish job's state (`finish_job`), which a remote caller cannot read through `get_job` because the job runs as the brain.
