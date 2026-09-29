---
name: catalog-trip-year
domain: travel
requires: [timeline]
status: needs-gmail-access
---

# Skill: Catalog a Year of Trips

**Purpose:** turn a year's worth of Gmail (booking confirmations, receipts, card alerts, Uber receipts, planning threads) plus the Google Maps Timeline export into one markdown file per trip, in `<SNESTACK_BRAIN_ROOT>/travel/<year>/`, matching the established convention already used for 2025 and 2026.

**Parameters:** `subject` — a 4-digit year, e.g. `2024`.

**Where this runs:** this harness has no Gmail access wired up (see `node/src/domains/travel/contextTools.ts` — there is deliberately no `gmail` context tool). `snestack run-skill travel catalog-trip-year <year>` will assemble this skill with real `TIMELINE` context but the model will have no email to work from. Instead, run `snestack travel prep-catalog <year>` to generate a ready-to-paste prompt (this skill body + the year's timeline clusters), and paste it into a Claude session that actually has Gmail and Google Maps access. Update this file as your process improves — the point of "fat skills" is that the judgment lives here, not in a one-off chat prompt you'll forget next year.

## Inputs

- `timeline`: pre-clustered candidate "away from home" date ranges for the year, built deterministically from the Google Maps Timeline export (`travel/Timeline.json`). Each cluster is a run of visits, at least `TRIP_GAP_HOURS` (30h) apart from the next, with routine places already excluded (anywhere visited on 8+ distinct days across the whole export — home, work, gym, etc.; see `routinePlaceIds`). Each visit has a date, local time range, dwell duration, raw lat/lng, Google place ID, and a ready-made map link — but **no place name**. The dataset only covers `datasetCoversFrom`–`datasetCoversTo` (currently Aug 2024 onward); for dates outside that range, `timeline` will say so and you're working from email alone.
- Gmail, for the year in question — search yourself (this harness doesn't do this part): flight/hotel/rental-car confirmations, airline and hotel receipts, Uber/Lyft receipts, AmEx/card foreign-transaction alerts (domestic charges under ~$500 usually aren't itemized — expect thinner restaurant data for domestic trips), OpenTable/Resy reservations, planning threads with travel companions.

## Judgment process

1. Search Gmail broadly first (flight confirmations, "your trip", "reservation", "itinerary", hotel/Airbnb/Vrbo names, Uber receipts, card alerts) across the full year, not just obvious "vacation" keywords — weekend trips and short work-adjacent trips get missed if you only look for the obvious ones.
2. Use the `timeline` clusters as a checklist: for every cluster, find the email trail that explains it (who, why, where). If a cluster has no matching email, still record it (see "Gaps") rather than silently dropping it — the Timeline saw you leave home for a reason.
3. Conversely, an email trip (flights booked, hotel confirmed) with no matching Timeline cluster either predates the Timeline's coverage window or simply wasn't captured — note that in Gaps rather than treating the absence as contradicting the email.
4. For each real trip, work out: dates and nights, who went (infer from booking names, party sizes, "for 2"/"for 4" language — don't guess beyond what the email actually supports), flights (carrier, flight number, route, confirmation code), where you stayed (place name, area, how many nights, booking source), a day-by-day narrative cross-referencing Timeline visit times against email/receipt timestamps, where you ate (restaurant names from reservations/receipts), activities and sights, hikes/walks specifically, shopping, and transportation used.
5. State an explicit confidence level per trip (High/Medium/Low) based on how much corroborating evidence you have (flight + hotel + receipts + Timeline = High; Timeline only = Low).
6. Always include a **Gaps** section per trip: what you looked for and couldn't find (hotel name, who else came, exact times) — this is what makes the file useful to correct later, and it's more valuable than silently omitting the unknown.
7. List sources per trip (which specific emails/receipts you used) so a later pass can be re-verified without re-searching from scratch.
8. Don't catalog single-day local outings (e.g. a day trip within driving range with no overnight) as trips — note them once in the year's index under "Day trips seen in Timeline" instead.
9. Note any booked-but-not-yet-taken trips (future travel visible in Gmail as of when you're running this) in the index under "Booked / upcoming."

## Output

One markdown file per trip at `<SNESTACK_BRAIN_ROOT>/travel/<year>/<year>-<month>-<short-slug>.md`, e.g. `2024-07-bandon-dunes.md`, using this shape:

```markdown
# <Trip title> (<Month Year>)

**Dates:** <Day Mon D> – <Day Mon D, Year> (<N> nights)
**Who:** <names, and how you know — booking record, party size, etc.>
**Trip type:** <one line — purpose if known>
**Confidence:** <High|Medium|Low> (<what evidence backs this>)

## Flights
| Date | Flight | Route | Times | Notes |
|---|---|---|---|---|
...

## Where you stayed
| Nights | Place | Area | Source |
|---|---|---|---|---|
...

## Day by day
**<Day, date> — <headline>.** <narrative, cross-referencing Timeline times against email/receipt times>
...

## Where you ate
- <restaurant> · <restaurant> · ...

## Activities & sights
<prose or list>

## Hikes / walks
<specific hikes/walks, or "No formal hikes found.">

## Shopping
<if any>

## Transportation
<Uber/rental car/transit used>

## Gaps / to confirm
- <what's missing and what you'd need to fill it>

## Sources
- <specific emails/receipts referenced, with dates/confirmation codes>

## Google Maps Timeline — visits during this trip
_Place names aren't in the Timeline export; map links open the exact Google place. Town names are nearest-town approximations you infer from the coordinates._

| Date | Local time | Stay | Area (nearest town) | Map |
|---|---|---|---|---|
...
```

Short trips with thin evidence can drop sections that don't apply (e.g. no "Shopping" section) rather than padding with "none found" everywhere — match the amount of detail to the amount of real evidence.

Also write/update `<SNESTACK_BRAIN_ROOT>/travel/<year>/00-index-<year>.md`:

```markdown
# Trip Catalog — <year>

Built from Gmail (booking confirmations, receipts, card alerts, Uber receipts and conversations) and cross-checked against your Google Maps Timeline export, which covers <datasetCoversFrom> – <datasetCoversTo>.

## Trips taken in <year>
| Dates | Trip | Nights | File |
|---|---|---|---|
...

## Booked / upcoming (no files yet)
...

## Day trips seen in Timeline (not cataloged as trips)
...

## How to read each file
- **Confidence** says how well the email and Timeline data agree.
- **Timeline table:** your Timeline export has coordinates and Google place IDs but no place names. Each "map" link opens the exact place Google recorded. Town names are nearest-town approximations.
- Card alerts only list merchants for **foreign** purchases (and anything over $500), so international trips have much richer restaurant lists than domestic ones.
```
