---
name: daily-agenda
domain: calendar
requires: [events]
model: cheap
---

# Skill: Daily Agenda Summary

**Purpose:** turn a raw list of calendar events into a short, useful summary of the day — what's on, any back-to-back conflicts, and any obviously light or heavy stretches.

**Parameters:** `subject` — `today`, `upcoming` (next 7 days), or an ISO date (`YYYY-MM-DD`)

## Inputs

- `events`: a JSON array of calendar events for the requested window, each with `summary`, `start`, `end`, `location`, `attendees`.

## Judgment process

1. If there are no events, say so plainly — don't invent a summary of an empty window.
2. List events in chronological order with their time and title.
3. Flag any two events that overlap or sit back-to-back with no gap between them — this is the highest-value thing to surface.
4. Note any large stretch of unscheduled time between events, but don't editorialize about how it should be used.
5. Keep it short. This is a scan of the day, not a report.

## Output

A brief agenda: the event list in order, any conflicts called out explicitly by name and time, and nothing speculative beyond what's actually on the calendar.
