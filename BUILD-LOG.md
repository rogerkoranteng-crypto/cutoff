# BUILD-LOG: Cutoff (PayPal AI Hackathon, project 7 of 10, Bryntum prize)

Running log, newest at the bottom.

## 2026-10-02: recon, checked live

- Bryntum public npm: `@bryntum/scheduler` etc. are placeholder packages (MIT, 14 KB). The real code is on Bryntum's private registry. Public trial packages exist: `@bryntum/*-trial` (licence `Commercial`, trial). Thin variants exist too (`*-thin-trial`), plus React wrappers `@bryntum/scheduler-react-thin`, `@bryntum/calendar-react-thin`, `@bryntum/core-react-thin`.
- No hackathon-specific licence page found (bryntum.com/hackathon and a few guesses returned 404). Decision: use the public trial packages, say so in the README, commit no key (there is none), and build a fallback so the app is not blank if the trial stops rendering.
- Scheduler (regular) and Calendar (regular) cannot share a page: loading both throws "The Bryntum Grid bundle was loaded multiple times". Fixed by using the thin packages for both (shared `core-thin`, `engine-thin`, `grid-thin`). Found by running it, not by reading.
- React wrapper quirk: the `features` prop is silently ignored on `BryntumScheduler`; every feature is a `<name>Feature` prop (`groupFeature`, `timeRangesFeature`, ...). Found because `scheduler.initialConfig.features` only held `regionResize`.
- Grouped resource store: `store.records` contains group header rows. Removing "records not in my data" threw `Cannot read properties of undefined (reading 'meta')` until I skipped `isSpecialRow`.
- PayPal: token has `invoicing` and the four disputes scopes. `GET /v1/customer/disputes` -> 200 with `items: []`. Invoice flow without sending works: create draft -> `POST /payments` (BANK_TRANSFER) -> `POST /refunds`; invoice status becomes `MARKED_AS_REFUNDED`. `POST /send` fails (422 USER_NOT_FOUND on the fake invoicer), so the app never sends.
- Account already had webhooks from other projects; this app registers one more (8 event types).

## Design decisions

- One row per case handler, grouped by team, one work block per dispute, drawn against a deadline marker. Hour ticks, 24 h clock, everything in UTC.
- Shifts are anchored to the hour the board is seeded, so there are always people on shift at any time of day (tested at five different hours).
- Engine (`backend/src/engine.js`) is pure and shared: Lambda, agent tools, rule-based fallback, tests and the browser's drop validator all import the same file.
- Agent: Bedrock Converse tool loop (read_queue, read_capacity, assess_evidence, time_remaining, pick_assignee, reflow_schedule). The model picks among valid schedules; the engine refuses anything invalid. If Bedrock throttles, the same engine runs without the model and the run says so.
- Refund through PayPal creates a sandbox invoice, records a payment and a refund; the board only moves when the signed `INVOICING.INVOICE.REFUNDED` webhook arrives. If the webhook has not arrived after 45 s the board reads the invoice itself and labels the source.
- Per-visitor boards (X-Session header), TTL 3 days, reseeded after 20 hours.

## Backend built
- engine, fixtures, events, tools, agent, service, handler, store, paypal client, webhook verifier. Unit and in-process tests written alongside (see TEST-RESULTS.md).
- Dev server: `backend/scripts/dev-server.mjs` (in-memory store, real PayPal read, real Bedrock).
- First real Bedrock run (escalate FX-D-1009): 5 turns, 7 tool calls, about 40 s. The model once wrote "soft skills" in its explanation, copying the tool field name; renamed the tool fields to `mandatory` / `preferred`.

## Front end built (round 0)
- Scheduler with group, resource time ranges (off shift), current time line, tooltip, drag with a validator, resize (end edge only), async finalize that round-trips to the Lambda. Calendar tab (week/day/agenda) for deadlines. Queue table as the accessible twin of the board. PayPal tab with the webhook feed.
- Drag test against the dev server: dropping on a clash shows the reason in the drag tip and nothing is saved; a valid drop persists (`h-kwame` -> `h-ingrid` at 12:00).

