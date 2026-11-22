---
kind: breaking
exception: data-loss
---
In a managed checkout, gbrain git commit-push --untrack now reads the brain for every file, Markdown and CSV included, to learn which folder the source is rooted in (it used to read the checkout's top-level gbrain.yml, which refused every file of a source rooted in a folder and could admit a folder only that stray file declared, whose pages the next sync deleted), so on PGLite an untrack that worked while gbrain serve or a sync held the brain now refuses untrack_not_db_only and changes nothing until that process stops.
