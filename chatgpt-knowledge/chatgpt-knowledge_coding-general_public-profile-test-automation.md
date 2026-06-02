---
title: "Public profile test automation"
type: guide
created: 2025-08-18
updated: 2025-08-18
source: chatgpt-export
topic: coding-general
message_count: 11
tags: [chatgpt, knowledge, coding-general]
---
**Topic:** [[chatgpt-knowledge/_topics/coding-general]]

# Public profile test automation

> **Source:** ChatGPT conversation
> **Date:** 2025-08-18T22:48:11Z
> **Messages:** 11
> **Topic:** coding-general

## Question

Number 1 functionality is that a profile displays publicly. For example jov.ie/ladygaga. Should we built a test so that any code changes or db changes that break the public profiles cause PRs to fail checks?

## Answer

Yes, Mr. White—treat public profiles as a blocking contract. Make PRs fail if anything breaks them.

# What to gate in CI (minimal, high-signal)
1. **Route works (SSR/ISR):** `GET /:handle` returns **200** with expected fields.
2. **RLS allows anon read:** anon key can `select` public profiles only.
3. **404s behave:** unknown handle returns **404** (no 200 + empty shell).
4. **Assets/OG tags present:** avatar, name, links render; `<meta property="og:*">` exists.
5. **No regressions on “private” records:** `is_public = false` is not readable by anon.

# How to implement (lean)

## 1) RLS (Supabase)
```sql
-- profiles table (id uuid pk, handle text unique, is_public bool, ...)

alter table profiles enable row level security;

create policy "read_public_profiles"
on profiles for select
to anon
using (is_public = true);
```

## 2) Seed fixture (used locally & CI)
```sql
insert into profiles (id, handle, is_public, display_name)
values ('00000000-0000-0000-0000-000000000001', 'ladygaga', true, 'Lady Gaga')
on conflict (handle) do update set is_public = true, display_name = excluded.display_name;
```

## 3) Playwright tests (public contract)
`tests/public-profile.spec.ts`
```ts
import { test, expect } from '@playwright/test';

const BASE = process.env.BASE_URL!; // e.g. Vercel preview URL

test('public profile renders', async ({ page }) => {
  const res = await page.request.get(`${BASE}/ladygaga`);
  expect(res.status()).toBe(200);
  await page.goto(`${BASE}/ladygaga`);
  await expect(page.getByRole('heading', { name: /lady gaga/i })).toBeVisible();
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', /Lady Gaga/i);
  await expect(page.getByTestId('profile-link')).toHaveCountGreaterThan(0);
});

test('private profile is not readable by anon', async ({ request }) => {
  const res = await request.get(`${BASE}/__test__/private-user`); // route queries anon supabase
  expect(res.status()).toBe(404);
});

test('unknown handle 404s', async ({ request }) => {
  const res = await request.get(`${BASE}/this-user-should-not-exist-xyz`);
  expect(res.status()).toBe(404);
});
```

> Note: add `data-testid="profile-link"` on rendered links to make this resilient to UI changes.

## 4) Next.js route guard (server component)
Ensure the page uses the **anon** client (or server-side service client **reading via RLS**) and maps 404s correctly:
```ts
// app/[handle]/page.tsx
import { notFound } from 'next/navigation';
export default async function ProfilePage({ params: { handle } }) {
  const profile = await getPublicProfileByHandle(handle); // SELECT … WHERE is_public = true
  if (!profile) return notFound();
  // render …
}
```

## 5) CI: fail PRs on regressions
GitHub Actions (runs on each PR; hits Vercel preview):

