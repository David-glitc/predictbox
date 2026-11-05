# PredictBox launch (needs the owner's approval - nothing here has been run on mainnet)

Estimated gas (measured on Hardhat; price ~22 gwei from wave 3's "5M gas ~ 0.11 BOT"):
| Action | Gas | ~BOT |
|---|---|---|
| Deploy PredictBox | 1.57M | 0.035 |
| createMarket | 114k | 0.0025 |
| bet / claim | ~60-70k | 0.0015 |

Steps
1. Decide `ARBITER` (strongly prefer a multisig) and `TREASURY`.
2. Fund one fresh deployer with ~0.1 BOT. Use a new key, not the wave 1 deployers.
3. Add a botchain network (rpc https://rpc.botchain.ai, chain 677) to hardhat.config.js, then
   `ARBITER=0x.. TREASURY=0x.. npx hardhat run scripts/deploy.js --network botchain`.
4. Verify on BOTScan, create 2-3 starter markets (0.1 BOT bonds), run one full cycle with a second wallet.
5. `cd web && npm run build`; put `deployment.json` ({address, chainId:677, rpc:"https://rpc.botchain.ai"}) in `dist/`; host the static site (deploy needs approval).

Open decisions: arbiter identity; fee split (1%+1%); creator whitelist at launch.
