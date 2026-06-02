---
title: "Extract job experience"
type: note
created: 2025-11-10
updated: 2025-11-10
source: chatgpt-export
conversation_id: 691278db-d4f8-832e-899a-92b4d7199e5e
message_count: 2
tags: [chatgpt, import, code]
---
# Extract job experience

> Conversation ID: 691278db-d4f8-832e-899a-92b4d7199e5e
> Created: 2025-11-10T23:44:32Z
> Updated: 2025-11-10T23:44:44Z
> Messages: 2

---

## User

Extract the job experience into a JSON object.

---

## Assistant

Here’s the **job experience section** from the resume in the screenshot, extracted as structured JSON:  

```json
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
```

Would you like me to include **Education** and **References** sections in JSON format as well?