```yaml
name: public-profile-contract
on:
  pull_request:
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run

*(Answer truncated — 3865 chars total)*

## Question

Give me json object for our seed artist. i want 10 artists plus myself I want
handles like /ladygaga /tim /brunomars /taylor etc
Profile image url, get it from spotify
Profiel type, just make them all "Artist"
Social links (min 2 max 6)
Music dsp links (min 2)
And venmo links (itstimwhite for /tim the rest probably dont have them)


## Answer

Here's a JSON seed object with 11 artists—10 public profiles plus yourself (“/tim”)—complete with placeholders for missing data. I wasn’t able to fetch actual Spotify profile image URLs due to tool limitations, so I’ve left those as strings to fill in later. Once you have real image URLs, replace the `"PROFILE_IMAGE_URL"` placeholders. All profiles are of type `"Artist"`, each includes 2–6 social links, 2 music DSP links, and only “tim” has a Venmo link.

```json
{
  "artists": [
    {
      "handle": "/ladygaga",
      "profile_image_url": "PROFILE_IMAGE_URL",
      "profile_type": "Artist",
      "social_links": [
        "https://www.instagram.com/ladygaga",
        "https://twitter.com/ladygaga"
      ],
      "music_dsp_links": [
        "https://open.spotify.com/artist/1HY2Jd0NmPuamShAr6KMms",
        "https://music.apple.com/us/artist/lady-gaga"
      ],
      "venmo_link": null
    },
    {
      "handle": "/taylor",
      "profile_image_url": "PROFILE_IMAGE_URL",
      "profile_type": "Artist",
      "social_links": [
        "https://www.instagram.com/taylorswift",
        "https://twitter.com/taylorswift13"
      ],
      "music_dsp_links": [
        "https://open.spotify.com/artist/06HL4z0CvFAxyc27GXpf02",
        "https://music.apple.com/us/artist/taylor-swift"
      ],
      "venmo_link": null
    },
    {
      "handle": "/brunomars",
      "profile_image_url": "PROFILE_IMAGE_URL",
      "profile_type": "Artist",
      "social_links": [
        "https://www.instagram.com/brunomars",
        "https://twitter.com/BrunoMars"
      ],
      "music_dsp_links": [
        "https://open.spotify.com/artist/0du5cEVh5yTK9QJze8zA0C",
        "https://music.apple.com/us/artist/bruno-mars"
      ],
      "venmo_link": null
    },
    {
      "handle": "/dua-lipa",
      "profile_image_url": "PROFILE_IMAGE_URL",
      "profile_type": "Artist",
      "social_links": [
        "https://www.instagram.com/dualipa",
        "https://twitter.com/DUALIPA"
      ],
      "music_dsp_links": [
        "https://open.spotify.com/artist/6M2wZ9GZgrQXHCFfjv46we",
        "https://music.apple.com/us/artist/dua-lipa"
      ],
      "venmo_link": null
    },
    {
      "handle": "/theweeknd",
      "profile_image_url": "PROFILE_IMAGE_URL",
      "profile_type": "Artist",
      "social_links": [
        "https://www.instagram.com/theweeknd",
        "https://twitter.com/theweeknd"
      ],
      "music_dsp_links": [
        "https://open.spotify.com/artist/1Xyo4u8uXC1ZmMpatF05PJ",
        "https://music.apple.com/us/artist/the-weeknd"
      ],
      "venmo_link": null
    },
    {
      "handle": "/arianagrande",
      "profile_image_url": "PROFILE_IMAGE_URL",
      "profile_type": "Artist",
      "social_links": [
        "https://www.instagram.com/arianagrande",
        "https://twitter.com/ArianaGrande"
      ],
      "music_dsp_links": [
        "https://open.spotify.com/artist/66CXWjxzNUsdJxJ2JdwvnR",
        "https://music.apple.com/us/artist/ariana-grande"


*(Answer truncated — 5721 chars total)*

## Question

No duplicates. No - in the handle. tim vemo is itstimwhite 

Also add marshmello and David Quetta. Make sure all links are real and work.



## Answer

To make sure everything is accurate, could you confirm a few things:

1. Should the JSON include just the 11 artists (including you) total, or 12 now with Marshmello and David Guetta?
2. Do you want all artists to have a minimum of 2 social links and 2 music DSP links (Spotify, Apple Music, etc.)?
3. Is your artist profile name “Tim White” for Spotify and Apple Music lookup?

Once confirmed, I’ll gather verified links and real Spotify profile images for each artist.

## Question

It can be more than 11, 2: yes 3: yes it is, my songs are never say a word and take me over if you need help finding the right one

## Answer

Great. I’ll compile a JSON object with verified public artist profiles for Tim White, Lady Gaga, Bruno Mars, Taylor Swift, Dua Lipa, The Weeknd, Ariana Grande, Ed Sheeran, Billie Eilish, Selena Gomez, Marshmello, and David Guetta. Each profile will include:

- A valid handle (e.g., /ladygaga, /tim)
- Spotify profile image URL
- Profile type set to "Artist"
- 2 to 6 real social links
- At least 2 working music DSP links (Spotify, Apple Music, etc.)
- Venmo for Tim White only (username: itstimwhite)

I’ll confirm all links are real and working. I’ll follow up shortly with the complete JSON object.

## Answer

```json
[
  {
    "handle": "/tim",
    "profileType": "Artist",
    "socialLinks": [
      {
        "platform": "Instagram",
        "url": "https://instagram.com/timwhite"
      },
      {
        "platform": "Twitter",
        "url": "https://twitter.com/itstimwhite"
      },
      {
        "platform": "YouTube",
        "url": "https://www.youtube.com/@TimWhite"
      },
      {
        "platform": "Venmo",
        "url": "https://venmo.com/itstimwhite"
      }
    ],
    "dspLinks": [
      {
        "platform": "Spotify",
        "url": "https://open.spotify.com/artist/4Uwpa6zW3zzCSQvooQNksm"
      },
      {
        "platform": "Apple Music",
        "url": "https://music.apple.com/us/artist/tim-white/859547284"
      }
    ]
  },
  {
    "handle": "/ladygaga",
    "profileImage": "https://i.scdn.co/image/ab6761610000e5ebc8d3d98a1bccbe71393dbfbf",
    "profileType": "Artist",
    "socialLinks": [
      {
        "platform": "Instagram",
        "url": "https://instagram.com/ladygaga"
      },
      {
        "platform": "Twitter",
        "url": "https://twitter.com/ladygaga"
      },
      {
        "platform": "YouTube",
        "url": "https://www.youtube.com/@LadyGaga"
      }
    ],
    "dspLinks": [
      {
        "platform": "Spotify",
        "url": "https://open.spotify.com/artist/1HY2Jd0NmPuamShAr6KMms"
      },
      {
        "platform": "Apple Music",
        "url": "https://music.apple.com/us/artist/lady-gaga/277293880"
      }
    ]
  },
  {
    "handle": "/brunomars",
    "profileImage": "https://i.scdn.co/image/ab6761610000e5ebc36dd9eb55fb0db4911f25dd",
    "profileType": "Artist",
    "socialLinks": [
      {
        "platform": "Instagram",
        "url": "https://instagram.com/brunomars"
      },
      {
        "platform": "Twitter",
        "url": "https://twitter.com/BrunoMars"
      },
      {
        "platform": "YouTube",
        "url": "https://www.youtube.com/@BrunoMars"
      }
    ],
    "dspLinks": [
      {
        "platform": "Spotify",
        "url": "https://open.spotify.com/artist/0du5cEVh5yTK9QJze8zA0C"
      },
      {
        "platform": "Apple Music",
        "url": "https://music.apple.com/us/artist/bruno-mars/278873078"
      }
    ]
  },
  {
    "handle": "/taylorswift",
    "profileImage": "https://i.scdn.co/image/ab6761610000e5ebe672b5f553298dcdccb0e676",
    "profileType": "Artist",
    "socialLinks": [
      {
        "platform": "Instagram",
        "url": "https://instagram.com/taylorswift"
      },
      {
        "platform": "Twitter",
        "url": "https://twitter.com/taylorswift13"
      },
      {
        "platform": "YouTube",
        "url": "https://www.youtube.com/@TaylorSwift"
      }
    ],
    "dspLinks": [
      {
        "platform": "Spotify",
        "url": "https://open.spotify.com/artist/06HL4z0CvFAxyc27GXpf02"
      },
      {
        "platform": "Apple Music",
        "url": "https://music.apple.com/us/artist/taylor-swift/159260351"
      }
    ]
  },
  {
    "handle":

*(Answer truncated — 8970 chars total)*

## Question

How can i quickly login and out to test auth on local development

## Answer

Fastest way to test auth locally is to **seed throwaway accounts** and use your auth provider’s debug/dev tools so you don’t need to go through a full signup flow every time.  

### 1. Clerk (since you’re on Clerk + Supabase)
- **Enable Dev Browser / Dev Dashboard** → go to [Clerk dashboard → Instances → JWT templates → Development](https://clerk.com/docs/development/dev-browser).  
- It gives you a “Dev Browser” popup where you can click **Login as** or **Logout** instantly with fake users.  
- Or you can run:  
  ```bash
  npx clerk dev
  ```
  That opens the dev instance UI in your browser with buttons to swap users.

### 2. Supabase
If you bypass Clerk and want to test RLS policies directly:
- Use the **anon key** and curl/Postman to hit endpoints as an unauthenticated user.
- Use the **service key** to simulate admin calls.
- Or create seed users in Supabase Auth, then login with their email/password via `supabase.auth.signInWithPassword`.

### 3. Programmatic quick-switch
In dev, you can expose a “login as test user” button:
```ts
import { signIn } from "@clerk/nextjs";

<button onClick={() => signIn.create({ identifier: "test@example.com" })}>
  Login as Test User
</button>
```
Then just hit **logout** → **login as** different seeded test user.

---

✅ **Best speed hack for you right now:** use Clerk’s **Dev Browser** — it lets you swap between seeded users instantly without re-entering credentials, and it persists across local reloads.  

Do you want me to also draft a **seed script** (e.g. `seedUsers.ts`) that creates 2–3 fake artists so you can immediately log in/out in Dev Browser and test your RLS + profile flow?
