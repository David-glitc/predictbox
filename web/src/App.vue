<script setup>
import { ref, onMounted, computed } from "vue";
import { BrowserProvider, JsonRpcProvider, Contract, formatEther, parseEther } from "ethers";
import { phase, impliedYes, projectedPayout, OUTCOME } from "./lib.js";

const ABI = [
  "function marketCount() view returns (uint256)",
  "function getMarket(uint256) view returns (tuple(address creator,uint64 closeTime,uint64 proposedAt,uint64 disputedAt,uint8 status,uint8 proposed,uint8 result,uint128 bond,address disputer,uint128 yesPool,uint128 noPool,uint128 feePool,string question))",
  "function stakes(uint256,address,uint256) view returns (uint128)",
  "function payoutOf(uint256,address) view returns (uint256)",
  "function credits(address) view returns (uint256)",
  "function createMarket(string,uint64) payable returns (uint256)",
  "function bet(uint256,bool) payable", "function propose(uint256,uint8)", "function dispute(uint256) payable",
  "function finalize(uint256)", "function expire(uint256)", "function claim(uint256)", "function withdraw()",
];
const markets = ref([]), account = ref(""), err = ref(""), busy = ref(false), credit = ref(0n);
const q = ref(""), days = ref(7), bond = ref("0.5"), amt = ref({}), now = ref(Math.floor(Date.now() / 1000));
let cfg, ro, rw;
const info = ref(null), EXPLORER = "https://scan.botchain.ai";
const isMainnet = computed(() => info.value && info.value.chainId === 677 && /^https:/.test(info.value.rpc) && info.value.launched);

async function load() {
  const n = Number(await ro.marketCount()); const out = [];
  for (let id = n; id >= 1; id--) {
    const m = await ro.getMarket(id);
    const mine = account.value ? { yes: await ro.stakes(id, account.value, 0), no: await ro.stakes(id, account.value, 1), payout: await ro.payoutOf(id, account.value) } : null;
    out.push({ id, m, mine });
  }
  markets.value = out; if (account.value) credit.value = await ro.credits(account.value);
}
onMounted(async () => {
  try {
    cfg = await (await fetch("/deployment.json")).json();
    ro = new Contract(cfg.address, ABI, new JsonRpcProvider(cfg.rpc)); info.value = cfg; await load();
  } catch (e) { err.value = "No deployment.json or RPC unreachable: " + e.message; }
  setInterval(() => (now.value = Math.floor(Date.now() / 1000)), 1000);
});
async function connect() {
  try {
    let bp = new BrowserProvider(window.ethereum); await bp.send("eth_requestAccounts", []);
    if (Number((await bp.getNetwork()).chainId) !== cfg.chainId) {
      const hex = "0x" + cfg.chainId.toString(16);
      try { await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] }); }
      catch (e) { if (e.code !== 4902 && e?.data?.originalError?.code !== 4902) throw e;
        await window.ethereum.request({ method: "wallet_addEthereumChain", params: [{ chainId: hex, chainName: "BOT Chain", nativeCurrency: { name: "BOT", symbol: "BOT", decimals: 18 }, rpcUrls: [cfg.rpc], blockExplorerUrls: [EXPLORER] }] }); }
      bp = new BrowserProvider(window.ethereum);
    }
    const net = await bp.getNetwork(); if (net.chainId !== BigInt(cfg.chainId)) throw new Error(`Switch wallet to chain ${cfg.chainId}`);
    const s = await bp.getSigner(); account.value = await s.getAddress(); rw = new Contract(cfg.address, ABI, s); await load();
  } catch (e) { err.value = e.shortMessage || e.message; }
}
async function send(fn) {
  err.value = ""; busy.value = true;
  try { await (await fn()).wait(); await load(); } catch (e) { err.value = e.shortMessage || e.message; } finally { busy.value = false; }
}
const create = () => send(() => rw.createMarket(q.value, BigInt(now.value + days.value * 86400), { value: parseEther(bond.value) }));
const bet = (id, yes) => send(() => rw.bet(id, yes, { value: parseEther(amt.value[id] || "0") }));
const view = computed(() => markets.value.map((x) => ({ ...x, ph: phase(x.m, now.value), pct: impliedYes(x.m.yesPool, x.m.noPool),
  est: amt.value[x.id] ? { yes: projectedPayout(parseEther(amt.value[x.id]), "yes", x.m.yesPool, x.m.noPool), no: projectedPayout(parseEther(amt.value[x.id]), "no", x.m.yesPool, x.m.noPool) } : null,
  isCreator: account.value && x.m.creator.toLowerCase() === account.value.toLowerCase() })));
