**CI checkouts retry a stalled fetch instead of hanging until the job times out.**

### Fixed
- A CI checkout whose connection to github.com goes quiet now fails after 120 seconds, and actions/checkout fetches again, so a stall costs about two minutes instead of a timed-out job and a rerun. This changes only CI; nothing users install changes.
