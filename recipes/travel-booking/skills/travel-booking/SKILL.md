---
name: travel-booking
version: 0.1.0
description: Search, price, book and service flights, hotels and rental cars through the Jinko travel MCP server, using the brain for traveler preferences before searching and filing every confirmed booking as a trips/ page.
triggers:
  - "the user wants to find, compare, price or book a flight, hotel or rental car"
  - "the user wants to change, refund or cancel a booking"
  - "the user asks what travel is booked or coming up"
mutating: true
writes_pages: true
writes_to:
  - trips/
# Brain ops (MCP names). Travel tools come from the separate Jinko MCP server.
tools: [query, get_page, recall, remember, put_page, add_link, add_timeline_entry]
---

# Travel Booking: book with the brain's context, file what was booked

The Jinko MCP server (`https://mcp.builders.gojinko.com/mcp`) does the travel
work: live flight, hotel and car search, the trip cart, checkout and payment,
and refunds, exchanges and cancellations. The brain supplies who is
travelling and how they like to travel, and keeps the record afterwards.

The Jinko server sends its own instructions when the MCP session starts.
They are the reference for each tool's parameters and routing details; this
skill adds the brain steps and the rules that always apply.

## 1. Before searching: read the brain

Do this once per trip request, before the first travel tool call:

- `recall` / `query` the traveller's travel preferences: home airport, preferred
  and avoided airlines, seat, cabin, hotel style, loyalty programmes.
- `get_page people/<slug>` for every named companion, to resolve who they are.
  Do not take passport numbers, dates of birth or document details from the
  brain for a booking; ask the user for them at booking time.
- `query` for existing pages under `trips/` that overlap the dates, so a second
  booking for the same trip extends that page instead of creating a new one.