const f = (w) => Number(formatEther(w)).toLocaleString(undefined, { maximumFractionDigits: 4 });
</script>

<template>
<main>
  <header><h1>PredictBox</h1>
    <div><span v-if="credit > 0n" class="mut">Withdrawable {{ f(credit) }} BOT <button class="ghost" @click="send(() => rw.withdraw())">Withdraw</button> </span>
    <button v-if="!account" @click="connect">Connect wallet</button><span v-else class="mut">{{ account.slice(0, 8) }}…</span></div></header>
  <p class="mut">Binary markets in BOT. Creators post a bond, resolve after close, anyone can dispute within 24h by matching the bond. Browsing works without a wallet.</p>
  <aside v-if="isMainnet" class="launch" aria-label="Launch announcement"><b>Officially launched on BOT Chain Mainnet</b>
    <span class="mut">{{ info.launched }} · PredictBox <a :href="EXPLORER + '/address/' + info.address" target="_blank" rel="noopener noreferrer">{{ info.address }}</a> · {{ markets.length }} market{{ markets.length === 1 ? "" : "s" }}</span></aside>
  <p v-if="err" class="err">{{ err }}</p>
  <div class="card" v-if="account"><b>Create a market</b>
    <div class="row"><input class="wide" v-model="q" maxlength="280" placeholder="Will … happen by …?"></div>
    <div class="row">Closes in <input type="number" min="1" max="365" v-model.number="days" style="width:70px"> days · bond <input v-model="bond" style="width:70px"> BOT (min 0.1)
      <button :disabled="busy || !q" @click="create">Create</button></div></div>
  <div v-for="x in view" :key="x.id" class="card">
    <div><span class="tag">#{{ x.id }}</span> <span class="tag">{{ x.ph.label }}</span></div>
    <h3 style="margin:.4em 0">{{ x.m.question }}</h3>
    <div class="bar"><i :style="{ width: (x.pct ?? 50) + '%' }"></i></div>
    <div class="mut">YES {{ f(x.m.yesPool) }} · NO {{ f(x.m.noPool) }} BOT <span v-if="x.pct !== null">· {{ x.pct }}% yes</span> · bond {{ f(x.m.bond) }}</div>
    <div v-if="x.mine && (x.mine.yes || x.mine.no)" class="mut">Your stake: YES {{ f(x.mine.yes) }} / NO {{ f(x.mine.no) }}</div>
    <div class="row" v-if="x.ph.key === 'betting' && account && !x.isCreator">
      <input v-model="amt[x.id]" placeholder="BOT"> <button class="yes" :disabled="busy" @click="bet(x.id, true)">Bet YES</button><button class="no" :disabled="busy" @click="bet(x.id, false)">Bet NO</button>
      <span v-if="x.est" class="mut">wins ≈ {{ f(x.est.yes) }} / {{ f(x.est.no) }}</span></div>
    <div class="row" v-if="x.isCreator && x.ph.key === 'awaiting'">Propose result:
      <button class="yes" :disabled="busy" @click="send(() => rw.propose(x.id, 1))">YES</button><button class="no" :disabled="busy" @click="send(() => rw.propose(x.id, 2))">NO</button>
      <button class="ghost" :disabled="busy" @click="send(() => rw.propose(x.id, 3))">Invalid</button></div>
    <div class="row" v-if="x.ph.key === 'disputable' && account && !x.isCreator"><button class="ghost" :disabled="busy" @click="send(() => rw.dispute(x.id, { value: x.m.bond }))">Dispute (post {{ f(x.m.bond) }} BOT)</button></div>
    <div class="row" v-if="x.ph.key === 'finalizable' && account"><button :disabled="busy" @click="send(() => rw.finalize(x.id))">Finalize</button></div>
    <div class="row" v-if="x.ph.key === 'expirable' && account"><button class="ghost" :disabled="busy" @click="send(() => rw.expire(x.id))">Expire &amp; refund</button></div>
    <div class="row" v-if="x.mine && x.mine.payout > 0n"><button :disabled="busy" @click="send(() => rw.claim(x.id))">Claim {{ f(x.mine.payout) }} BOT</button></div>
  </div>
  <p v-if="!markets.length && !err" class="mut">No markets yet.</p>
</main>
</template>
