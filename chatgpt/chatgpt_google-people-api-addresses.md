---
title: "Google People API addresses."
type: note
created: 2023-03-10
updated: 2023-03-10
source: chatgpt-export
conversation_id: a4d2789a-0c17-4ae0-b645-49bc767539ea
message_count: 2
tags: [chatgpt, import]
---
# Google People API addresses.

> Conversation ID: a4d2789a-0c17-4ae0-b645-49bc767539ea
> Created: 2023-03-10T17:19:23Z
> Updated: 2023-03-10T17:19:23Z
> Messages: 2

---

## User

how does the google people api store addresses?

---

## Assistant

The Google People API allows developers to access and manage the contacts and personal information stored in a user's Google account. Addresses are stored as a structured object within a contact's profile, with the following fields:

1. `streetAddress` - The street address of the contact, such as "123 Main St".
2. `extendedAddress` - Additional information about the address, such as the apartment or suite number.
3. `poBox` - The post office box number of the contact, if applicable.
4. `locality` - The city or locality of the contact, such as "New York".
5. `region` - The region or state of the contact, such as "NY" for New York.
6. `postalCode` - The postal code or ZIP code of the contact.
7. `country` - The country of the contact, represented as a two-letter ISO 3166-1 alpha-2 country code, such as "US" for the United States.

These fields are used to represent the different components of an address and provide a standardized format for storing and retrieving addresses across different systems and applications.


## See Also
- [[chatgpt/chatgpt_add-google-oauth]]
- [[chatgpt/chatgpt_advantages-of-google-shopping]]
- [[chatgpt/chatgpt_airtable-vs-google-sheets]]
- [[chatgpt/chatgpt_can-black-people-be-irish]]
- [[chatgpt/chatgpt_capture-email-addresses-sql]]
