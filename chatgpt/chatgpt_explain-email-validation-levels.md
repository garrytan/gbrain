---
title: "Explain Email Validation Levels"
type: note
created: 2022-12-22
updated: 2022-12-22
source: chatgpt-export
conversation_id: 28bfe36c-c86a-460a-a501-1b6609986dbf
message_count: 4
tags: [chatgpt, import]
---
# Explain Email Validation Levels

> Conversation ID: 28bfe36c-c86a-460a-a501-1b6609986dbf
> Created: 2022-12-22T20:39:09Z
> Updated: 2022-12-22T20:39:09Z
> Messages: 4

---

## User

Jovie validates emails. Theres 3 levels. Basic Check this is just a regex test. DNS check. and finally a full validation where the receipient has actually clicked a link or has an account on jovie or the user previous received emails from that person. the last kind is where we 100% know the email is valid.

Write a help article for the Jovie Help Center that explains in plain english the 3 levels.  Assume the user is not well versed in technical language.

---

## Assistant

Jovie offers three levels of email validation to help you ensure that the emails in your list are accurate and up-to-date. Here's a breakdown of each level:

1. Basic Check: This is a simple test that uses a regular expression (regex) to verify that the email address is properly formatted. This check can catch obvious mistakes, such as typos or missing characters, but it can't guarantee that the email address is actually active.

2. DNS Check: This level of validation checks the domain of the email address to see if it's registered and able to receive mail. This can help you identify invalid or fake email addresses that may have passed the basic check.

3. Full Validation: This is the most thorough level of email validation available. It involves sending a message to the email address and verifying that it's active. This can be done by requiring the recipient to click a link in the message or by checking if the recipient has an account with Jovie or has previously received emails from you. This level of validation gives you the highest level of confidence that an email address is valid.

Remember, no email validation method is foolproof, and it's always a good idea to double-check your email lists before sending a campaign. By using these three levels of validation, you can help ensure that your emails are reaching the right people and improve the overall effectiveness of your email marketing efforts.

---

## User

this is great. except for the 3rd point. explain that we could have validated it because you previously emailed this reciepient or received emails from this receipeint or they have a jovie account with a valid email attatched.

---

## Assistant

Sure, here's an updated version of the third level of email validation:

3. Full Validation: This is the most thorough level of email validation available. It involves sending a message to the email address and verifying that it's active. This can be done by requiring the recipient to click a link in the message, or by checking if the recipient has an account with Jovie that is associated with the email address in question, or if the recipient has previously received emails from you. This level of validation gives you the highest level of confidence that an email address is valid, as it confirms that the email address is actively being used.

I hope this helps clarify the full validation process. Let me know if you have any other questions.



## See Also
- [[chatgpt/chatgpt_combine-email-validation-methods]]
- [[chatgpt/chatgpt_fix-email-validation-function]]
- [[chatgpt/chatgpt_modify-email-validation-function]]
- [[chatgpt/chatgpt_vue-email-validation-component-2]]
- [[chatgpt/chatgpt_vue-email-validation-component]]
