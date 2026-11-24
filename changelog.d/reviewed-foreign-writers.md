**Add explicit, guard-bound containment for reviewed historical foreign commits.**

### Added
- `gbrain sources review-foreign-writers` previews exact full-SHA containment and requires an explicit reason plus `--apply --expect` before writing a local audit record. Doctor continues to warn on contained history and fails on unreviewed commits or an absent enforce guard.

<!-- behavior-change: foreign_writer_review_containment -->
