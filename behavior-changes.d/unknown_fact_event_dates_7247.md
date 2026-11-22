---
kind: default
---
Facts without an event date now store a null start in the database and unknown in canonical Markdown. The source observation date can still interpret relative dates, and the recording time remains available for general recall. Event-date filters and trajectories exclude undated facts by default. Rust stores upgrade to format 2, preserving stored dates. Open an upgraded Rust store with a format 2 addon.
