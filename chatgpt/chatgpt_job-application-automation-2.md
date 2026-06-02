---
title: "Job application automation"
type: essay
created: 2025-11-12
updated: 2025-11-12
source: chatgpt-export
conversation_id: 6914e574-c854-832a-9490-bbf629569b5b
message_count: 6
tags: [chatgpt, import, code, long-form]
---
# Job application automation

**Related:** [[personal_life]]

> Conversation ID: 6914e574-c854-832a-9490-bbf629569b5b
> Created: 2025-11-12T19:55:48Z
> Updated: 2025-11-12T20:15:04Z
> Messages: 6

---

## User

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
      "description": "Drove $10K+ in sales on event nights through rapid service and upselling, managed walk-up and service bar for 150-guest comedy shows, and provided VIP green-room service for artists and comedians."
    },
    {
      "title": "Lead Bartender (VIP Lounge)",
      "company": "Rose Bowl",
      "location": "Pasadena, CA",
      "years": "2023 - 2024",
      "description": "Bartended the center well in a 5-well VIP lounge at the Rose Bowl driving double the sales of any well. Managed inventory and POS close-out, ensured compliance with service protocols, and was featured in sponsor marketing materials."
    },
    {
      "title": "Bartender",
      "company": "St Felix",
      "location": "Hollywood",
      "years": "2022 - 2023",
      "description": "Prepared custom craft cocktails from an extensive mixology-heavy menu in a high-volume bar serving packed sports-event, corporate-buyouts, & VIP clients. Covered tables when servers were occupied."
    },
    {
      "title": "Bartender",
      "company": "National Bar Staffing",
      "location": "Los Angeles, CA",
      "years": "2021 - 2022",
      "description": "Bartended at corporate events, movie premieres, and VIP functions—handled mobile bar setup/breakdown and ensured seamless high-volume service."
    },
    {
      "title": "Bartender",
      "company": "Alvarez & Co",
      "location": "Los Angeles, CA",
      "years": "2018 - 2021",
      "description": "Adapted quickly to diverse, high-pressure venues—ranging from upscale private events to large-scale festivals."
    }
  ]
}

Also use info about me like my name is Tim White my instagram is @timwhite (use a link though), my phone is 732.668.2148 i live at 1417 N Bronson Ave.

I want jobs that are walking distance or a 15 min drive max.
I want jobs that are bartender or lead bartender.
I will also accept jobs that are by the beach if they are one of the more popular places like Belle's beach house or jamesons Santa Monica. 
I will also accept anything in West Hollywood.
Apply to the jobs on my behald
Skip if it does not let you use easy apply on indeed or forces you to a custom website application etc.
Include my resume.
Do this autonomously and apply to all jobs posted in the last 30 days.
Give me a prompt I can give to chatgpt in the atlas browser to perform this for me.

---

## Assistant

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
   - Years in lead/supervisory behind the bar: 3
   - High-volume experience (stadiums, 300+ covers, $10k+ nights): Yes
   - Craft cocktails/mixology: Advanced
   - POS: Toast POS (expert); KDS: implemented
   - Cash handling/closing: Yes
   - Availability: Nights/weekends/holidays; start immediately
   - Work authorization: Yes
   - Valid CA RBS/LEAD: “Will obtain within 7 days” (unless already on file in Indeed)
   - Willing to commute: Yes, within 15 minutes; also West Hollywood and the two beach exceptions
   - Desired pay: “Open to discuss”; if a single $ is required, enter 23
   - Will you take barback shifts? No (target is bartender/lead bartender)
   - Schedule preferences: Evenings, late nights, weekends
7) If a cover letter/”additional info” box appears, paste a tailored 3–5 sentence note highlighting high-volume revenue, Toast POS, VIP/comedy/event service, and team leadership (use the template below).
8) Submit the application. Then append a line to the running LOG table with: Company | Venue (if different) | Job Title | City/Neighborhood | Drive Time (min) | Easy Apply? | Date Posted | Result (Submitted/Skipped w/ reason) | Link.
9) Continue until you exhaust relevant results on the current page; then move to the next page. Stop when no qualifying roles remain for the last 30 days.
10) At the end, display the full LOG table and count of applications submitted.

COVER LETTER (tailor per venue with their name and any posted requirements):
“Hi, I’m Tim White. I’ve run high-volume programs across Hollywood/Beverly Hills—managing 500+ guest nights and helping drive $20K+ evenings—while implementing Toast POS/KDS, training teams, and speeding service. I’ve led center-well and VIP service (Rose Bowl, comedy shows) and regularly push $10K+ event nights through upselling and fast, clean rounds. I’m available nights/weekends, can start immediately, and I’m happy to bring the same throughput and hospitality to [VENUE]. Instagram: https://instagram.com/timwhite”

