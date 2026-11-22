### Changed

- Retire the unused request-id index on shared skill revisions. Publication receipts continue to list every affected revision through the persistence journal. The migration preserves revision rows and leaves customized indexes in place.
