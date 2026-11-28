---
kind: fix
---
The fact claim-date repair (gbrain repair fact-claim-dates) no longer moves a fact onto a date that only names a document the claim cites, such as a date inside a wiki link, inside a Markdown link's target, or right before a quoted title. The preview now lists those facts as referenced_date and leaves them on their loaded day, and doctor's dated_claims count leaves them out too. A claim that states its own date next to an undated link still repairs as before.
