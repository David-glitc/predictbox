const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const E = ethers.parseEther;
const YES = 1, NO = 2, INVALID = 3;
const BOND = E("1");

describe("PredictBox", () => {
  let pb, arbiter, treasury, creator, a, b, c, disputer, closeTime;
  beforeEach(async () => {
    [arbiter, treasury, creator, a, b, c, disputer] = await ethers.getSigners();
    pb = await ethers.deployContract("PredictBox", [arbiter.address, treasury.address]);
    closeTime = (await time.latest()) + 7200;
    await pb.connect(creator).createMarket("Will X ship?", closeTime, { value: BOND });
  });
  const bal = (s) => ethers.provider.getBalance(s.address);
  async function claimGain(s, id = 1) {
    const before = await bal(s);
    const tx = await pb.connect(s).claim(id); const r = await tx.wait();
    return (await bal(s)) - before + r.gasUsed * r.gasPrice;
  }
  async function stakeAndClose() {
    await pb.connect(a).bet(1, true, { value: E("3") });
    await pb.connect(b).bet(1, false, { value: E("1") });
    await pb.connect(c).bet(1, true, { value: E("1") });
    await time.increaseTo(closeTime);
  }

  it("validates creation", async () => {
    await expect(pb.connect(a).createMarket("q", closeTime, { value: E("0.01") })).to.be.revertedWithCustomError(pb, "BadParam");
    await expect(pb.connect(a).createMarket("", closeTime, { value: BOND })).to.be.revertedWithCustomError(pb, "BadParam");
    await expect(pb.connect(a).createMarket("q", (await time.latest()) + 10, { value: BOND })).to.be.revertedWithCustomError(pb, "BadParam");
    await expect(pb.connect(a).createMarket("q", (await time.latest()) + 400 * 86400, { value: BOND })).to.be.revertedWithCustomError(pb, "BadParam");
    expect(await pb.marketCount()).to.equal(1);
  });

  it("betting rules: creator barred, minimum, closes at closeTime", async () => {
    await expect(pb.connect(creator).bet(1, true, { value: E("1") })).to.be.revertedWithCustomError(pb, "NotAllowed");
    await expect(pb.connect(a).bet(1, true, { value: 1 })).to.be.revertedWithCustomError(pb, "BadParam");
    await expect(pb.connect(a).bet(9, true, { value: E("1") })).to.be.revertedWithCustomError(pb, "BadParam");
    await time.increaseTo(closeTime);
    await expect(pb.connect(a).bet(1, true, { value: E("1") })).to.be.revertedWithCustomError(pb, "TooLate");
  });

  it("undisputed YES: fees, pro-rata payouts, bond back, solvency", async () => {
    await stakeAndClose();
    await expect(pb.connect(creator).propose(1, YES)).to.emit(pb, "Proposed");
    await expect(pb.finalize(1)).to.be.revertedWithCustomError(pb, "TooEarly");
    await time.increase(86400);
    await pb.finalize(1);
    // pool 5, fees 1%+1% = 0.1, prize 4.9 split 3:1 between a and c
    expect(await claimGain(a)).to.equal(E("4.9") * 3n / 4n);
    expect(await claimGain(c)).to.equal(E("4.9") / 4n);
    await expect(pb.connect(b).claim(1)).to.be.revertedWithCustomError(pb, "Nothing");
    await expect(pb.connect(a).claim(1)).to.be.revertedWithCustomError(pb, "Nothing");
    await pb.connect(creator).withdraw();
    await pb.connect(treasury).withdraw();
    expect(await ethers.provider.getBalance(await pb.getAddress())).to.be.lt(10n); // dust only
  });

  it("only creator proposes, inside the window", async () => {
    await stakeAndClose();
    await expect(pb.connect(a).propose(1, YES)).to.be.revertedWithCustomError(pb, "NotAllowed");
    await expect(pb.connect(creator).propose(1, 0)).to.be.revertedWithCustomError(pb, "BadParam");
    await time.increase(3 * 86400 + 1);
    await expect(pb.connect(creator).propose(1, YES)).to.be.revertedWithCustomError(pb, "TooLate");
  });

  it("cannot propose before close", async () => {
    await expect(pb.connect(creator).propose(1, YES)).to.be.revertedWithCustomError(pb, "TooEarly");
  });

  it("dispute needs the exact bond and the window", async () => {
    await stakeAndClose();
    await pb.connect(creator).propose(1, YES);
    await expect(pb.connect(disputer).dispute(1, { value: E("0.5") })).to.be.revertedWithCustomError(pb, "BadParam");
    await time.increase(86400);
    await expect(pb.connect(disputer).dispute(1, { value: BOND })).to.be.revertedWithCustomError(pb, "TooLate");
  });

  it("dispute upheld: creator slashed, disputer paid, outcome flipped", async () => {
    await stakeAndClose();
    await pb.connect(creator).propose(1, YES); // creator lies
    await pb.connect(disputer).dispute(1, { value: BOND });
    await expect(pb.connect(a).arbitrate(1, NO)).to.be.revertedWithCustomError(pb, "NotAllowed");
    await expect(pb.finalize(1)).to.be.revertedWithCustomError(pb, "WrongState");
    await pb.connect(arbiter).arbitrate(1, NO);
    expect(await pb.credits(disputer.address)).to.equal(E("1.5"));
    expect(await pb.credits(treasury.address)).to.equal(E("0.5") + E("0.05"));
    expect(await pb.credits(creator.address)).to.equal(E("0.05")); // only the creator fee, bond lost
    expect(await claimGain(b)).to.equal(E("4.9")); // sole NO bettor
    await expect(pb.connect(a).claim(1)).to.be.revertedWithCustomError(pb, "Nothing");
  });

  it("dispute rejected: disputer loses bond to creator", async () => {
    await stakeAndClose();
    await pb.connect(creator).propose(1, YES);
    await pb.connect(disputer).dispute(1, { value: BOND });
    await pb.connect(arbiter).arbitrate(1, YES);
    expect(await pb.credits(creator.address)).to.equal(E("2") + E("0.05"));
    expect(await pb.credits(disputer.address)).to.equal(0);
    expect((await pb.getMarket(1)).result).to.equal(YES);
  });

  it("arbiter can rule INVALID: refunds, no fees, creator slashed", async () => {
    await stakeAndClose();
    await pb.connect(creator).propose(1, YES);
    await pb.connect(disputer).dispute(1, { value: BOND });
    await pb.connect(arbiter).arbitrate(1, INVALID);
    expect(await claimGain(a)).to.equal(E("3"));
    expect(await claimGain(b)).to.equal(E("1"));
    expect(await claimGain(c)).to.equal(E("1"));
    expect(await pb.credits(creator.address)).to.equal(0);
  });

  it("abandoned market: anyone expires it, stakers refunded, bond forfeited", async () => {
    await stakeAndClose();
    await expect(pb.expire(1)).to.be.revertedWithCustomError(pb, "TooEarly");
    await time.increase(3 * 86400 + 1);
    await pb.expire(1);
    expect(await pb.credits(treasury.address)).to.equal(BOND);
    expect(await claimGain(a)).to.equal(E("3"));
    await expect(pb.expire(1)).to.be.revertedWithCustomError(pb, "WrongState");
  });

  it("arbiter silent: dispute expires after 7 days, bonds returned, refunds", async () => {
    await stakeAndClose();
    await pb.connect(creator).propose(1, YES);
    await pb.connect(disputer).dispute(1, { value: BOND });
    await time.increase(7 * 86400 - 5);
    await expect(pb.expire(1)).to.be.revertedWithCustomError(pb, "TooEarly");
    await time.increase(10);
    await pb.expire(1);
    expect(await pb.credits(creator.address)).to.equal(BOND);
    expect(await pb.credits(disputer.address)).to.equal(BOND);
    expect(await claimGain(b)).to.equal(E("1"));
  });

  it("one-sided market refunds instead of paying fees", async () => {
    await pb.connect(a).bet(1, true, { value: E("2") });
    await time.increaseTo(closeTime);
    await pb.connect(creator).propose(1, YES);
    await time.increase(86400);
    await pb.finalize(1);
    expect((await pb.getMarket(1)).result).to.equal(INVALID);
    expect(await claimGain(a)).to.equal(E("2"));
    expect(await pb.credits(creator.address)).to.equal(BOND);
  });

  it("bettor can hold both sides; payout only for winning side", async () => {
    await pb.connect(a).bet(1, true, { value: E("1") });
    await pb.connect(a).bet(1, false, { value: E("1") });
    await pb.connect(b).bet(1, false, { value: E("2") });
    await time.increaseTo(closeTime);
    await pb.connect(creator).propose(1, NO);
    await time.increase(86400); await pb.finalize(1);
    expect(await claimGain(a)).to.equal(E("3.92") / 3n); // pool 4 * 0.98 prize, a holds 1/3 of the NO pool
  });

  it("arbiter rotation", async () => {
    await expect(pb.connect(a).setArbiter(a.address)).to.be.revertedWithCustomError(pb, "NotAllowed");
    await pb.connect(arbiter).setArbiter(a.address);
    expect(await pb.arbiter()).to.equal(a.address);
  });

  it("reentrancy via claim is blocked", async () => {
    const atk = await ethers.deployContract("ClaimAttacker", [await pb.getAddress()]);
    await atk.bet(1, { value: E("1") });
    await pb.connect(b).bet(1, false, { value: E("1") });
    await time.increaseTo(closeTime);
    await pb.connect(creator).propose(1, YES);
    await time.increase(86400); await pb.finalize(1);
    await expect(atk.attack(1)).to.be.revertedWithCustomError(pb, "Failed"); // reentry blocked, whole claim reverts
    // nothing stolen: contract still holds creator/treasury credits + b stake
    expect(await pb.claimed(1, await atk.getAddress())).to.equal(false);
  });
});
