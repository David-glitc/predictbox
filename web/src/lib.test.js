import { describe, it, expect } from "vitest";
import { phase, impliedYes, projectedPayout } from "./lib.js";
const m = (o) => ({ closeTime: 1000, proposedAt: 0, disputedAt: 0, status: 0, proposed: 0, result: 0, ...o });
describe("lib", () => {
  it("phases", () => {
    expect(phase(m({}), 500).key).toBe("betting");
    expect(phase(m({}), 1001).key).toBe("awaiting");
    expect(phase(m({}), 1000 + 3 * 86400 + 1).key).toBe("expirable");
    expect(phase(m({ status: 1, proposed: 1, proposedAt: 2000 }), 2100).key).toBe("disputable");
    expect(phase(m({ status: 1, proposed: 1, proposedAt: 2000 }), 2000 + 86400).key).toBe("finalizable");
    expect(phase(m({ status: 2, disputedAt: 2000 }), 2100).key).toBe("arbitrating");
    expect(phase(m({ status: 2, disputedAt: 2000 }), 2000 + 8 * 86400).key).toBe("expirable");
    expect(phase(m({ status: 3, result: 2 }), 0).label).toBe("Resolved: No");
  });
  it("implied yes", () => { expect(impliedYes(0n, 0n)).toBeNull(); expect(impliedYes(3n, 1n)).toBe(75); });
  it("projected payout matches the contract example", () => {
    // pools 4 yes / 1 no; a new 1 YES stake: total 6, prize 5.88, own pool 5 -> 1.176
    expect(projectedPayout(10n ** 18n, "yes", 4n * 10n ** 18n, 10n ** 18n)).toBe(1176000000000000000n);
  });
});
