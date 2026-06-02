---
title: "URL query parameter setup"
type: note
created: 2025-09-16
updated: 2025-09-16
source: chatgpt-export
conversation_id: 68c9d374-924c-8322-ba3a-c32ab1795b73
message_count: 8
tags: [chatgpt, import, code]
---
# URL query parameter setup

> Conversation ID: 68c9d374-924c-8322-ba3a-c32ab1795b73
> Created: 2025-09-16T21:15:43Z
> Updated: 2025-09-16T21:51:12Z
> Messages: 8

---

## User

https://survey-response-eight.vercel.app/ ad qtr parameters to this for answer = 1

---

## Assistant

Mr. White — use this:

`https://survey-response-eight.vercel.app/?answer=1`

(If you expect multiple answers, try `?answer[]=1&answer[]=2`. If the param name is different in your app, swap `answer` for the expected key.)

---

## User

Actually, make me four links. One where the answer is education, one where it's affordability, one where it's healthcare, and one where it's housing.

---

## Assistant

Here are the four links with the `answer` query parameter set as requested:

- **Education**  
  `https://survey-response-eight.vercel.app/?answer=education`

- **Affordability**  
  `https://survey-response-eight.vercel.app/?answer=affordability`

- **Healthcare**  
  `https://survey-response-eight.vercel.app/?answer=healthcare`

- **Housing**  
  `https://survey-response-eight.vercel.app/?answer=housing`

---

## User

But use https://survey.camposmedina.com/ as the base

---

## Assistant

Here you go, with the new base URL:

- **Education**  
  `https://survey.camposmedina.com/?answer=education`

- **Affordability**  
  `https://survey.camposmedina.com/?answer=affordability`

- **Healthcare**  
  `https://survey.camposmedina.com/?answer=healthcare`

- **Housing**  
  `https://survey.camposmedina.com/?answer=housing`

---

## User

Put the 4 links into a mailer lite email html block

---

## Assistant

Here’s a simple, email-safe HTML block (table-based with inline styles) for MailerLite—four CTA buttons to the specified links:

```html
<!-- Four Links Block -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;margin:0 auto;">
  <tr>
    <td align="center" style="padding:16px 12px;font-family:Arial,Helvetica,sans-serif;color:#111111;">
      <p style="margin:0 0 12px 0;font-size:18px;line-height:1.4;font-weight:bold;">What matters most to you?</p>
    </td>
  </tr>

  <!-- Education -->
  <tr>
    <td align="center" style="padding:6px 12px;">
      <a href="https://survey.camposmedina.com/?answer=education"
         style="display:inline-block;background:#111111;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:4px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.2;">
        Education
      </a>
    </td>
  </tr>

  <!-- Affordability -->
  <tr>
    <td align="center" style="padding:6px 12px;">
      <a href="https://survey.camposmedina.com/?answer=affordability"
         style="display:inline-block;background:#111111;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:4px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.2;">
        Affordability
      </a>
    </td>
  </tr>

  <!-- Healthcare -->
  <tr>
    <td align="center" style="padding:6px 12px;">
      <a href="https://survey.camposmedina.com/?answer=healthcare"
         style="display:inline-block;background:#111111;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:4px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.2;">
        Healthcare
      </a>
    </td>
  </tr>

  <!-- Housing -->
  <tr>
    <td align="center" style="padding:6px 12px;">
      <a href="https://survey.camposmedina.com/?answer=housing"
         style="display:inline-block;background:#111111;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:4px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.2;">
        Housing
      </a>
    </td>
  </tr>
</table>
<!-- /Four Links Block -->
```

Want these as text links instead of buttons? I can give that version too.


## See Also
- [[chatgpt/chatgpt_accelerator-tracking-setup]]
- [[chatgpt/chatgpt_ai-ops-setup-inquiry]]
- [[chatgpt/chatgpt_ai-setup-instructions]]
- [[chatgpt/chatgpt_alert-setup-for-updates-part1]]
- [[chatgpt/chatgpt_alert-setup-for-updates-part10]]
