---
title: "Slack OTP not sent"
type: note
created: 2025-12-12
updated: 2025-12-12
source: chatgpt-export
conversation_id: 693c7c96-de54-8330-88cd-95d4649fb27b
message_count: 2
tags: [chatgpt, import]
---
# Slack OTP not sent

> Conversation ID: 693c7c96-de54-8330-88cd-95d4649fb27b
> Created: 2025-12-12T20:35:35Z
> Updated: 2025-12-12T20:36:38Z
> Messages: 2

---

## User

slack email otp never sent

---

## Assistant

Mr. White, here are the most effective checks when Slack isn’t sending the email OTP:

**1. Confirm the basics**
- Make sure you’re logging in with the **exact email** tied to the Slack workspace.  
- Check **Spam**, **Promotions**, **Updates**, and any filtering rules.

**2. Email delivery issues**
- If you use a corporate domain, the OTP email may be blocked.  
  Ask IT to **allowlist**:  
  - `slack.com`  
  - `*_slack.com`  
  - Slack’s mail provider: `amazonses.com`

**3. Too many requests**
- If you clicked “Send code again” repeatedly, Slack may throttle.  
  Wait **5–10 minutes**, then request a new code once.

**4. Email client lag**
- Some providers (Yahoo, Outlook, company mail) delay OTPs.  
  Try logging in from a **different network** or device to trigger a fresh request.

**5. Workspace mismatch**
- If your email is tied to multiple Slack workspaces, ensure you’re selecting the correct one. Slack only sends OTPs for the workspace you initiated login for.

**6. Try magic link instead**
- Use the “**Sign in with a link**” option; those sometimes bypass OTP issues.

**7. If all else fails**
- Go to: https://slack.com/help/contact and choose **Login Issues → I didn’t get a confirmation email**.

If you want, Mr. White, tell me your email provider (Gmail, Outlook, corporate domain), and I’ll give the most likely cause and quickest fix.


## See Also
- [[chatgpt/chatgpt_email-sent-total-check]]
- [[chatgpt/chatgpt_slack-email-issues]]
- [[chatgpt/chatgpt_slack-help-guide]]
- [[chatgpt/chatgpt_slack-overview]]
- [[chatgpt/chatgpt_slack-sign-in-issue]]
