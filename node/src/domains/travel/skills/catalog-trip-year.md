---
name: catalog-trip-year
domain: travel
requires: [timeline, gmail]
model: normal
maxTokens: 48000
status: automatable (lower-fidelity than a manual run — see "Two ways to run this")
---

# Skill: Catalog a Year of Trips

**Purpose:** turn a year's worth of Gmail (booking confirmations, receipts, card alerts, Uber receipts, planning threads) plus the Google Maps Timeline export into one markdown file per trip, in `<SNESTACK_BRAIN_ROOT>/travel/<year>/`, matching the established convention already used for 2021–2026.

**Parameters:** `subject` — a 4-digit year, e.g. `2024`.

## Two ways to run this

1. **`snestack travel catalog <year>`** — fully automated, end to end (one-time `snestack travel auth` needed first for Gmail OAuth; see node/README.md). `contextTools.ts`'s `gmail` tool runs a fixed set of broad searches (see `tools/gmailClient.ts`) for metadata + snippets on everything matched, then a bounded second pass fetches full bodies (HTML stripped, tracking links collapsed, capped length) for a deterministically-selected subset: one representative per thread, evidence-bearing categories only, marketing/loyalty/survey subjects excluded, capped at 60 messages total. **This closes most, but not all, of the gap with a manual run**: it still can't do a *second* round of searches triggered by what the first round found (e.g. searching for a specific confirmation number or hotel name once it turns up), can't read a thread outside the fixed candidate list no matter how promising it looks, and has no way to notice a longer trip hiding behind a short hotel stay (e.g. a 2-night hotel booking that turns out to sit inside a 10-day car-rental window — a manual run caught that once; this path won't, since nothing tells it to go looking for the car rental in the first place). Writes its output to `<SNESTACK_BRAIN_ROOT>/travel/<year>/.nightly-draft/`, deliberately **not** the canonical files — review and promote by hand (`mv`) rather than trusting it to overwrite a year you've already refined by hand. This is what `scripts/travel-catalog-nightly.sh` runs on a cron.
2. **Manual, in a Claude Code (or similar) session with real Gmail + Google Maps access** — run `snestack travel prep-catalog <year>` to get this skill body + the year's timeline clusters as one prompt, then do the actual Gmail search and reasoning interactively, with as many follow-up searches and full-thread reads as the trips need. This is how 2021–2024 were originally built and is still the higher-quality path for a year you want done right once. Nothing stops you from running the automated path first and using its `.nightly-draft/` output as a starting point for a manual pass.

Either way, update this file as your process improves — the point of "fat skills" is that the judgment lives here, not in a one-off chat prompt you'll forget next year.

## Inputs

- `timeline`: pre-clustered candidate "away from home" date ranges for the year, built deterministically from the Google Maps Timeline export (`travel/Timeline.json`). Each cluster is a run of visits, at least `TRIP_GAP_HOURS` (30h) apart from the next, with routine places already excluded (anywhere visited on 8+ distinct days across the whole export — home, work, gym, etc.; see `routinePlaceIds`). Each visit has a date, local time range, dwell duration, raw lat/lng, Google place ID, and a ready-made map link — but **no place name**. The dataset only covers `datasetCoversFrom`–`datasetCoversTo` (currently Aug 2024 onward); for dates outside that range, `timeline` will say so and you're working from email alone.
- `gmail`: an array of `{date, from, subject, snippet, threadId, messageId, matchedQuery, fullBody?}` from the fixed query set in `tools/gmailClient.ts` (flights, hotels, car rentals, dining reservations, rideshare receipts, foreign-transaction alerts, cancellations) for the year in question. Most entries are snippet-only (~150 characters) — for those, a date or detail that's ambiguous from the snippet alone stays ambiguous; say so in Gaps rather than guessing. A bounded subset (one representative per thread, capped at 60, from the evidence-bearing categories, with marketing/loyalty/survey subjects filtered out — see `selectFullBodyCandidates`) also carries `fullBody`: the actual email text, HTML stripped, long tracking-link tokens collapsed to `[long link omitted]`, capped at 3000 characters. **Use `fullBody` whenever it's present** — that's where the flight numbers, confirmation codes, exact dates, and nightly rates that a snippet truncates actually live. When running manually instead (see above), search Gmail yourself with the same breadth, and you're not limited to a fixed candidate list — read any full thread for anything ambiguous.

## Judgment process

1. Treat `gmail` (or your own search, if running manually) as the starting point, not the full picture — weekend trips and short work-adjacent trips get missed if you only look for the obvious "vacation" keywords, which is why the query set is broad on purpose.
2. Use the `timeline` clusters as a checklist: for every cluster, find the email trail that explains it (who, why, where). If a cluster has no matching email, still record it (see "Gaps") rather than silently dropping it — the Timeline saw you leave home for a reason.
3. Conversely, an email trip (flights booked, hotel confirmed) with no matching Timeline cluster either predates the Timeline's coverage window or simply wasn't captured — note that in Gaps rather than treating the absence as contradicting the email.
4. For each real trip, work out: dates and nights, who went (infer from booking names, party sizes, "for 2"/"for 4" language — don't guess beyond what the email actually supports), flights (carrier, flight number, route, confirmation code), where you stayed (place name, area, how many nights, booking source), a day-by-day narrative cross-referencing Timeline visit times against email/receipt timestamps, where you ate (restaurant names from reservations/receipts), activities and sights, hikes/walks specifically, shopping, and transportation used.
5. State an explicit confidence level per trip (High/Medium/Low) based on how much corroborating evidence you have (flight + hotel + receipts + Timeline = High; Timeline only = Low).
6. Always include a **Gaps** section per trip: what you looked for and couldn't find (hotel name, who else came, exact times) — this is what makes the file useful to correct later, and it's more valuable than silently omitting the unknown.
7. List sources per trip (which specific emails/receipts you used) so a later pass can be re-verified without re-searching from scratch.
8. Don't catalog single-day local outings (e.g. a day trip within driving range with no overnight) as trips — note them once in the year's index under "Day trips seen in Timeline" instead.
9. Note any booked-but-not-yet-taken trips (future travel visible in Gmail as of when you're running this) in the index under "Booked / upcoming."

## Output

**When running via `snestack travel catalog <year>`** (the automated path), a deterministic post-processor (`tools/fileWriter.ts`) splits your single response into separate files, so emit *everything* — every trip file and the index — in one response, each preceded by its own line of the exact form:

```
### FILE: <filename>
```

with no other text before the first marker and nothing between files but the next marker. Use bare filenames only (`2024-07-bandon-dunes.md`, `00-index-2024.md`), not paths — the writer places them under `<SNESTACK_BRAIN_ROOT>/travel/<year>/.nightly-draft/` itself. **When running manually** in a Claude Code session, write the files directly instead — the marker format is only for the automated path's benefit.

One markdown file per trip, e.g. `2024-07-bandon-dunes.md`, using this shape:

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