PLAINTEXT RESUME (paste if upload isn’t available)
Tim White | 732.668.2148 | https://instagram.com/timwhite | 1417 N Bronson Ave, Los Angeles, CA
Bartender / Lead Bartender / Bar Manager

Experience
- Bar Manager — Vault Speakeasy, Beverly Hills, CA (2024–Present)
  • Managed bar & kitchen ops for 500+ guests; boosted revenue to $20K+ nights while reducing headcount.
  • Implemented Toast POS & KDS; streamlined inventory/staffing with training and nightly pre-shifts; improved repeat guest rate.

- Lead Bartender — Kookabura Lounge, Hollywood, CA (2025–Present)
  • Drove $10K+ sales on event nights via rapid service & upselling; ran walk-up and service bar for 150-guest comedy shows.
  • Provided VIP green-room service for artists/comedians.

- Lead Bartender (VIP Lounge) — Rose Bowl, Pasadena, CA (2023–2024)
  • Center well in a 5-well VIP lounge; doubled sales vs any other well.
  • Managed inventory and POS closeout; ensured protocol compliance; featured in sponsor marketing.

- Bartender — St Felix, Hollywood, CA (2022–2023)
  • Custom craft cocktails from an extensive, mixology-heavy menu in a high-volume setting.
  • Covered tables during peak sports/corporate/VIP events.

- Bartender — National Bar Staffing, Los Angeles, CA (2021–2022)
  • Corporate events, movie premieres, VIP functions; mobile bar setup/breakdown; seamless high-volume service.

- Bartender — Alvarez & Co, Los Angeles, CA (2018–2021)
  • Adapted to upscale private events and large-scale festivals in high-pressure environments.

Selected Skills
High-volume cocktail service • Lead/center-well operations • Toast POS & KDS • Inventory & ordering • Staff training & pre-shifts • VIP & green-room service • Upselling & sales throughput • Rapid, clean rounds • Cash handling & closeout • Guest recovery & retention

References available upon request.

