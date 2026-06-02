---
title: "Job application automation"
type: guide
created: 2025-11-12
updated: 2025-11-12
source: chatgpt-export
topic: coding-ai
message_count: 6
tags: [chatgpt, knowledge, coding-ai]
---
**Topic:** [[chatgpt-knowledge/_topics/coding-ai]]

# Job application automation

> **Source:** ChatGPT conversation
> **Date:** 2025-11-12T19:55:48Z
> **Messages:** 6
> **Topic:** coding-ai

## Question

I want bartending jobs in LA. I want chatgpt in atlas browser to use agent mode to apply to them for me.

We will use indeed and it's easy apply. We will fill out the form and answer any questions we will optimize to get the job using the context from my resume below:

{
  "experience": [
    {
      "title": "Bar Manager",
      "company": "Vault Speakeasy",
      "location": "Beverly Hills, CA",
      "years": "2024 - Present",
      "description": "Managed bar & kitchen ops for 500+ guests, boosting revenue to $20K+/night while cutting headcount. Identified and eliminated FOH/BOH bottlenecks to improve efficiency; implemented Toast POS & KDS, streamlined inventory/staffing through training & nightly pre-shifts, and resolved issues to secure repeat guests."
    },
    {
      "title": "Lead Bartender",
      "company": "Kookabura Lounge",
      "location": "Hollywood, CA",
      "years": "2025 - Present",
      "description": "Drove $10K+ in sales on event nights through rapid servic

## Answer

Mr. White, here’s a single, copy-paste prompt you can drop into ChatGPT inside Atlas Browser’s Agent Mode. It will search Indeed and auto-apply via **Easily apply** only, using your resume and rules.

```
You are an autonomous job-application agent operating inside Atlas Browser.

GOAL
Find and apply to bartender/lead bartender jobs for me on Indeed using “Easily apply” ONLY, posted within the last 30 days, while following my location rules and profile below. Maintain a running log (table) of every job you applied to.

MY DETAILS
- Name: Tim White
- Phone: 732.668.2148
- Address (home base for commute filter): 1417 N Bronson Ave, Los Angeles, CA
- Instagram: https://instagram.com/timwhite
- Work authorization: Yes (U.S.)
- Age: 21+
- Availability: Nights/weekends/holidays; can start immediately
- Transportation: Reliable; willing to commute per rules below
- Certifications: If asked about CA RBS/LEAD—answer: “Will obtain immediately (within 7 days)” unless the form allows leaving blank.
- Desired pay: If optional → “Open to discuss.” If a single number is REQUIRED, enter 23 (USD/hr) and note “plus tips.”

TARGET & FILTERS
- Site: indeed.com (U.S.)
- Titles to INCLUDE: “Bartender”, “Lead Bartender”, “Head Bartender”, “Mixologist” (but NOT barista)
- EXCLUDE: “Barback”, “Server”, “Barista”, “Sommelier”, “Host/Hostess”
- Location scope:
  1) Prefer roles within walking distance or ≤15 min DRIVE from 1417 N Bronson Ave (use Google Maps driving time, typical traffic).
  2) ALWAYS ACCEPT West Hollywood.
  3) BEACH EXCEPTIONS: Accept if the venue is one of the popular places: “Belle’s Beach House” or “Jameson’s Santa Monica”.
- Date posted: last 30 days only.
- Application method: “Easily apply”, “Apply directly”, or “Apply with your Indeed Resume”. SKIP anything that forces an external/company ATS or custom site.
- Sort by date (newest first). Avoid duplicates.

WORKFLOW
1) Go to indeed.com → Jobs.
2) Search: title = (bartender OR "lead bartender" OR "head bartender" OR mixologist), location = Los Angeles, CA.
3) Filters:
   - Date posted: Last 30 days
   - “Easily apply” / “Apply directly”
   - Distance: Start with ≤5–10 miles to get nearby results; verify commute time with Google Maps for each role.
4) For each posting:
   - Open in a new tab. Extract venue/company name and exact address. If address not visible, search “[venue] address Los Angeles” to confirm.
   - Compute drive time from 1417 N Bronson Ave; proceed if ≤15 minutes OR if location is West Hollywood OR if it’s Belle’s Beach House or Jameson’s Santa Monica. Otherwise SKIP.
   - Confirm title is Bartender/Lead/Head/Mixologist (not barback/server/etc.). If wrong, SKIP.
5) Click “Easily apply”. Use the logged-in Indeed account email. If asked to upload a resume and none is stored, PASTE the plaintext resume from the block at the end of this prompt into the resume text field.
6) Answer common form questions (use these defaults):
   - Years of total bartending experience: 7
   - Years in lead

*(Answer truncated — 7368 chars total)*

## Question

I must be logged into indeed under timwhitebartending@gmail.com which we should also use as my contact email. I have other indeed accounts for non bartending related jobs so this is important.
Also add to the prompt Run this prompt every weekday at 8am and notify me with a summary of the jobs applied to and the jobs skipped.

## Answer

Mr. White, here’s the updated Atlas Browser Agent Mode prompt with your Indeed login/email requirement and weekday 8am schedule + notification.

```
You are an autonomous job-application agent operating inside Atlas Browser.

SCHEDULING
- Run this full workflow automatically every WEEKDAY at 08:00 AM America/Los_Angeles.
- After each run, post a concise summary message listing: (1) total submitted, (2) total skipped with reasons, and (3) links to applied postings. Also display/refresh the LOG table.

ACCOUNT REQUIREMENT (CRITICAL)
- You MUST be logged into Indeed with this account: timwhitebartending@gmail.com
- Contact email on all forms: timwhitebartending@gmail.com
- If Indeed shows any other logged-in account, SIGN OUT and SIGN BACK IN with the above email. If credentials/2FA are needed and cannot be supplied, HALT and notify: “Login needed for timwhitebartending@gmail.com”.

GOAL
Find and apply to bartender/lead bartender jobs for me on Indeed using “Easily apply” ONLY, posted within the last 30 days, while following my location rules and profile below. Maintain a running LOG table of every job you applied to (and skipped with reason).

MY DETAILS
- Legal name: Tim White
- Phone: 732.668.2148
- Email: timwhitebartending@gmail.com
- Address (for commute filter): 1417 N Bronson Ave, Los Angeles, CA
- Instagram: https://instagram.com/timwhite
- Work authorization: Yes (U.S.)
- Age: 21+
- Availability: Nights/weekends/holidays; can start immediately
- Transportation: Reliable; willing to commute per rules below
- Certifications: If asked about CA RBS/LEAD → “Will obtain immediately (within 7 days)” (unless already on file)
- Desired pay: If optional → “Open to discuss.” If a single number is REQUIRED, enter 23 (USD/hr) and note “plus tips.”

TARGET & FILTERS
- Site: indeed.com (U.S.)
- Titles to INCLUDE: “Bartender”, “Lead Bartender”, “Head Bartender”, “Mixologist” (NOT barista)
- EXCLUDE: “Barback”, “Server”, “Barista”, “Sommelier”, “Host/Hostess”
- Location scope:
  1) Accept roles within walking distance or ≤15 min DRIVE from 1417 N Bronson Ave (verify with Google Maps driving time, typical evening traffic).
  2) ALWAYS ACCEPT West Hollywood.
  3) BEACH EXCEPTIONS: Accept if venue is “Belle’s Beach House” or “Jameson’s Santa Monica”.
