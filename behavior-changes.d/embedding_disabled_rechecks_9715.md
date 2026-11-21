---
kind: fix
---
With embedding_disabled set, a contextual reindex job queued before the setting was turned on now sends nothing when the worker runs it. One already running checks the setting again before each embedding send and before each per-chunk synopsis call, and a gbrain reindex --multimodal run already in progress stops before its next batch with the enable-command message (#9715). When the database setting cannot be read, the contextual reindex job, the doctor --remediate embed step and gbrain serve's background embed send nothing, keep the work pending and try again later, instead of counting it as done.
