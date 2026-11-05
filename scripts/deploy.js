// npx hardhat run scripts/deploy.js --network localhost   (local demo; seeds sample markets)
// Mainnet: needs ARBITER, TREASURY and a funded signer -- see LAUNCH.md. Never run without the owner's approval.
const { ethers, network } = require("hardhat");
const fs = require("fs");
async function main() {
  const [d, ...rest] = await ethers.getSigners();
  const arbiter = process.env.ARBITER || d.address, treasury = process.env.TREASURY || d.address;
  const pb = await ethers.deployContract("PredictBox", [arbiter, treasury]);
  const r = await pb.deploymentTransaction().wait();
  console.log("PredictBox", await pb.getAddress(), "deploy gas", r.gasUsed.toString());
  fs.mkdirSync("web/public", { recursive: true });
  fs.writeFileSync("web/public/deployment.json", JSON.stringify({ address: await pb.getAddress(), chainId: 677, rpc: "http://127.0.0.1:8545" }, null, 2));
  if (network.name === "localhost" || network.name === "hardhat") {
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    const qs = ["Will BDEX 24h volume exceed 50k BOT by Dec 1?", "Will BOT Chain reach 100 daily active wallets this month?", "Will a new DEX launch on BOT Chain before Jan 1?"];
    for (let i = 0; i < qs.length; i++) {
      await (await pb.connect(rest[0]).createMarket(qs[i], now + 86400 * (7 + i * 7), { value: ethers.parseEther("0.5") })).wait();
      await (await pb.connect(rest[1]).bet(i + 1, true, { value: ethers.parseEther("2") })).wait();
      await (await pb.connect(rest[2]).bet(i + 1, false, { value: ethers.parseEther("1") })).wait();
    }
    console.log("seeded 3 markets");
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
