### Fixed

- A managed `remember` write that changes only facts hidden from Atom extraction no longer queues the page again when the earlier extraction input and its published Atoms still match. Doctor and the extraction phase use the same evidence. Changes to visible input and missing outputs still follow the normal discovery rules.
