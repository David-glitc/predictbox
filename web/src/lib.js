// Pure helpers (unit-tested). Mirrors the contract's states and payout math.
export const STATUS = ["Open", "Proposed", "Disputed", "Resolved"];
export const OUTCOME = ["None", "Yes", "No", "Invalid"];
export const PROPOSE_WINDOW = 3 * 86400, DISPUTE_WINDOW = 86400, ARBITER_TIMEOUT = 7 * 86400;
export const FEE_BPS = 200n; // 1% creator + 1% protocol

/** What the user can do next, given market struct fields (numbers as bigint/number) and the clock. */
export function phase(m, now) {
  const close = Number(m.closeTime), proposedAt = Number(m.proposedAt), disputedAt = Number(m.disputedAt);
  const s = STATUS[Number(m.status)];
  if (s === "Open") {
    if (now < close) return { key: "betting", label: "Betting open", until: close };
    if (now <= close + PROPOSE_WINDOW) return { key: "awaiting", label: "Awaiting creator proposal", until: close + PROPOSE_WINDOW };
    return { key: "expirable", label: "Abandoned - anyone can expire (refunds)" };
  }
  if (s === "Proposed") {
    return now < proposedAt + DISPUTE_WINDOW
      ? { key: "disputable", label: `Proposed ${OUTCOME[Number(m.proposed)]} - dispute window`, until: proposedAt + DISPUTE_WINDOW }
      : { key: "finalizable", label: `Proposed ${OUTCOME[Number(m.proposed)]} - ready to finalize` };
  }
  if (s === "Disputed") {
    return now > disputedAt + ARBITER_TIMEOUT ? { key: "expirable", label: "Arbiter silent - anyone can expire (refunds)" }
      : { key: "arbitrating", label: "Disputed - arbiter deciding", until: disputedAt + ARBITER_TIMEOUT };
  }
  return { key: "resolved", label: `Resolved: ${OUTCOME[Number(m.result)]}` };
}

/** Implied YES probability in percent from pool sizes (null if empty). */
export function impliedYes(yes, no) {
  const y = BigInt(yes), n = BigInt(no); if (y + n === 0n) return null;
  return Number((y * 10000n) / (y + n)) / 100;
}

/** Payout a stake would receive if its side wins, given current pools (after 2% fees). Wei bigint. */
export function projectedPayout(stake, side, yes, no) {
  const y = BigInt(yes), n = BigInt(no), s = BigInt(stake);
  const own = side === "yes" ? y : n; const poolAfter = own + s; const total = y + n + s;
  const prize = total - (total * FEE_BPS) / 10000n;
  return (s * prize) / poolAfter;
}

/** Filter bucket for the market grid, from a phase() result and the clock. */
export function bucket(ph, now) {
  if (ph.key === "betting") return ph.until - now < 2 * 86400 ? "closing" : "open";
  if (ph.key === "arbitrating") return "disputed";
  if (ph.key === "resolved") return "resolved";
  return "resolving"; // awaiting, disputable, finalizable, expirable
}
/** Whether a bucket belongs under a filter tab (closing-soon markets are also open). */
export const inFilter = (b, f) => f === "all" || b === f || (f === "open" && b === "closing");
