---
kind: fix
---
gbrain repair visibility --readers, and the new gbrain access member handover, now edit a readable_by written as a block list (one reader per line, the way put_page writes it) instead of refusing the page with label_edit_refused: the key line and its item lines are replaced by one flow-list line, and every other byte of the file is kept. A block scalar, a nested item or a duplicate key is still refused.
