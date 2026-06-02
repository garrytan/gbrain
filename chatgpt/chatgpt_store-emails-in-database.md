---
conversation_id: fd752576-d26e-48f7-b252-11d415ad0bf1
created: 2022-12-22
links:
- '[[chatgpt-clusters/coding_devops]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: Store emails in database
type: note
updated: 2022-12-22
---

# Store emails in database

> Conversation ID: fd752576-d26e-48f7-b252-11d415ad0bf1
> Created: 2022-12-22T20:29:06Z
> Updated: 2022-12-22T20:29:06Z
> Messages: 2

---

## User

I have a mysql database with a ton of users in it. each user has an email. currently we use an emails column and store an array of emails.  but i need to now be able to add a value for email priority so that i know which email to try first. then i need to store a value for validation for each email. the validation will be a regex test, a dns test, and an additional option for if the user clicked a link to validate the email. i need know which of these tests passed and failed for each email for each user. how can i best store this information in my database to make it effecient.

---

## Assistant

It's generally not a good idea to store arrays in a database, as it can make querying the data more difficult and may not scale well. Instead, it's usually better to create a separate table to store the emails and their associated information.

Here's one way you could structure your tables:

Users table:

- id (primary key)
- name
- etc. (other user information)

Emails table:

- id (primary key)
- user_id (foreign key to the Users table)
- email
- priority
- validation_regex
- validation_dns
- validation_link

This way, you can have multiple rows in the Emails table for each user, each with its own email, priority, and validation information. You can then use JOIN clauses in your SQL queries to retrieve the information you need about a user's emails.

For example, you could use the following query to get all the emails for a particular user, ordered by priority:

```
SELECT e.*
FROM Emails e
JOIN Users u ON e.user_id = u.id
WHERE u.id = ?
ORDER BY e.priority ASC
```

This way, you can efficiently retrieve and manipulate the information you need about a user's emails.


**Topic:** [[chatgpt-clusters/coding_devops]]
