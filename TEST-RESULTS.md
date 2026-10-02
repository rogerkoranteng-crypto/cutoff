# TEST-RESULTS

Real output, pasted from runs on 2026-10-02 03:59Z. Node v25.6.1.

## 1. Unit and in-process HTTP tests (`npm test`)

```
✔ GET /api/board seeds a session, labels the fixtures, and reports the live PayPal read (5.095586ms)
✔ dragging a block to a valid slot reassigns it in the store; an invalid drop is refused with a reason (4.608474ms)
✔ pinning stops a block from being dragged (3.810535ms)
✔ resize refuses a block shorter than its work and accepts extra time (2.365086ms)
✔ an event stores the new facts at once, then the agent run reflows and records an explanation (16.41989ms)
✔ with the model unavailable the run still finishes and is labelled rule-based (2.222338ms)
✔ an event the board cannot apply is refused without starting a run (0.871036ms)
✔ PayPal refund: the board waits for the signed webhook, and a replayed delivery changes nothing (3.186841ms)
✔ webhook: unsigned and tampered deliveries are rejected with 401 and never reach the board (1.689328ms)
✔ webhook events from other apps on the same PayPal account are acknowledged and ignored (1.134291ms)
✔ if the webhook never arrives, the board reads the invoice itself after 45 seconds and says so (2.730069ms)
✔ reset reseeds; time passing marks finished blocks as sent (2.879198ms)
✔ the agent loops through tools, commits once, and returns the model explanation (15.84386ms)
✔ the model can pin a dispute to a handler, and the engine refuses a handler without the skill (0.922711ms)
✔ a second commit is refused (1.463716ms)
✔ a throttled model falls back to the rules path and says so (0.930463ms)
✔ a model that never commits is cut off after the turn budget and the rules take over (2.723479ms)
✔ a model that commits but fails to explain still yields a grounded explanation from the moves (0.629657ms)
✔ bedrock.converseTurn retries a throttle with backoff and then gives up inside its budget (4007.899836ms)
✔ shift windows repeat daily and respect time off (2.118543ms)
✔ shift windows handle a shift that wraps past midnight (0.133784ms)
✔ placeEarliest skips busy intervals and never straddles a window (0.194637ms)
✔ the seeded board is internally consistent and has one block per open dispute (2.68565ms)
✔ every pre-arbitration or arbitration dispute is held by someone with the escalation skill (0.686599ms)
✔ seeding is the same shape at any time of day (2.474106ms)
✔ reflow with nothing dirty moves nothing (0.44781ms)
✔ an escalation that shortens the deadline moves the dispute and keeps the board valid (0.975905ms)
✔ a shortened deadline can displace a block with more slack (0.748633ms)
✔ a handler going off shift moves exactly the blocks inside the gap, onto people who are eligible (0.870878ms)
✔ evidence arriving shrinks the work and the readiness rises (0.574832ms)
✔ a full refund closes the dispute and removes it from the open queue; a partial one lowers the amount (10.338161ms)
✔ invalid events are refused with a reason (0.491837ms)
✔ dropProblems refuses overlaps, off-shift starts, the past, missing skills and pinned blocks (0.845347ms)
✔ validStarts only lists starts that dropProblems accepts (0.860093ms)
✔ pickAssignee excludes handlers without a mandatory skill and sorts by score (0.582683ms)
✔ time passing: finished blocks become sent responses (0.477023ms)
✔ stress: 200 random events never produce an overlap or an off-shift block (24.197435ms)
✔ a PayPal Disputes API object maps onto a board dispute (1.159951ms)
✔ request ids are stable for the same operation and differ when anything changes (0.634919ms)
✔ a duplicate request id is recognised as a repeat, not a failure (0.167763ms)
✔ refundedAmount sums the refund transactions on an invoice (0.993638ms)
✔ createRefundedInvoice sends the PayPal-Request-Id on create, then records payment and refund in order (1.214816ms)
✔ repeats are recognised in every shape PayPal reports them (0.136717ms)
✔ a repeated refund click finds the existing invoice by its number instead of creating a second one, and treats the finished steps as done (0.837496ms)
✔ the invoice number is deterministic per (session, dispute, amount, sequence) (0.633581ms)
✔ crc32 matches the standard check value (1.084827ms)
✔ a correctly signed payload verifies (2.228856ms)
✔ TAMPER: changing the refund amount after signing is rejected (0.914481ms)
✔ TAMPER: the wrong webhook id is rejected (a payload signed for another webhook) (0.739598ms)
✔ TAMPER: a payload signed with a different key is rejected (37.659825ms)
✔ a certificate URL off paypal.com is refused before any fetch (0.735836ms)
✔ a replayed transmission older than an hour is refused (0.671348ms)
✔ missing signature headers are refused (0.849722ms)
✔ verifyViaApi treats anything but SUCCESS as a rejection (1.107938ms)
ℹ tests 54
ℹ pass 54
ℹ fail 0
```