BEHAVIOR RULES
- Never follow links to external company sites; SKIP those jobs.
- Never apply to barback/server/FOH roles not explicitly bartender/lead/head/mixologist.
- Only apply to postings from the last 30 days.
- Obey commute rule; otherwise skip with reason noted.
- Be fast but accurate; no made-up credentials. Use “will obtain within 7 days” for RBS if required.
- Keep the live application LOG visible and updated after each submission.
```

If you want, I can also turn that resume block into a clean one-page PDF for uploading.

---

## User

I must be logged into indeed under timwhitebartending@gmail.com which we should also use as my contact email. I have other indeed accounts for non bartending related jobs so this is important.
Also add to the prompt Run this prompt every weekday at 8am and notify me with a summary of the jobs applied to and the jobs skipped.

---

## Assistant

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
4) For each posting:
   - Open in a new tab. Capture venue/company name and address. If address missing, search “[venue] address Los Angeles” and confirm.
   - Compute drive time from 1417 N Bronson Ave. Proceed if ≤15 minutes OR in West Hollywood OR venue is Belle’s Beach House or Jameson’s Santa Monica. Otherwise SKIP.
   - Confirm title (Bartender/Lead/Head/Mixologist). If not, SKIP.
5) Click “Easily apply”.
   - Use resume on file; if upload not available, PASTE the PLAINTEXT RESUME from the end of this prompt into the resume field.
   - Ensure contact email = timwhitebartending@gmail.com and phone = 732.668.2148.
6) Answer common questions (defaults):
   - Total bartending years: 7
   - Lead/supervisory behind bar: 3
   - High-volume (stadiums, 300+ covers, $10k+ nights): Yes
   - Craft cocktails/mixology: Advanced
   - POS: Toast POS (expert); KDS: implemented
   - Cash handling/closing: Yes
   - Availability: Nights/weekends/holidays; start immediately
   - Work authorization: Yes
   - CA RBS/LEAD: “Will obtain within 7 days”
   - Willing to commute: Yes, within 15 minutes; also West Hollywood; beach exceptions as above
   - Desired pay: “Open to discuss”; if single number required: 23
   - Will take barback shifts? No
   - Schedule preferences: Evenings, late nights, weekends
7) If a cover letter/“additional info” box appears, paste a tailored 3–5 sentence note:

   “Hi, I’m Tim White. I’ve run high-volume programs across Hollywood/Beverly Hills—managing 500+ guest nights and helping drive $20K+ evenings—while implementing Toast POS/KDS, training teams, and speeding service. I’ve led center-well and VIP service (Rose Bowl, comedy shows) and regularly push $10K+ event nights through upselling and fast, clean rounds. I’m available nights/weekends, can start immediately, and I’m happy to bring the same throughput and hospitality to [VENUE]. Instagram: https://instagram.com/timwhite”

8) Submit the application.
9) LOGGING: After each posting, append a row to a visible table with:
   Company | Venue (if different) | Job Title | Neighborhood/City | Drive Time (min) | Easy Apply? | Date Posted | Result (Submitted / Skipped + reason) | Link
10) Continue through all pages until no qualifying roles remain (last 30 days). Avoid duplicates.

PLAINTEXT RESUME (use if upload isn’t available)
Tim White | 732.668.2148 | https://instagram.com/timwhite | 1417 N Bronson Ave, Los Angeles, CA
Bartender / Lead Bartender / Bar Manager

Experience
- Bar Manager — Vault Speakeasy, Beverly Hills, CA (2024–Present)
  • Managed bar & kitchen ops for 500+ guests; boosted revenue to $20K+ nights while reducing headcount.
  • Implemented Toast POS & KDS; streamlined inventory/staffing with training and nightly pre-shifts; improved repeat guest rate.

- Lead Bartender — Kookabura Lounge, Hollywood, CA (2025–Present)
  • Drove $10K+ sales on event nights via rapid service & upselling; ran walk-up and service bar for 150-guest comedy shows.
  • Provided VIP green-room service for artists/comedians.

- Lead Bartender (VIP Lounge) — Rose Bowl, Pasadena, CA (2023–2024)
  • Center well in a 5-well VIP lounge; doubled sales vs any other well.
  • Managed inventory and POS closeout; ensured protocol compliance; featured in sponsor marketing.

- Bartender — St Felix, Hollywood, CA (2022–2023)
  • Custom craft cocktails from an extensive, mixology-heavy menu in a high-volume setting.
  • Covered tables during peak sports/corporate/VIP events.

- Bartender — National Bar Staffing, Los Angeles, CA (2021–2022)
  • Corporate events, movie premieres, VIP functions; mobile bar setup/breakdown; seamless high-volume service.

- Bartender — Alvarez & Co, Los Angeles, CA (2018–2021)
  • Adapted to upscale private events and large-scale festivals in high-pressure environments.

Selected Skills
High-volume cocktail service • Lead/center-well operations • Toast POS & KDS • Inventory & ordering • Staff training & pre-shifts • VIP & green-room service • Upselling & sales throughput • Rapid, clean rounds • Cash handling & closeout • Guest recovery & retention

BEHAVIOR RULES
- Always use/confirm login + contact email: timwhitebartending@gmail.com.
- Never follow external/ATS links; SKIP those jobs.
- Never apply to barback/server/FOH roles not explicitly bartender/lead/head/mixologist.
- Only apply to postings from the last 30 days.
- Enforce the commute/West Hollywood/beach exceptions. If skipped, record the reason.
- Be fast and accurate; no made-up credentials.
- Keep the live application LOG visible and updated after each submission.

END OF PROMPT
```

Want me to turn your resume into a clean one-page PDF for uploads too?

---

## User

Skip any jobs for places ive already worked

---

## Assistant

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
1) Go to indeed.com → Jobs. Confirm you are logged in as timwhitebartending@gmail.com (top-right avatar/account). If not, sign out and sign in with that email; otherwise HALT and notify if unable.
2) Search:
   - Title: bartender OR "lead bartender" OR "head bartender" OR mixologist
   - Location: Los Angeles, CA
3) Apply filters:
   - Date posted: Last 30 days
   - “Easily apply” / “Apply directly”
   - Distance: start with ≤5–10 miles; verify commute time for each.
4) For each posting:
   - Open in a new tab. Capture venue/company name and address. If address missing, search “[venue] address Los Angeles” and confirm.
   - If venue/company matches the PAST EMPLOYERS list (allow minor spelling/punctuation differences), SKIP and log the reason.
   - Compute drive time from 1417 N Bronson Ave. Proceed if ≤15 minutes OR in West Hollywood OR venue is Belle’s Beach House or Jameson’s Santa Monica. Otherwise SKIP.
   - Confirm title (Bartender/Lead/Head/Mixologist). If not, SKIP.
