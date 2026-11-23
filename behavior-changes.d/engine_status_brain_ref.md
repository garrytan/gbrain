---
kind: add
---
New: gbrain engine status --probe prints brain_ref (JSON probe.brain_ref, human line Ref:), a one-way 16-character digest of the brain's persistence identity, never the identity itself. A PGLite gbrain serve now writes a private 0600 file next to the brain at start (<data dir>.gbrain-brain-ref.json) holding that reference and a digest of its lock token, so the probe can report the reference while the serve holds the brain.