- Date posted: Last 30 days only.
- Application method: “Easily apply”, “Apply directly”, or “Apply with your Indeed Resume”. SKIP anything that forces an external/company ATS or custom site.
- Sort: Date (newest first). Avoid duplicates.

WORKFLOW
1) Go to indeed.com → Jobs. Confirm you are logged in as timwhitebartending@gmail.com (top-right avatar/account). If not, sign out and sign in with that email; otherwise HALT and notify if unable.
2) Search:
   - Title: bartender OR "lead bartender" OR "head bartender" OR mixologist
   - Location: Los Angeles, CA
3) Apply filters:
   - Date posted: Last 30 days
   - “Easily apply” / “Apply directly”
   - Distance: start with ≤5–10 miles; verify commute time for each.
4

*(Answer truncated — 7663 chars total)*

## Question

Skip any jobs for places ive already worked

## Answer

Mr. White, got it. Here’s the same Atlas Browser Agent Mode prompt—now with “skip past employers” baked in.

```
You are an autonomous job-application agent operating inside Atlas Browser.

SCHEDULING
- Run this full workflow automatically every WEEKDAY at 08:00 AM America/Los_Angeles.
- After each run, post a concise summary message listing: (1) total submitted, (2) total skipped with reasons, and (3) links to applied postings. Also display/refresh the LOG table.

ACCOUNT REQUIREMENT (CRITICAL)
- You MUST be logged into Indeed with this account: timwhitebartending@gmail.com
- Contact email on all forms: timwhitebartending@gmail.com
- If Indeed shows any other logged-in account, SIGN OUT and SIGN BACK IN with the above email. If credentials/2FA are needed and cannot be supplied, HALT and notify: “Login needed for timwhitebartending@gmail.com”.

GOAL
Find and apply to bartender/lead bartender jobs for me on Indeed using “Easily apply” ONLY, posted within the last 30 days, while following my location rules and profile below. Maintain a running LOG table of every job you applied to (and skipped with reason).

MY DETAILS
- Legal name: Tim White
- Phone: 732.668.2148
- Email: timwhitebartending@gmail.com
- Address (for commute filter): 1417 N Bronson Ave, Los Angeles, CA
- Instagram: https://instagram.com/timwhite
- Work authorization: Yes (U.S.)
- Age: 21+
- Availability: Nights/weekends/holidays; can start immediately
- Transportation: Reliable; willing to commute per rules below
- Certifications: If asked about CA RBS/LEAD → “Will obtain immediately (within 7 days)” (unless already on file)
- Desired pay: If optional → “Open to discuss.” If a single number is REQUIRED, enter 23 (USD/hr) and note “plus tips.”

TARGET & FILTERS
- Site: indeed.com (U.S.)
- Titles to INCLUDE: “Bartender”, “Lead Bartender”, “Head Bartender”, “Mixologist” (NOT barista)
- EXCLUDE: “Barback”, “Server”, “Barista”, “Sommelier”, “Host/Hostess”
- Location scope:
  1) Accept roles within walking distance or ≤15 min DRIVE from 1417 N Bronson Ave (verify with Google Maps driving time, typical evening traffic).
  2) ALWAYS ACCEPT West Hollywood.
  3) BEACH EXCEPTIONS: Accept if venue is “Belle’s Beach House” or “Jameson’s Santa Monica”.
- Date posted: Last 30 days only.
- Application method: “Easily apply”, “Apply directly”, or “Apply with your Indeed Resume”. SKIP anything that forces an external/company ATS or custom site.
- Sort: Date (newest first). Avoid duplicates.

PAST EMPLOYERS — DO NOT APPLY
- Vault Speakeasy (Beverly Hills)
- Kookabura Lounge / Kookaburra Lounge (Hollywood)  ← treat spelling variants as matches
- Rose Bowl (VIP Lounge) / Rose Bowl Stadium (Pasadena)
- St Felix / St. Felix (Hollywood)
- National Bar Staffing (Los Angeles)
- Alvarez & Co (Los Angeles)
RULE: If the company/venue name equals, contains, or closely matches any above (including common spelling/punctuation variants), SKIP and log “Skipped — past employer.”

WORKFLOW
1) Go to indeed.com → Jobs. 

*(Answer truncated — 8316 chars total)*
