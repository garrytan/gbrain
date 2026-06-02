---
title: "Pledge email template"
type: note
created: 2025-09-30
updated: 2025-09-30
source: chatgpt-export
conversation_id: 68dbfab4-2230-832a-8677-0950e22b24ae
message_count: 2
tags: [chatgpt, import, code]
---
# Pledge email template

> Conversation ID: 68dbfab4-2230-832a-8677-0950e22b24ae
> Created: 2025-09-30T15:44:10Z
> Updated: 2025-09-30T15:45:21Z
> Messages: 2

---

## User

Im composing an email in mailer lite. i want users to sign a pledge, ive added a code block for the template.

In the code block i want the following:

Patricia,

You have my pledge. I will vote this November – and I will encourage others to vote as
well. If the Republicans win, Donald Trump will declare it a mandate for his anti-middle
and working-class policies. We can’t let that happen.

Click here to sign electronically.

^now i need that formatted to look like a little pledge letter with a cta for the pledge goes to http://survey.camposmedina.com/ with utm param on it for pledge and the email of the user who signed it.

---

## Assistant

Mr. White — here’s a clean, bulletproof HTML block you can paste into MailerLite’s HTML editor. It renders like a small “pledge letter” with a clear CTA and appends the subscriber’s email + UTM params to the link.

```html
<!-- Pledge Letter Block -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8fafc;padding:24px 0;">
  <tr>
    <td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;">
        <tr>
          <td style="background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:28px 24px;font-family:Georgia,'Times New Roman',Times,serif;color:#111827;line-height:1.6;">
            <div style="font-size:18px;margin-bottom:18px;">Patricia,</div>

            <div style="font-size:17px;margin-bottom:18px;">
              You have my pledge. I will vote this November – and I will encourage others to vote as well.
              If the Republicans win, Donald Trump will declare it a mandate for his anti-middle and
              working-class policies. We can’t let that happen.
            </div>

            <div style="text-align:center;margin:28px 0 18px;">
              <!-- CTA Button -->
              <a
                href="http://survey.camposmedina.com/?utm_source=mailerlite&utm_medium=email&utm_campaign=pledge&utm_content=cta&email={$email}"
                style="display:inline-block;padding:14px 22px;background:#111827;color:#ffffff;text-decoration:none;font-weight:bold;border-radius:6px;"
                target="_blank" rel="noopener"
              >
                Click here to sign electronically
              </a>
            </div>

            <!-- Accessibility + plain-link fallback -->
            <div style="font-size:13px;color:#6b7280;text-align:center;">
              Or open this link in your browser:
              <a href="http://survey.camposmedina.com/?utm_source=mailerlite&utm_medium=email&utm_campaign=pledge&utm_content=cta&email={$email}" style="color:#374151;text-decoration:underline;" target="_blank" rel="noopener">
                http://survey.camposmedina.com/
              </a>
            </div>

            <!-- Optional footer line to complete the "letter" feel -->
            <div style="margin-top:24px;font-size:16px;">Sincerely,<br/>[Your Name]</div>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
<!-- /Pledge Letter Block -->
```

Notes:
- The link includes `utm_source=mailerlite&utm_medium=email&utm_campaign=pledge&utm_content=cta` and appends the subscriber’s email via MailerLite’s merge tag `{$email}`. citeturn0search3

Want me to swap “Patricia” for a first-name variable or add hidden preheader text?