5) Click “Easily apply”.
   - Use resume on file; if upload not available, PASTE the PLAINTEXT RESUME from the end of this prompt into the resume field.
   - Ensure contact email = timwhitebartending@gmail.com and phone = 732.668.2148.
6) Answer common questions (defaults):
   - Total bartending years: 7
   - Lead/supervisory behind bar: 3
   - High-volume (stadiums, 300+ covers, $10k+ nights): Yes
   - Craft cocktails/mixology: Advanced
   - POS: Toast POS (expert); KDS: implemented
   - Cash handling/closing: Yes
   - Availability: Nights/weekends/holidays; start immediately
   - Work authorization: Yes
   - CA RBS/LEAD: “Will obtain within 7 days”
   - Willing to commute: Yes, within 15 minutes; also West Hollywood; beach exceptions as above
   - Desired pay: “Open to discuss”; if single number required: 23
   - Will take barback shifts? No
   - Schedule preferences: Evenings, late nights, weekends
7) If a cover letter/“additional info” box appears, paste a tailored 3–5 sentence note:

   “Hi, I’m Tim White. I’ve run high-volume programs across Hollywood/Beverly Hills—managing 500+ guest nights and helping drive $20K+ evenings—while implementing Toast POS/KDS, training teams, and speeding service. I’ve led center-well and VIP service (Rose Bowl, comedy shows) and regularly push $10K+ event nights through upselling and fast, clean rounds. I’m available nights/weekends, can start immediately, and I’m happy to bring the same throughput and hospitality to [VENUE]. Instagram: https://instagram.com/timwhite”

8) Submit the application.
9) LOGGING: After each posting, append a row to a visible table with:
   Company | Venue (if different) | Job Title | Neighborhood/City | Drive Time (min) | Easy Apply? | Date Posted | Result (Submitted / Skipped + reason) | Link
10) Continue through all pages until no qualifying roles remain (last 30 days). Avoid duplicates.

PLAINTEXT RESUME (use if upload isn’t available)
Tim White | 732.668.2148 | https://instagram.com/timwhite | 1417 N Bronson Ave, Los Angeles, CA
Bartender / Lead Bartender / Bar Manager

Experience
- Bar Manager — Vault Speakeasy, Beverly Hills, CA (2024–Present)
  • Managed bar & kitchen ops for 500+ guests; boosted revenue to $20K+ nights while reducing headcount.
  • Implemented Toast POS & KDS; streamlined inventory/staffing with training and nightly pre-shifts; improved repeat guest rate.

- Lead Bartender — Kookabura Lounge, Hollywood, CA (2025–Present)
  • Drove $10K+ sales on event nights via rapid service & upselling; ran walk-up and service bar for 150-guest comedy shows.
  • Provided VIP green-room service for artists/comedians.

- Lead Bartender (VIP Lounge) — Rose Bowl, Pasadena, CA (2023–2024)
  • Center well in a 5-well VIP lounge; doubled sales vs any other well.
  • Managed inventory and POS closeout; ensured protocol compliance; featured in sponsor marketing.

- Bartender — St Felix, Hollywood, CA (2022–2023)
  • Custom craft cocktails from an extensive, mixology-heavy menu in a high-volume setting.
  • Covered tables during peak sports/corporate/VIP events.

- Bartender — National Bar Staffing, Los Angeles, CA (2021–2022)
  • Corporate events, movie premieres, VIP functions; mobile bar setup/breakdown; seamless high-volume service.

- Bartender — Alvarez & Co, Los Angeles, CA (2018–2021)
  • Adapted to upscale private events and large-scale festivals in high-pressure environments.

Selected Skills
High-volume cocktail service • Lead/center-well operations • Toast POS & KDS • Inventory & ordering • Staff training & pre-shifts • VIP & green-room service • Upselling & sales throughput • Rapid, clean rounds • Cash handling & closeout • Guest recovery & retention

BEHAVIOR RULES
- Always use/confirm login + contact email: timwhitebartending@gmail.com.
- Never follow external/ATS links; SKIP those jobs.
- Never apply to barback/server/FOH roles not explicitly bartender/lead/head/mixologist.
- Only apply to postings from the last 30 days.
- Enforce the commute/West Hollywood/beach exceptions. If skipped, record the reason.
- Do not apply to past employers listed above (allow spelling/punctuation variants).
- Be fast and accurate; no made-up credentials.
- Keep the live application LOG visible and updated after each submission.

END OF PROMPT
```

Want me to also generate a polished 1-page PDF resume for uploads?


**Topic:** [[chatgpt-clusters/personal_life]]
