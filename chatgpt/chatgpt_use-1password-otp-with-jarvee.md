---
title: "Use 1Password OTP with Jarvee"
type: note
created: 2024-04-12
updated: 2024-04-12
source: chatgpt-export
conversation_id: fb1ece7d-3967-4853-9954-0597f899b524
message_count: 2
tags: [chatgpt, import]
---
# Use 1Password OTP with Jarvee

> Conversation ID: fb1ece7d-3967-4853-9954-0597f899b524
> Created: 2024-04-12T00:17:19Z
> Updated: 2024-04-12T00:17:50Z
> Messages: 2

---

## User

how do you use a  2fa otp from 1password with jarvee

---

## Assistant

To use a 2FA OTP (One-Time Password) from 1Password with Jarvee, you'll need to follow these steps:

1. **Set Up 2FA in Jarvee:**
   - Log into your Jarvee account.
   - Navigate to the security settings where you can enable Two-Factor Authentication (2FA).
   - When prompted, choose to set up 2FA and select the option to use an authentication app.

2. **Configure 1Password:**
   - Open 1Password and select the entry for Jarvee or create a new entry if you haven’t done so already.
   - In the entry for Jarvee, find the section to add a one-time password and choose to set up a new one.
   - Jarvee will display a QR code on the screen.

3. **Scan the QR Code with 1Password:**
   - Use the 1Password app to scan the QR code provided by Jarvee. This will link 1Password with Jarvee’s 2FA setup.
   - 1Password will automatically generate a new OTP every 30 seconds.

4. **Complete Setup:**
   - Enter the OTP from 1Password back into Jarvee to complete the 2FA setup process.

5. **Using OTP for Login:**
   - Each time you log into Jarvee, you will be asked for an OTP after entering your username and password.
   - Open your 1Password app, find the Jarvee entry, and use the currently displayed OTP to log in.

Make sure to keep your 1Password app secure and accessible, as you will need it each time you log into Jarvee.


## See Also
- [[chatgpt/chatgpt_1password-with-chatgpt-atlas]]
- [[chatgpt/chatgpt_1password-env-variables]]
- [[chatgpt/chatgpt_adjusting-parfait-with-pecans]]
- [[chatgpt/chatgpt_arguing-with-facts]]
- [[chatgpt/chatgpt_auth-system-with-toast-pin]]
