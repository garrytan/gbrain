**A member key can write to one source and also read every shared source, now and later.**

### Added
- `gbrain auth create <name> --sources <write-source> --read-shared on`, and `--read-shared on|off` on `gbrain auth rescope` (tokens and OAuth clients) and `gbrain auth register-client`. Shared means `default` plus every federated source, never a guest source and, for a key bound to a member, never another member's own source. A source federated later is read on the next call with no re-grant; writes stay in the write source. Every existing key reads exactly what it read before: the switch is off until you turn it on.
- `whoami` reports `write_source`, `read_sources` and `read_shared`; `gbrain access check` reports `read_shared` and `reads_now`; the admin API takes and reports `read_shared`. A write naming another source says which sources the key reads and the one it writes, and `gbrain sources federate` names the keys that read the newly shared source.

<!-- behavior-change: key_read_shared_gst2898 -->