## 2. Live PayPal sandbox (`npm run test:live`)

```
✔ LIVE: OAuth works and the token carries the disputes and invoicing scopes (899.656361ms)
  sandbox disputes: 0
✔ LIVE: GET /v1/customer/disputes answers 200 (the sandbox holds none) and the read path reports it (474.720539ms)
✔ LIVE: a repeated refund request reuses the same sandbox invoice (deterministic invoice number) (4346.622331ms)
✔ LIVE: the captured PayPal delivery verifies locally against the real certificate (1300.260175ms)
✔ LIVE TAMPER: the same delivery with the refund amount changed fails local verification (775.479986ms)
  untouched -> SUCCESS
  tampered  -> PayPal verification_status FAILURE
✔ LIVE: PayPal's own verify-webhook-signature accepts the delivery and rejects the tampered copy (757.774591ms)
ℹ tests 6
ℹ pass 6
ℹ fail 0
```

## 3. Deployed stack (`npm run test:deployed`, CloudFront -> Lambda -> DynamoDB -> PayPal sandbox -> Bedrock)

```
  model: us.anthropic.claude-sonnet-4-5-20250929-v1:0
✔ DEPLOYED: the site and the API answer through CloudFront (1551.756514ms)
✔ DEPLOYED: a fresh board has 12 fixture disputes and reports the live PayPal read (1130.557916ms)
  engine=bedrock turns=3 steps=6 fallback=none
  explanation: FX-D-1003 deadline shortened from 8 hours 15 minutes to 4 hours 15 minutes away, now due at 08:15Z. The dispute remains with Esi Boateng in the 06:15Z to 07:45Z slot with 30 minutes of slack. Esi was the only handler who could meet the new deadline while maintaining all preferred skills for this product-related chargeback. No moves were needed as the existing schedule already accommodates the tighter window.
✔ DEPLOYED: a fixture event starts an agent run that finishes with an explanation and no overlaps (25458.675391ms)
✔ DEPLOYED: a drop that overlaps another block is refused, a valid one persists (2900.922075ms)
  log: s and its block comes off the board. Source: PayPal webhook, signature verified.
✔ DEPLOYED: refunding through PayPal moves the board only when the signed webhook arrives (27944.493356ms)
  tampered -> 401 {"error":"webhook rejected: PayPal verification_status FAILURE"}
✔ DEPLOYED TAMPER: an unsigned delivery, and a real delivery with its amount changed, are both refused with 401 (2738.531636ms)
  replay -> 200 (PayPal may refuse an hour-old transmission; 200 or 401 are both safe outcomes)
✔ DEPLOYED: a genuine delivery is acknowledged with 200 straight away (replay is later ignored as a duplicate) (658.805426ms)
ℹ tests 7
ℹ pass 7
ℹ fail 0
```

## 4. Browser end to end against the deployed site (`node tools/e2e.mjs <url>`)

```
ok   Scheduler rendered with 15 event elements
ok   resource groups rendered
ok   Jump to case moved focus to the case panel
ok   keyboard reassign persisted on the server
toast: FX-D-1004 reassigned to Ingrid Sørensen.
drag tip: 
ok   all tabs open
ok   no page errors
```

## 5. Trial-expiry fallback (`node tools/expired.mjs`, trial start set 400 days back)

```
    at f.onTrialExpired (https://ddqromce4931r.cloudfront.net/assets/index-Y4tE6J08.js:106:6672)
    at f.construct (https://ddqromce4931r.cloudfront.net/assets/in
warning Bryntum component failed to start: Toast is not defined
scheduler events in DOM: 0 | body text has expired: false
```

## 6. Contrast (`cd web && npm run contrast`)

```
> node scripts/contrast.mjs

| Deadline line against panel (3:1 non-text) | amber #ffb400 | surface #ffffff | 1.78:1 | 3:1 | low, backed by an outline and a word |
```

## 7. After adding the live dispute (unit, in-process and live PayPal)

```
ℹ tests 57
ℹ pass 57
ℹ fail 0
✔ LIVE: OAuth works and the token carries the disputes and invoicing scopes (2163.202393ms)
✔ LIVE: GET /v1/customer/disputes answers 200 (the sandbox holds none) and the read path reports it (1474.18931ms)
✔ LIVE: a repeated refund request reuses the same sandbox invoice (deterministic invoice number) (6298.407145ms)
✔ LIVE: the captured PayPal delivery verifies locally against the real certificate (1366.584628ms)
✔ LIVE TAMPER: the same delivery with the refund amount changed fails local verification (1473.857673ms)
✔ LIVE: PayPal's own verify-webhook-signature accepts the delivery and rejects the tampered copy (952.518085ms)
  list returned 1, by-id read returned 1
  due 2026-10-22T17:00:00.000Z estimated=false
✔ LIVE: the real sandbox dispute is reachable by id even though the list is empty, and maps onto a board case (1296.55091ms)
ℹ pass 7
ℹ fail 0
```
