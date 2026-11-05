# PredictBox

Binary prediction markets on BOT Chain, in native BOT. Stack: Hardhat (Solidity 0.8.24, paris EVM) + Vue 3 / Vite.

## The gap
Prediction markets already exist on BOT Chain but each has under 10 transactions (wave 3 survey): they are single-purpose,
need an oracle nobody runs, or have no way out when the resolver disappears. PredictBox is deliberately oracle-free and
cannot get stuck: every dead end resolves to refunds.

## How it works
1. **Create** - anyone calls `createMarket(question, closeTime)` with a bond (min 0.1 BOT). Close is 1h-365d away.
2. **Bet** - until close, users bet YES or NO (min 0.001 BOT). Parimutuel: winners split the whole pool pro rata. The creator cannot bet.
3. **Propose** - after close the creator has 3 days to propose YES / NO / INVALID.
4. **Dispute window** - 24h. Anyone may dispute by posting a bond equal to the creator's.
5. **Finalize** - undisputed: anyone calls `finalize`, creator bond returns. Disputed: the arbiter calls `arbitrate`.
6. **Claim** - winners `claim(id)`; bonds and fees are pull-paid through `withdraw()`.

## Fees and bonds
- 1% of the pool to the creator + 1% to the treasury, only on a valid resolution. Winners take the other 98%.
- Dispute upheld (arbiter disagrees with the proposal, including INVALID): disputer gets own bond + 50% of the creator bond, treasury the other 50%.
- Dispute rejected: creator gets both bonds.
- Creator never proposes: after 3 days anyone calls `expire` - everyone refunded, bond forfeited to treasury.
- Arbiter silent for 7 days: anyone calls `expire` - everyone refunded, both bonds returned.
- One-sided market (nobody on the other side) or INVALID: full refunds, no fees.

## Main risks and mitigations
| Risk | Handling |
|---|---|
| Creator lies to win | Creator address cannot bet; 24h dispute window; bond slashed if the arbiter agrees. Residual: a creator betting from a second wallet. Mitigated socially (bond size, visible creator history) and economically: correcting a lie costs a bond, and the corrector is paid. |
| Frivolous disputes to delay payouts | Disputer posts an equal bond and loses it if rejected; a dispute cannot outlast 7 days. |
| Arbiter is a trust point | One address (`arbiter`, rotatable by itself), intended to be a multisig. It only chooses between outcomes of existing markets and cannot move funds elsewhere. Silence = refund, not theft. |
| Last-second bets / front-running resolution | Betting closes at `closeTime`, before any proposal is possible. |
| Reentrancy / stuck funds | Pull payments, `nonReentrant` on claim and withdraw, tested with an attacking contract. Solvency tested: contract drains to dust. |
| Griefing with giant questions | 280-byte limit. |

## Run it
```bash
npm install && (cd web && npm install)
npx hardhat test                            # 15 contract tests (+1 fork test, skipped unless FORK=1)
FORK=1 npx hardhat test test/fork.test.js   # same lifecycle on a BOT Chain mainnet fork (chain 677); sends nothing
(cd web && npm test && npm run build)       # 3 helper tests + production build
# local demo
npx hardhat node &                                      # chain 677 on :8545
npx hardhat run scripts/deploy.js --network localhost   # deploys, seeds 3 markets, writes web/public/deployment.json
(cd web && npm run dev)                                 # http://localhost:5173 ; point a wallet at the node to trade
```
BDEX is not used, so the fork test checks the contract against live chain settings rather than pool state.
