'use strict';

// Warranty date maths. All dates are 'YYYY-MM-DD' strings; computed in UTC so the local
// timezone can never shift a day.

const EXPIRING_DAYS = 30;

function parts(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return { y, m, d };
}

function toISO(date) {
  return date.toISOString().slice(0, 10);
}

function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-based here
}

/**
 * Inclusive end date of a warranty of `months` calendar months starting on `start`.
 * Calendar-month addition minus one day; when the target month is shorter, the warranty
 * runs to the last day of that month.
 *   2026-10-18 + 12 → 2027-10-17
 *   2026-01-31 + 1  → 2026-02-28   (2028-01-31 + 1 → 2028-02-29)
 * Returns null when there is no warranty (months <= 0).
 */
function warrantyEnd(start, months) {
  if (!start || !Number.isInteger(months) || months <= 0) return null;
  const { y, m, d } = parts(start);
  const total = m - 1 + months;
  const ty = y + Math.floor(total / 12);
  const tm = (total % 12) + 1;
  const last = daysInMonth(ty, tm);
  if (d > last) return toISO(new Date(Date.UTC(ty, tm - 1, last)));
  return toISO(new Date(Date.UTC(ty, tm - 1, d - 1)));
}

function daysBetween(fromISO, toISOStr) {
  const a = parts(fromISO);
  const b = parts(toISOStr);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86400000);
}

/**
 * Status of a warranty on `today`: 'none' | 'active' | 'expiring' | 'expired'.
 * Active through the end date; expired from the next day. 'expiring' = active with
 * ≤ `expiringDays` (setting warranty_expiring_days, default 30) left.
 */
function warrantyStatus(end, today, expiringDays = EXPIRING_DAYS) {
  if (!end) return { status: 'none', days_left: null };
  const left = daysBetween(today, end);
  if (left < 0) return { status: 'expired', days_left: left };
  return { status: left <= expiringDays ? 'expiring' : 'active', days_left: left };
}

// Display status of a unit / bill line. Computed every time from the dates, the sale and the
// claims: never stored as the only source.
const UNIT_STATUS = {
  active: 'Active',
  expiring: 'Expiring soon',
  expired: 'Expired',
  under_claim: 'Under claim',
  replaced: 'Replaced',
  refunded: 'Refunded',
  void: 'Void',
  none: 'No warranty',
};

const VOID_REASONS = {
  physical_damage: 'Physical damage',
  water_damage: 'Water damage',
  tampered: 'Tampered / seal broken',
  wrong_fitting: 'Wrong fitting by customer',
  other: 'Other',
  sale_cancelled: 'Sale cancelled',
  returned: 'Returned (credit note)',
};

/**
 * Unit status, in priority order: void (warranty voided, sale cancelled / returned) →
 * replaced / refunded (closed by a claim) → under claim (an open claim) → by date.
 * { end, start, today, expiringDays, voidReason, closedAs: 'replaced'|'refunded'|null, openClaim }
 */
function unitStatus({
  end,
  start = null,
  today,
  expiringDays = EXPIRING_DAYS,
  voidReason = null,
  closedAs = null,
  openClaim = false,
}) {
  const dated = warrantyStatus(end, today, expiringDays);
  const base = {
    days_left: dated.days_left,
    date_status: dated.status,
    progress_bp: progressBp(start, end, today),
  };
  let status = dated.status;
  if (voidReason) status = 'void';
  else if (closedAs) status = closedAs;
  else if (openClaim) status = 'under_claim';
  return {
    ...base,
    status,
    label: UNIT_STATUS[status],
    void_reason: voidReason,
    void_label: voidReason ? VOID_REASONS[voidReason] || voidReason : null,
  };
}

/** Share of the warranty period used up, in basis points (0–10000), or null. */
function progressBp(start, end, today) {
  if (!start || !end) return null;
  const total = daysBetween(start, end) + 1;
  if (total <= 0) return 10000;
  const used = daysBetween(start, today) + 1;
  return Math.max(0, Math.min(10000, Math.round((used * 10000) / total)));
}

/**
 * Warranty of a replacement unit given on `today` for a claim received on `fromDate`.
 *  'remaining' (default): what was left of the old unit's warranty when the claim was received
 *     (old end − received date), counted again from today, so the customer does not lose the
 *     days the unit spent in the shop or at the supplier. Same day → the same end date.
 *  'fresh': a new full warranty of `months` from today.
 */
function replacementWarranty({ mode, oldEnd, months, today, fromDate = today }) {
  if (mode === 'fresh') {
    const end = warrantyEnd(today, months);
    return { start: end ? today : null, end };
  }
  if (!oldEnd) return { start: null, end: null };
  const left = daysBetween(fromDate, oldEnd);
  if (left < 0) return { start: today, end: oldEnd };
  return { start: today, end: addDays(today, left) };
}

function addDays(iso, days) {
  const { y, m, d } = parts(iso);
  return toISO(new Date(Date.UTC(y, m - 1, d + days)));
}

/** Last day of the month of `iso`. */
function monthEnd(iso) {
  const { y, m } = parts(iso);
  return toISO(new Date(Date.UTC(y, m - 1, daysInMonth(y, m))));
}

module.exports = {
  warrantyEnd,
  warrantyStatus,
  unitStatus,
  replacementWarranty,
  progressBp,
  daysBetween,
  addDays,
  monthEnd,
  EXPIRING_DAYS,
  UNIT_STATUS,
  VOID_REASONS,
};
