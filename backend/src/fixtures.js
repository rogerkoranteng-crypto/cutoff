// FIXTURES. The PayPal sandbox holds zero disputes and its API cannot create one, so the queue below is
// invented: the buyers, amounts, deadlines and evidence. Dispute objects follow the shape of the Disputes API
// v1 schema (reason, stage, status, dispute_amount, seller_response_due_date) and carry `fixture: true`.
// Times are hours after the moment the board is seeded, so the board is always live.
import { HOUR, ceilQ, reflow } from './engine.js';

export const EVIDENCE = {
  tracking: { label: 'Carrier tracking', weight: 3, effortMin: 20 },
  delivery_proof: { label: 'Proof of delivery', weight: 4, effortMin: 45 },
  comms: { label: 'Buyer correspondence', weight: 2, effortMin: 30 },
  invoice: { label: 'Invoice and receipt', weight: 2, effortMin: 15 },
  policy: { label: 'Return and shipping policy', weight: 1, effortMin: 15 },
  listing: { label: 'Listing and photos', weight: 3, effortMin: 30 },
  login_history: { label: 'Login and device history', weight: 4, effortMin: 40 },
  prior_orders: { label: 'Prior orders by this buyer', weight: 2, effortMin: 25 },
  refund_trail: { label: 'Refund ledger', weight: 3, effortMin: 25 },
  billing_terms: { label: 'Billing agreement', weight: 2, effortMin: 20 },
};

const CHECKLIST = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: ['tracking', 'delivery_proof', 'comms', 'invoice', 'policy'],
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: ['listing', 'comms', 'invoice', 'policy', 'tracking'],
  UNAUTHORISED: ['login_history', 'prior_orders', 'invoice', 'delivery_proof'],
  CREDIT_NOT_PROCESSED: ['refund_trail', 'comms', 'invoice', 'policy'],
  DUPLICATE_TRANSACTION: ['refund_trail', 'invoice', 'billing_terms'],
  INCORRECT_AMOUNT: ['invoice', 'billing_terms', 'comms'],
  PAYMENT_BY_OTHER_MEANS: ['invoice', 'comms', 'refund_trail'],
  CANCELED_RECURRING_BILLING: ['billing_terms', 'comms', 'invoice'],
};

export function evidenceFor(reason, states = []) {
  const keys = CHECKLIST[reason] ?? ['invoice', 'comms'];
  return keys.map((k, i) => ({ key: k, ...EVIDENCE[k], state: states[i] ?? 'missing' }));
}

const R = 'ready', Q = 'requested', M = 'missing';

