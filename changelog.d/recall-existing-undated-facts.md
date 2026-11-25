**Recall preserves existing facts whose event date is unknown.**

<!-- behavior-change: recall_existing_undated_facts -->

### Fixed
- General recall keeps an existing fact with a null event date and returns the observation time separately. Event-time windows and trajectories use dated facts only.
