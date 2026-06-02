---
title: "Next.js prompts"
type: guide
created: 2025-12-03
updated: 2025-12-03
source: chatgpt-export
conversation_id: 6930b62c-1b44-832e-bd1d-ae0f7346fd9f
message_count: 2
tags: [chatgpt, import, code]
---
# Next.js prompts

> Conversation ID: 6930b62c-1b44-832e-bd1d-ae0f7346fd9f
> Created: 2025-12-03T22:14:04Z
> Updated: 2025-12-03T22:14:42Z
> Messages: 2

---

## User

prompts for next.js

---

## Assistant

Mr. White — here are some strong prompt templates you can use when working with entity["software", "Next.js", 0] (especially useful for the App Router + TypeScript stack). You can plug in your own project-specific context.  

---

### ✅ General scaffolding prompt  
> “I’m building a Next.js (vX, App Router) web application using TypeScript and Tailwind CSS.  
> Please scaffold a new feature: **[describe feature here]**.  
> Requirements:  
> - Create a new route at `/app/[featureRoute]`.  
> - Add server-side data fetching via `getServerSideProps` or `fetch` in the server component.  
> - Use a client component for interactive UI if needed.  
> - Use Tailwind for styling, and export types for props.  
> - Ensure accessibility (semantic HTML, alt tags, ARIA if needed).  
> - Provide the file structure and example code for each file.  
> After generating the code, explain how I’d integrate it into my existing layout and how I’d test it locally.”

---

### 🛠 Debugging / explaining errors  
> “I have a Next.js App Router page at `/app/page.tsx` that triggers this error:  
> `**[insert full error message here]**`.  
> My code snippet is:  
> ```tsx  
> [insert code here]  
> ```  
> Using TypeScript 5, Next.js vX, React 18. Explain **three possible root causes** of this error (with references to the Next.js docs) and for each cause provide:  
> 1) A minimal fix (code snippet)  
> 2) A test or verification method  
> 3) Which fix is most likely given the context.  
> Then provide one best-practice to avoid this error going forward.”

---

### 🔍 Performance / best-practice audit  
> “Act as a senior Next.js developer. I’ll paste you my `app/` folder file list and some key files. Review for performance and architecture best practices (routing, data fetching, caching, bundle size). Provide:  
> - A summary of **5 issues** (with file names) that could increase bundle size or slow initial load  
> - For each issue: the impact, how to fix it (code snippet), and any trade-offs  
> - One additional improvement I should make **now** to future-proof the app.”

---

### 🔐 Security / authentication feature  
> “I’m implementing authentication in my Next.js App Router project. I’m using **[insert auth library e.g., Supabase/Auth0]**.  
> Write a step-by-step prompt for code generation that ensures:  
> - Secure token storage and renewal  
> - Server-side protection of API routes  
> - Role-based access (e.g., admin vs regular user)  
> - Example TypeScript types + interface for the user object  
> After code generation, list 3 potential vulnerabilities specific to Next.js auth and how to test/mitigate them.”

---

### 📦 Integration with external service  
> “I need to integrate my Next.js app with the entity["software", "Supabase", 0] database and real-time updates.  
> Create a prompt for the AI that:  
> - Installs and configures `@supabase/supabase-js`  
> - Sets up env variables securely (`.env.local`)  
> - Implements a server client utility and a browser client utility  
> - Builds a Next.js route `/app/data` that fetches initial data server-side and updates it client-side via real-time subscription  
> - Uses TypeScript types for records  
> Provide code, folder structure, and explanation of key parts.”

---

If you like, I can **generate 10 more ready-to-use prompts** (covering pages, layouts, middleware, API routes, migrations) tailored for your stack. Would you like me to pull those together?
