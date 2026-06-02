---
title: "Merge Domains, Google Workspace"
type: note
created: 2024-06-04
updated: 2024-06-04
source: chatgpt-export
conversation_id: 3ed3c68e-9a90-4505-a8c0-43ab3c656735
message_count: 6
tags: [chatgpt, import]
---
# Merge Domains, Google Workspace

> Conversation ID: 3ed3c68e-9a90-4505-a8c0-43ab3c656735
> Created: 2024-06-04T00:21:14Z
> Updated: 2024-06-04T00:23:31Z
> Messages: 6

---

## User

You know, so I have t at timwhite.co, which is under a Google Workspace account, and then I separately have the domain

---

## Assistant

It sounds like you have a domain for your personal or professional use and another one for your website, timwhite.co, managed under Google Workspace. Are you thinking about merging them, or is there something specific you'd like to do with these domains?

---

## User

I separately have the bubblegumfactory.la hosted on CloudFlare, and I'm having it in my Google Inbox. I want to set up an alias in the Google Inbox to send email from emails under the bubblegumfactory.la address, but I don't have an SMTP server set up yet. Can I do this through CloudFlare? Because Google requires one in order for me to actually have it in the account, even though I probably won't use it for sending.

---

## Assistant

You cannot use CloudFlare to set up an SMTP server, as CloudFlare is primarily a DNS and CDN service. However, you can use a third-party SMTP service to achieve your goal. Here’s how you can set it up:

1. **Choose an SMTP Service**: You can use services like SendGrid, Mailgun, or even Gmail's own SMTP server if you have another Gmail account.

2. **Set Up the SMTP Service**:
   - Sign up for the SMTP service of your choice.
   - Follow their instructions to configure your SMTP settings. They will typically provide you with the SMTP server address, port, and login credentials.

3. **Configure Your Google Workspace Alias**:
   - Log in to your Google Workspace admin console.
   - Go to `Settings` -> `Accounts`.
   - Under "Send mail as," click `Add another email address`.
   - Enter the name and email address you want to use.
   - Choose `Send through yourdomain.com SMTP servers`.
   - Enter the SMTP server details from the third-party SMTP service you set up.

4. **Verify the Alias**:
   - Google will send a verification code to the email address you entered.
   - Retrieve this code from your email and enter it to verify the alias.

5. **Test the Setup**:
   - Send a test email from your Google Inbox using the new alias to ensure it works correctly.

By setting up a third-party SMTP server, you can send emails from your bubblegumfactory.la address through your Google Inbox without using CloudFlare for SMTP.

---

## User

Maybe it's just easier to add it as an alias on the Google Workspace account, and then remove all of our Gmail routing.

---

## Assistant

Yes, adding the domain as an alias to your Google Workspace account can simplify the process. Here’s how you can do it:

1. **Add Domain Alias to Google Workspace**:
   - Go to the [Google Workspace Admin Console](https://admin.google.com/).
   - Navigate to `Domains` -> `Manage domains`.
   - Click `Add a domain alias`.
   - Enter the domain you want to add (bubblegumfactory.la).
   - Follow the prompts to verify ownership of the domain. This usually involves adding a TXT record to your DNS settings in CloudFlare.

2. **Verify Domain Ownership**:
   - Log in to your CloudFlare account.
   - Go to the DNS settings for bubblegumfactory.la.
   - Add the TXT record provided by Google to verify ownership.
   - Once the DNS changes propagate (this can take a few minutes to several hours), Google will verify the domain.

3. **Set Up Email Aliases**:
   - Once the domain is verified, you can set up email aliases for your users in Google Workspace.
   - Navigate to `Users` in the Google Workspace Admin Console.
   - Select the user you want to add an alias for.
   - Click `User information` -> `Email aliases`.
   - Add the desired email alias (e.g., yourname@bubblegumfactory.la).

4. **Remove Gmail Routing** (if needed):
   - If you had any specific routing rules set up in Gmail for handling emails to the bubblegumfactory.la domain, you can now remove them.
   - Go to `Settings` -> `Forwarding and POP/IMAP` in Gmail.
   - Remove any forwarding rules that are no longer needed.

5. **Test the Setup**:
   - Send a test email to the new alias to ensure it is working correctly.
   - Also, send an email from the alias to confirm that it can send emails properly.

By adding the domain as an alias in Google Workspace, you can manage all your emails from one account without the need for additional SMTP servers or complex routing rules.