## Deploy, live checks
- Deployed with `deploy.sh` (twice, idempotent). Real round trip proven: click Refund -> sandbox invoice -> signed `INVOICING.INVOICE.REFUNDED` verified through PayPal's API -> board reflowed by the agent. The captured delivery is saved as `backend/tests/fixtures/real-refunded-event.json` and used for the tamper tests.
- Found and fixed: Invoicing v2 ignores `PayPal-Request-Id` (3 calls -> 3 invoices). Idempotency now rests on a deterministic `invoice_number`.
- Found and fixed: an expired Bryntum trial blanks the whole React tree. Added an error boundary and the Queue tab as the working alternative.
- Local DNS cached CloudFront's name as missing for a few minutes after creation; the site was already up (checked through 8.8.8.8).

## Visual rounds (honest scores, out of 10)
- r1 (`shots/r1`, all 4 widths x 2 themes x 4 tabs): board clipped at five rows, summary tiles uneven, handler column ate the 360px width. Looked at 1280 light: 7.
- r2 (`shots/r2`, 360 and 1280, both themes): taller board, one-line summary. 1280 dark viewed: 8. Still: first view shows the board scrolling inside its frame at 900px tall; text on 1-hour blocks truncates to id and word.
- r3 (`shots/r3`, 360 light): handler column narrowed to avatar and first name. Viewed: 7.5, the timeline is usable but small.
- Not viewed by eye: 768 and 1920 in either theme, and the Queue, Calendar and PayPal tabs at 360/768 (they were screenshotted and checked for horizontal overflow and page errors only). I did not reach a genuine 9 on every view; the honest number is 8 on desktop, 7.5 on phone.

## Round 4/5 (coordinator review fixes)
- Block labels: the status line is dropped when a block is under 112px and the amount under 100px, so only whole fields render; the near/breach glyph moved to the id line so state survives at any width. Verified at Standard zoom: "1004" alone, "1001 $1,840 / Started" on the wider block.
- Stat tiles cut from five to three: money exposed (lead, amber), due in 24 hours, open.
- Timeline starts on an hour boundary (now minus 1h, floored), the "Now" header badge removed so it no longer covers hour labels.
- README: the Invoicing v2 / `PayPal-Request-Id` finding has its own section.
- Re-score from `shots/r5`: 1280 light 8.5; 360 light 7.5-8. Dark mode and 768/1920 were not re-shot after this change.

## Round 6/7 (phone layout)
- Phone: the explanatory paragraph is one short sentence plus the fixtures admission, with the rest under "How this works"; the board toolbar sits under "Board controls" and the legend under "What the colours mean" (open on desktop, closed under 641px); tabs are one row ("Calendar" replaces "Deadline calendar"); header trimmed. At 360px the first handler row and the first dispute block now appear inside the first 900px (`shots/r6`, `shots/r7`).
- All of `shots/r7` (4 widths x 2 themes x 4 tabs) was generated with no page overflow and no page errors. Looked at by eye: Board 360 light, Queue 360 dark, PayPal 360 light, Calendar 768 light. Found one cut word in the Calendar ("$415 On"), fixed by showing a word only for near-breach and breach events. Board 768/1920 and the dark variants of the other tabs were checked only for overflow and errors.
- Honest score: desktop 8.5, phone 8.

## Live dispute PP-R-IQQ-10190238
- Fetched by id (`LIVE_DISPUTE_IDS`, set by deploy.sh). When first read the list endpoint was empty; by the time of the live test it listed it too and had a real `seller_response_due_date` (22 Oct 17:00Z) and state REQUIRED_ACTION. Code handles both: list ∪ known ids, de-duplicated; estimated deadline only when PayPal gives none.
- Shown as a case with a LIVE tag, amber edge, buyer's message in the case panel; fixture-only buttons hidden for it. Per-id fetch failures are reported, never fatal (unit tested with a 404 id and a 500 read). `refreshLive` updates a live case's deadline, stage or amount and re-places it by rules.
- Nothing is sent to PayPal for it (no provide-evidence).