/** [id, buyer, reason, stage, amount, dueHours, evidenceStates] */
const SEED = [
  ['FX-D-1001', 'Rosalind Okafor', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'CHARGEBACK', 1840.0, 3.5, [R, M, M, R, R]],
  ['FX-D-1002', 'Tomasz Brandt', 'UNAUTHORISED', 'INQUIRY', 312.5, 6, [M, M, R, M]],
  ['FX-D-1003', 'Priya Venkataraman', 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED', 'CHARGEBACK', 689.0, 8, [R, Q, R, R, M]],
  ['FX-D-1004', 'Devon Whitlock', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'INQUIRY', 74.2, 14, [R, R, M, R, R]],
  ['FX-D-1005', 'Marguerite Aubry', 'UNAUTHORISED', 'PRE_ARBITRATION', 4890.0, 18, [Q, M, R, M]],
  ['FX-D-1006', 'Callum Reyes', 'CREDIT_NOT_PROCESSED', 'INQUIRY', 129.0, 26, [M, M, R, M]],
  ['FX-D-1007', 'Hana Ito', 'DUPLICATE_TRANSACTION', 'CHARGEBACK', 240.0, 31, [R, R, M]],
  ['FX-D-1008', 'Jerome Castellanos', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'INQUIRY', 58.0, 40, [M, M, M, R, R]],
  ['FX-D-1009', 'Ines Marchetti', 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED', 'INQUIRY', 415.0, 47, [M, M, R, R, M]],
  ['FX-D-1010', 'Oluwaseun Adeyemi', 'UNAUTHORISED', 'CHARGEBACK', 960.0, 53, [M, M, R, M]],
  ['FX-D-1011', 'Lars Hellström', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'ARBITRATION', 2150.0, 62, [R, Q, M, R, R]],
  ['FX-D-1012', 'Mei-Ling Tran', 'CREDIT_NOT_PROCESSED', 'INQUIRY', 36.0, 70, [M, M, R, R]],
];

/** Shift start, in hours after the seed hour, and skills. Shifts repeat daily and last nine hours. */
const HANDLERS = [
  ['h-kwame', 'Kwame Osei', 'KO', 'Delivery and returns', -4, ['delivery', 'product']],
  ['h-ingrid', 'Ingrid Sørensen', 'IS', 'Delivery and returns', 3, ['delivery', 'billing']],
  ['h-dev', 'Dev Patel', 'DP', 'Delivery and returns', 12, ['delivery', 'product', 'billing']],
  ['h-noor', 'Noor Aziz', 'NA', 'Fraud and unauthorised', -2, ['fraud', 'billing']],
  ['h-marcus', 'Marcus Tran', 'MT', 'Fraud and unauthorised', 6, ['fraud', 'delivery']],
  ['h-yuki', 'Yuki Hayashi', 'YH', 'Fraud and unauthorised', 14, ['fraud', 'product']],
  ['h-esi', 'Esi Boateng', 'EB', 'Escalations', -1, ['escalation', 'fraud', 'delivery', 'product', 'billing']],
  ['h-tomas', 'Tomás Ribeiro', 'TR', 'Escalations', 8, ['escalation', 'delivery', 'billing', 'product']],
];

export function buildHandlers(t0) {
  const hourOfDay = new Date(Math.floor(t0 / HOUR) * HOUR).getUTCHours();
  return HANDLERS.map(([id, name, initials, team, startOff, skills]) => ({
    id, name, initials, team, skills,
    shift: { startMin: (((hourOfDay + startOff) % 24) + 24) % 24 * 60, lengthMin: 9 * 60 },
    off: null,
  }));
}

export function buildDispute([id, buyer, reason, stage, amount, dueH, states], t0) {
  const createdAt = t0 - (stage === 'INQUIRY' ? 20 : stage === 'CHARGEBACK' ? 60 : 110) * HOUR;
  return {
    id, fixture: true, buyer, reason, stage,
    status: 'WAITING_FOR_SELLER_RESPONSE',
    amount: { value: amount, currency: 'USD' },
    createdAt, dueAt: ceilQ(t0 + dueH * HOUR),
    evidence: evidenceFor(reason, states),
    state: 'open', handlerId: null, start: null, end: null, pinned: false,
    invoiceId: null,
  };
}

export function seedBoard(now) {
  const t0 = ceilQ(now);
  const handlers = buildHandlers(t0);
  let disputes = SEED.map((row) => buildDispute(row, t0));
  const board = { handlers, disputes };
  // The opening schedule is the engine's own, so the board starts internally consistent.
  disputes = reflow(board, t0, { dirty: disputes.map((d) => d.id) }).disputes;
  return { handlers, disputes, seededAt: now };
}

/** An extra dispute for the "new dispute arrives" event. Pulled from a small pool, deterministic by index. */
const INCOMING = [
  ['Anneliese Vogt', 'UNAUTHORISED', 'CHARGEBACK', 1260.0, 7, [M, M, R, M]],
  ['Rahul Menon', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'CHARGEBACK', 845.0, 10, [R, M, M, R, M]],
  ['Chiara Bellandi', 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED', 'INQUIRY', 205.0, 18, [M, M, R, R, M]],
];
export function incomingDispute(n, now) {
  const row = INCOMING[n % INCOMING.length];
  const id = `FX-D-${1100 + n}`;
  return buildDispute([id, ...row], ceilQ(now));
}
