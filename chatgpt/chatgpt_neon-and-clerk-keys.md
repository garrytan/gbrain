---
title: "Neon and Clerk keys"
type: note
created: 2025-08-26
updated: 2025-08-26
source: chatgpt-export
conversation_id: 68ae3e22-32c8-832d-aa0b-4065da0c506d
message_count: 2
tags: [chatgpt, import]
---
# Neon and Clerk keys

> Conversation ID: 68ae3e22-32c8-832d-aa0b-4065da0c506d
> Created: 2025-08-26T23:07:40Z
> Updated: 2025-08-26T23:07:47Z
> Messages: 2

---

## User

In neon under auth providers i can add my clerk code. But the dev and production codes from clerk are different. Neon only has one in put

---

## Assistant

Neon only gives you one field for the JWT secret / provider config, so you can’t directly put both your Clerk **dev** and **prod** keys in there.  

Options you have:  

1. **Use environment-specific Neon projects**  
   - One Neon project for dev with the Clerk dev key.  
   - One Neon project for prod with the Clerk prod key.  
   - This is the cleanest way since database instances, roles, and secrets are isolated.  

2. **Use Vercel/Supabase edge middleware for key mapping**  
   - Keep the Neon config pointing to a single JWT verification key.  
   - Instead of Neon directly verifying Clerk, route requests through middleware that validates against Clerk using the right key (dev or prod), then issues your own JWT signed with the single Neon secret.  

3. **Single Clerk instance with environments**  
   - If possible, unify Clerk under one instance where both dev and prod issue tokens signed by the same key. Clerk does allow environments, but typically dev/prod projects have different signing keys. If you want Neon to trust both, you’d need an intermediate layer (same as option 2).  

Most teams go with **#1** (separate Neon projects per environment), because it keeps secrets and traffic isolated, and works with Clerk’s separation.  

Do you want me to show you how to set up the dual-project workflow in Neon so you can just point dev at one project and prod at another?
