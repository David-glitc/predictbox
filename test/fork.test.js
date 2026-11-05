// Run with: FORK=1 npx hardhat test test/fork.test.js  (reads BOT Chain mainnet; sends nothing)
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
(process.env.FORK === "1" ? describe : describe.skip)("PredictBox on a BOT Chain mainnet fork", () => {
  it("deploys and settles a market on forked chain 677 with real fee/gas settings", async () => {
    const net = await ethers.provider.getNetwork();
    expect(net.chainId).to.equal(677n);
    expect(await ethers.provider.getBlockNumber()).to.be.gt(1000);
    const [arb, tre, cr, a, b] = await ethers.getSigners();
    const pb = await ethers.deployContract("PredictBox", [arb.address, tre.address]);
    const close = (await time.latest()) + 7200;
    const t = await (await pb.connect(cr).createMarket("fork?", close, { value: ethers.parseEther("0.1") })).wait();
    await pb.connect(a).bet(1, true, { value: ethers.parseEther("1") });
    await pb.connect(b).bet(1, false, { value: ethers.parseEther("1") });
    await time.increaseTo(close);
    await pb.connect(cr).propose(1, 1); await time.increase(86400); await pb.finalize(1);
    await pb.connect(a).claim(1);
    console.log("      createMarket gas", t.gasUsed.toString());
  });
});
