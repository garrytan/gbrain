---
kind: fix
---
Managed sync measures elapsed time independently of system clock adjustments, so a clock change no longer creates or hides a slow-pass warning in Doctor.
