require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
const fork = process.env.FORK === "1";
module.exports = {
  solidity: { version: "0.8.24", settings: { evmVersion: "paris", optimizer: { enabled: true, runs: 200 }, viaIR: true } },
  networks: {
    hardhat: fork ? { chainId: 677, forking: { url: process.env.BOT_RPC || "https://rpc.botchain.ai" } } : { chainId: 677 },
    localhost: { url: "http://127.0.0.1:8545", chainId: 677 },
  },
  gasReporter: { enabled: false },
};
