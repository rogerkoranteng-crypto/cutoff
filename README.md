# Cutoff: a dispute triage board

**Live demo:** https://ddqromce4931r.cloudfront.net

**API:** https://lwel7o6fwk7ggyew7stqe4ahga0iqkcd.lambda-url.us-east-1.on.aws


One row per case handler. One block per PayPal dispute, laid against its response deadline. When the money changes (a dispute escalates, a deadline moves up, evidence arrives, a refund lands), an agent reassigns and reflows the board and writes down why.

Built for the PayPal AI Hackathon, **Best Use of Bryntum**. This project is about the scheduling and capacity problem: who works what, in which order, with how much time left, and what happens to the queue when something changes. It does not file evidence.

- Live site: see `.aws-out/urls.env` after `./deploy.sh`, or the URL in the submission.
- Licence of this repo: **MIT** (`LICENSE`). Bryntum is separate, see below.

## Bryntum: components, features, licence

**Licence in use: Bryntum's public trial packages (`@bryntum/*-thin-trial`, licence "Commercial", trial).** No hackathon-specific licence page could be found on bryntum.com, so the repo does not claim one. No key exists, so none is committed. `npm install` pulls the trial packages from the public npm registry through npm aliasing (`"@bryntum/scheduler-thin": "npm:@bryntum/scheduler-thin-trial@^7.3.7"`), which means moving to a purchased licence is a change to `web/package.json` only.

- The deployed site ships Bryntum's trial bundle, including its trial watermark. The trial clock is kept in the visitor's `localStorage` (`b-scheduler-trial-start`) and starts on first render.
- If the trial runs out in a browser, Bryntum throws on startup. Cutoff catches that (`ErrorBoundary`), says what happened, and keeps working: the **Queue** tab lists the same disputes and its Reassign form moves blocks through the same API. Tested by setting the trial start date 400 days back (`tools/expired.mjs`).
- To get a licence: https://bryntum.com/store, or a free trial at https://bryntum.com/download/.

**Components**

| Component | Where | Why it is there |
|---|---|---|
| Scheduler (`@bryntum/scheduler-thin`, React wrapper `scheduler-react-thin`) | Board tab | The product: handlers as rows, disputes as time blocks. |
| Calendar (`@bryntum/calendar-thin`, `calendar-react-thin`) | Deadline calendar tab | Day, week and agenda views of response deadlines, which the 72-hour timeline cannot show as a week. Opening a deadline jumps to its block. |

Gantt is not used. Dependencies between evidence-gathering steps do not change who works what, so it would earn nothing.

