---
kind: breaking
exception: data-loss
---
Purging deleted pages now refuses an age that is not a number, negative or infinite. gbrain pages purge-deleted --older-than, the purge job and the maintenance cycle stop with an invalid_argument error and delete nothing. Before, a negative age counted as 0 hours and permanently removed every soft-deleted page. Use 0 to purge every deleted page on purpose, or a positive number of hours.
