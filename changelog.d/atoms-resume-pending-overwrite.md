**Atom extraction can resume an interrupted managed publication.**

### Fixed
- Resume an interrupted atom overwrite only while the original page and origin still match the accepted write. Keep owner edits, cancellations, and pending members whose payload expired.
- After every member commits, retry the batch's completion without asking the model to extract the origin again.