**Scheduler features used**: resource `group` (by team), `resourceTimeRanges` (each handler's off-shift stretches, including time off the agent reacts to), `timeRanges` (the current-time line), `eventDrag` with a `validatorFn` and a custom `tooltipTemplate`, `eventResize` (end edge only), async `beforeEventDropFinalize` and `beforeEventResizeFinalize` that round-trip to the Lambda and roll the block back if it refuses, `eventTooltip`, a custom `eventRenderer` that styles by state with text and a glyph, `renderData.ariaLabel`, hour-and-day view preset with 24-hour headers, `timeZone: UTC`, 15-minute snapping, three zoom levels, and in-place record updates so moved blocks animate.

**Two things that cost time and are not in the docs' happy path**
1. Regular `@bryntum/scheduler` and `@bryntum/calendar` cannot share a page ("The Bryntum Grid bundle was loaded multiple times"). The thin packages (`core-thin`, `engine-thin`, `grid-thin`, `scheduler-thin`, `calendar-thin`) can.
2. With the React wrapper the `features` prop is ignored; each feature is its own `<name>Feature` prop.

## What the board does

- **Board**: Scheduler with a block per dispute. Block colour, a glyph and words say On track, Near breach, Breach risk, In progress, Response sent. Amber diamonds mark each response deadline. Hatched stretches are off shift. Drag to reassign; the Lambda checks shift, overlap, skill and pinning and answers 422 with the reason, which appears in the drag tip before you drop.
- **Keyboard path to reassign**: *Jump to case* (toolbar) or *Open* in the Queue tab selects a case and moves focus to the case panel. There, *Handler* and *Start* are plain selects fed by `GET /api/disputes/:id/options`, which lists only starts the server will accept. Arrow keys also move between blocks once one has focus.
- **Case panel**: evidence checklist, hours of work left, the reassign form, pin, and the events below.
- **Change this case (fixture events)**: escalate a stage, pull a deadline in, evidence arrives, take a handler off shift, new dispute arrives. Staged, because the sandbox cannot create disputes. Labelled as such in the activity log.
- **Refund through PayPal (real sandbox)**: creates an invoice, records the payment and the refund. The board does not move on the click. It moves when PayPal's signed `INVOICING.INVOICE.REFUNDED` webhook arrives. If it has not arrived in 45 seconds the board reads the invoice itself and the log says the source was "PayPal API read (webhook had not arrived)".
- **What changed and why**: every run, with the model's explanation, the moves it made, and the tool calls behind them.

## The agent

Bedrock Converse, `us.anthropic.claude-sonnet-4-5-20250929-v1:0`, with six tools: `read_queue`, `read_capacity`, `assess_evidence`, `time_remaining`, `pick_assignee`, `reflow_schedule` (preview, then commit once). It loops up to 7 turns and may call tools in parallel.

The model chooses; the engine (`backend/src/engine.js`) enforces. Shifts, overlaps, mandatory skills (pre-arbitration and arbitration need the `escalation` skill), pinned blocks and in-progress blocks cannot be violated by anything the model says. The same engine file runs in the Lambda, in the rule-based fallback, in the tests and in the browser's drop validator.

**Bedrock rate limit disclosure.** The account allows roughly 10 requests a minute, shared with other projects. Each call uses the SDK's adaptive retry plus up to 50 seconds of our own backoff. If that is spent, or the daily cap (300 runs) is reached, the run finishes with the same engine and no model, and the log entry says "Rule-based reflow (reason)". It is a different explanation text and no tool trace, never a silent substitution. A typical live run takes 30 to 45 seconds.

## PayPal

- **One live dispute, 12 fixtures.** The board reads `GET /v1/customer/disputes` and also fetches the ids in `LIVE_DISPUTE_IDS` directly (`GET /v1/customer/disputes/{id}`), because the sandbox did not index a real dispute (`PP-R-IQQ-10190238`, filed by a sandbox buyer) into the list while the by-id read returned it. Live cases carry a LIVE tag and an amber edge; the other 12 are fixtures (`fixture: true`) because the API cannot create disputes. If PayPal has not set `seller_response_due_date` yet, the deadline is the create time plus 10 days and is labelled as an estimate; the next refresh replaces it. If a fetch fails, that id is listed in the PayPal tab and the log, and the board carries on with what it has. The seller has no action available while a dispute is under PayPal review, so nothing is filed.
- Invoicing v2: create, record payment, record refund. Never sent to a recipient.
- Webhooks: one subscription (8 event types). The listener verifies the signature with PayPal's `verify-webhook-signature` (falling back to a local RSA/CRC32 check against the PayPal certificate), answers 200 and hands the work to an asynchronous Lambda invocation. Deliveries meant for other apps on the same PayPal account are acknowledged and set aside.
- **Idempotency:** see the section below.
- Mutating calls carry a deterministic `PayPal-Request-Id` where the API honours it; webhook events are de-duplicated by event id.
- Reporting API (`/v1/reporting/transactions`) is not used (403).

## Finding: Invoicing v2 ignores `PayPal-Request-Id`

Checked live, not assumed: `POST /v2/invoicing/invoices` three times with the same `PayPal-Request-Id` (and once with a different body) created **three separate invoices**. The header that protects Orders or Payouts does nothing here, so a double-clicked Refund would refund twice.

What does work, also verified live:
- A deterministic `detail.invoice_number` per (session, dispute, amount, attempt). A repeat answers 422 `DUPLICATE_INVOICE_NUMBER`.
- Cutoff treats that as success, looks the invoice up with `POST /v2/invoicing/search-invoices`, and carries on.
- A repeated payment or refund then answers `CANNOT_PROCESS_PAYMENTS` / `CANNOT_PROCESS_REFUNDS`, also treated as "already done".
- The live test `a repeated refund request reuses the same sandbox invoice` asserts the invoice is refunded exactly once.

## Architecture

React + Vite on S3 behind CloudFront. `/api/*` goes to one Node 22 Lambda behind a Function URL (no API Gateway) that holds the PayPal secret as an environment variable. DynamoDB on-demand stores each visitor's board (header `X-Session`, 3-day TTL), agent runs, the webhook feed and de-duplication keys. Bedrock for the agent. `deploy.sh` is the whole deployment, plain `aws` CLI, idempotent.

```
./deploy.sh                          # AWS account 854924711083, us-east-1
cd backend && npm test               # unit + in-process HTTP tests
cd backend && npm run test:live      # real PayPal sandbox
cd backend && npm run test:deployed  # real deployed stack
cd web && npm run contrast           # measures the real colour pairs
```
Local preview: `node backend/scripts/dev-server.mjs` (port 8787, in-memory store, real PayPal read, real Bedrock) and `cd web && npx vite`.

## Accessibility, measured

Text is 17px (13pt) by default, never below 13.4px (10pt). Controls are at least 38px (28pt) tall. Everything is in `rem`, so 200% text reflows (panels stack, tables scroll inside a focusable region). Nothing is colour alone: every block carries a word ("Near breach"), a glyph ("!" or "!!") and, for breach, a hatch pattern; the case panel and queue table spell the status out. Focus rings are 3px. Reduced motion is respected. `CONTRAST.md` tabulates every text pair for both themes from the real hex values; all text pairs pass 4.5:1.

## Known limits

- The queue is fixtures; shifts are anchored to the hour a board is seeded so someone is always on shift.
- Bryntum's trial bundle is unminified (about 1.7 MB gzipped) and carries a watermark.
- Block text truncates on 1-hour blocks at the Compact zoom; the tooltip and queue carry the detail.
- Resize can only add time to a block, never take it below the work needed.