Use what you found as defaults, and say which ones you applied ("searching
from SFO, aisle seats, as usual"). Anything the user says in the request wins.

When the user states a lasting preference ("I never fly red-eyes"), use it for
this request. Save it only when the user asks you to remember it, or when the
brain's operator has turned on automatic capture: then call `remember` with one
claim, `kind: preference`, `entity` set to the person, `provenance` naming
where it came from (e.g. "user, travel request 2026-04-02"), and no `ttl`. Do
not save one-off details of this trip as facts; they belong on the trip page.

## 2. Pick the travel tool

| The user has… | Call |
|---|---|
| An origin, no destination | `find_destination` |
| Origin and destination, flexible dates | `flight_calendar` (price per date) or `find_dates` (short list of the best date options) |
| Origin, destination and exact dates | `flight_search` with `search` |
| An `offer_token` from a cached tool | `flight_search` with `price_check` |
| A route and dates to watch over time | `price_monitoring` (cache only; a `stale` answer is valid, do not fall back to a live search on your own) |
| A flight and wants to know if the price is good | `flight_price_advice` |
| A destination and dates for a stay | `hotel_search`, then `hotel_details` for one hotel |
| Pick-up and drop-off places and times for a car | `car_search`, only if it is in your tool list |
| A booking to look up | `get_booking` (`booking_ref`; add the traveller's `last_name` when looking it up as a guest) or `get_trip` (`trip_id`) |

Cached tools (`find_destination`, `flight_calendar`, `find_dates`,
`price_monitoring`) return indicative prices for one adult. Before presenting a
fare as bookable or adding it to a trip, confirm it live with `flight_search`.
A `flight_search` that answers `offer_unavailable` means that offer is gone:
show the alternatives it returns and let the user choose.

## 3. Book

1. `trip` with `add_item` and the token of the fare, rate or car the user chose.
   Flights, hotels and cars share one trip and one checkout.
2. `trip` with `upsert_travelers`. Traveller names, dates of birth and contact
   details come from the user, never from guesses or placeholders.
3. `checkout` with the `trip_id`. It returns a `checkout_url` and
   `agent_spt_params`.
4. Show the user the total (quote the `display` strings verbatim) and get an
   explicit yes before any payment.
5. Payment:
   - The user pays at `checkout_url`. The booking completes on its own after
     payment; there is no confirm call.
   - Or, when the user's platform can mint a Stripe Shared Payment Token scoped
     to `agent_spt_params`, call `submit_agent_payment`. If it answers
     `payment_status: requires_authentication` (3DS), the traveller completes
     the bank challenge through the returned `authentication_url`, built as the
     `submit_agent_payment` tool description says. A declined payment falls back to
     `checkout_url`.
6. `get_trip` until `fulfillment.status` shows the booking is confirmed. A
   `booking_ref` (`JNK-XXXXXX`) can appear before payment completes, so read the
   status rather than the presence of the reference.

## 4. After a confirmed booking: file it

Keep one page per trip, `trips/<yyyy-mm-dd>-<destination-slug>` (departure
date, first destination). Filing trips is what this skill was installed for;
if the user asks you not to record a trip, don't.

- **New trip:** `put_page` with the full content.
- **Existing trip page** (a second booking for the same trip, or a later
  change): `put_page` replaces the whole page. Read it first with `get_page`
  and `include_content: true`, merge your change into the full content, and
  send the revision it returned as `expected_revision`. On a revision conflict,
  read again and merge again.

Each booked item carries its own status; the page's `status` describes the trip
as a whole.

```markdown
---
title: Lisbon, 2026-05-14 to 2026-05-18
date: 2026-05-14
location: Lisbon
attendees: [people/alice-example, people/bob-example]
status: booked
booking_ref: JNK-ABC123
trip_id: trip_xxx
provider: jinko
---

# Lisbon, 2026-05-14 to 2026-05-18

Travellers: [[people/alice-example]], [[people/bob-example]]

## Flights (booked)
- 2026-05-14 TP 236 SFO 21:10 → LIS 15:25 (+1), economy, 1 checked bag each
- 2026-05-18 TP 237 LIS 11:00 → SFO 15:05

## Stay (booked)
- Hotel Example, 2026-05-15 to 2026-05-18, 1 room, free cancellation until 2026-05-12

## Paid
- USD 2,184.60 (checkout 2026-04-02)
```

- Record flight numbers, times, the hotel, the total paid, `booking_ref` and
  `trip_id`. Never write passport or ID numbers, dates of birth, card details,
  payment tokens or the API key.
- The `[[people/…]]` wikilinks in the body become mention links to existing
  pages; no typed edge is inferred from them. For a typed edge, call `add_link`
  from each traveller's page to the trip page with `link_type: attended`, the
  same direction gbrain uses for meeting attendees.
- Add one `add_timeline_entry` to each traveller's page
  (`date` = departure date, `summary` = "Trip to Lisbon", `source` = the trip
  slug).

## 5. Changes, refunds and cancellations

- Every servicing call takes the `booking_ref` and the `item_id` of the item
  being changed; guests also give the traveller's `last_name`.
- Always run the preview or quote step first, show the amount and any fee, and
  get an explicit yes before the commit step. `fee_known: false` means the fee
  is unknown, not zero.
- Flights: `flight_refund` (refund or void) and `flight_exchange` (shop → price
  → commit → status). Hotels: `hotel_cancel`. Cars: `car_cancel`; a rental
  cannot be modified, only cancelled and rebooked.
- After the change completes, update the trip page (read, merge, write with
  `expected_revision`, as in section 4): mark the changed item as exchanged
  (with its new segments), refunded or cancelled, with the amount returned.
  Set the page's `status` to `cancelled` only when every item is cancelled.

## Rules that always apply

- Never invent traveller data, and never drop or change a traveller to make a
  search succeed; surface the error instead.
- Do not retry in a loop. A `402` means the Jinko organisation's balance is too
  low: tell the user to top up at
  https://dashboard.gojinko.com/developers/billing/topup and do not retry. A
  `429` means back off, then retry once.
- Quote prices from the `display` fields verbatim; do not compute them.
- Do not print the API key or put it in a page, a log or a message.
