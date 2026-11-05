<script setup>
import { ref, onMounted, computed } from "vue";
import { BrowserProvider, JsonRpcProvider, Contract, formatEther, parseEther } from "ethers";
import { phase, impliedYes, projectedPayout, bucket, inFilter, DISPUTE_WINDOW, PROPOSE_WINDOW } from "./lib.js";

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
const route = ref(location.hash), filter = ref("all"), side = ref("yes"), loaded = ref(false);
const FILTERS = [["all", "All"], ["open", "Open"], ["closing", "Closing soon"], ["resolving", "Resolving"], ["disputed", "Disputed"], ["resolved", "Resolved"]];
const marketId = computed(() => { const r = /^#\/market\/(\d+)/.exec(route.value); return r ? Number(r[1]) : null; });
onMounted(async () => {
  window.addEventListener("hashchange", () => { route.value = location.hash; window.scrollTo(0, 0); });
  try {
    cfg = await (await fetch("/deployment.json")).json();
    ro = new Contract(cfg.address, ABI, new JsonRpcProvider(cfg.rpc)); info.value = cfg; await load(); loaded.value = true;
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
const view = computed(() => markets.value.map((x) => { const ph = phase(x.m, now.value), a = amt.value[x.id];
  const wei = (() => { try { return a ? parseEther(a) : 0n; } catch { return 0n; } })();
  return { ...x, ph, pct: impliedYes(x.m.yesPool, x.m.noPool), bk: bucket(ph, now.value), total: x.m.yesPool + x.m.noPool,
    est: wei > 0n ? { yes: projectedPayout(wei, "yes", x.m.yesPool, x.m.noPool), no: projectedPayout(wei, "no", x.m.yesPool, x.m.noPool) } : null,
    isCreator: account.value && x.m.creator.toLowerCase() === account.value.toLowerCase() }; }));
const shown = computed(() => view.value.filter((x) => inFilter(x.bk, filter.value)));
const counts = computed(() => Object.fromEntries(FILTERS.map(([k]) => [k, view.value.filter((x) => inFilter(x.bk, k)).length])));
const hero = computed(() => { const live = view.value.filter((x) => x.ph.key === "betting"); const pool = live.length ? live : view.value;
  return pool.slice().sort((a, b) => (b.total > a.total ? 1 : b.total < a.total ? -1 : b.id - a.id))[0] || null; });
const cur = computed(() => view.value.find((x) => x.id === marketId.value) || null);
const f = (w) => Number(formatEther(w)).toLocaleString(undefined, { maximumFractionDigits: 4 });
const yp = (x) => (x.pct ?? 50), np = (x) => Math.round((100 - yp(x)) * 100) / 100;
const big = (x) => (x.pct === null ? "50" : String(Math.round(x.pct)));
const chip = (x) => ({ betting: "Open", awaiting: "Resolving", disputable: "Dispute window", finalizable: "Resolving", expirable: "Stuck", arbitrating: "Disputed", resolved: "Resolved" }[x.ph.key]);
const chipCls = (x) => "chip c-" + x.bk;
const dt = (t) => new Date(Number(t) * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
function left(t) { let s = Math.max(0, Number(t) - now.value); const d = Math.floor(s / 86400); s %= 86400; const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${s % 60}s`; }
const closeNote = (x) => (x.ph.key === "betting" ? "Closes in " + left(x.m.closeTime) : "Closed " + dt(x.m.closeTime));
const tl = (x) => { const m = x.m, c = Number(m.closeTime), st = x.ph.key; const p = Number(m.proposedAt);
  const resDone = ["disputable", "finalizable", "arbitrating", "resolved"].includes(st);
  return [
    { t: "Created", d: "Market opened with the creator bond posted.", done: true },
    { t: "Closes", d: dt(c), done: st !== "betting", on: st === "betting" },
    { t: "Resolution", d: resDone && p ? `Creator proposed ${x.ph.label.replace(/^Proposed /, "").split(" - ")[0]}` : `Creator proposes within ${PROPOSE_WINDOW / 86400} days of close (by ${dt(c + PROPOSE_WINDOW)}), else anyone can expire and refund.`,
      done: resDone, on: st === "awaiting" },
    { t: "24h dispute window", d: p ? `Ends ${dt(p + DISPUTE_WINDOW)}` : "Opens when a result is proposed. Anyone can dispute by matching the bond.",
      done: ["finalizable", "resolved"].includes(st), on: st === "disputable" || st === "arbitrating" },
  ]; };
</script>

<template>
<div class="shell">
  <a class="skip" href="#main">Skip to content</a>
  <header class="top"><a class="brand" href="#/" aria-label="PredictBox home"><span class="mark"><i></i><i></i></span>PredictBox</a>
    <nav class="acts" aria-label="Wallet">
      <span v-if="credit > 0n" class="wd">Withdrawable <b>{{ f(credit) }} BOT</b> <button class="btn sm ghost" :disabled="busy" @click="send(() => rw.withdraw())">Withdraw</button></span>
      <a class="btn sm ghost" href="#/create">Create market</a>
      <button v-if="!account" class="btn sm" @click="connect">Connect wallet</button>
      <span v-else class="addr" :title="account">{{ account.slice(0, 6) }}…{{ account.slice(-4) }}</span></nav></header>

  <aside v-if="isMainnet" class="launch" aria-label="Launch announcement"><b>Officially launched on BOT Chain Mainnet</b>
    <span>{{ info.launched }} · PredictBox <a :href="EXPLORER + '/address/' + info.address" target="_blank" rel="noopener noreferrer">{{ info.address }}</a> · {{ markets.length }} market{{ markets.length === 1 ? "" : "s" }}</span></aside>
  <p v-if="err" class="err" role="alert">{{ err }}</p>

  <main id="main">
  <!-- DETAIL -->
  <template v-if="marketId !== null">
    <a class="back" href="#/">← All markets</a>
    <p v-if="!cur && loaded" class="note">Market #{{ marketId }} does not exist yet.</p>
    <p v-else-if="!cur" class="note">Loading market…</p>
    <div v-else class="detail">
      <section class="col-l">
        <div class="meta"><span class="idtag">#{{ cur.id }}</span><span :class="chipCls(cur)">{{ chip(cur) }}</span><span class="muted">{{ closeNote(cur) }}</span></div>
        <h1 class="q">{{ cur.m.question }}</h1>
        <div class="odds"><div class="oy"><small>YES</small><strong>{{ big(cur) }}<sup>%</sup></strong></div><div class="ono"><small>NO</small><strong>{{ cur.pct === null ? 50 : 100 - Math.round(cur.pct) }}<sup>%</sup></strong></div></div>
        <div class="split" role="img" :aria-label="`YES ${yp(cur)} percent, NO ${np(cur)} percent`"><i :style="{ width: yp(cur) + '%' }"></i><b></b></div>
        <p class="muted">{{ cur.pct === null ? "No bets yet, so odds start at 50/50." : "" }} Pool {{ f(cur.total) }} BOT · YES {{ f(cur.m.yesPool) }} · NO {{ f(cur.m.noPool) }}</p>
        <p v-if="cur.mine && (cur.mine.yes || cur.mine.no)" class="mine">Your stake: YES {{ f(cur.mine.yes) }} · NO {{ f(cur.mine.no) }} BOT</p>

        <h2 class="h2">Timeline</h2>
        <ol class="tl"><li v-for="s in tl(cur)" :key="s.t" :class="{ done: s.done, on: s.on }"><b>{{ s.t }}</b><span>{{ s.d }}</span></li></ol>
      </section>

      <aside class="col-r">
        <div class="slip" aria-label="Bet slip">
          <h2 class="h2 tight">{{ cur.ph.key === "betting" ? "Bet slip" : "Status" }}</h2>
          <p class="phase">{{ cur.ph.label }}<span v-if="cur.ph.until"> · {{ left(cur.ph.until) }} left</span></p>

          <template v-if="cur.ph.key === 'betting'">
            <div class="toggle" role="radiogroup" aria-label="Side">
              <button role="radio" :aria-checked="side === 'yes'" :class="['t-yes', { on: side === 'yes' }]" @click="side = 'yes'">YES <span>{{ big(cur) }}%</span></button>
              <button role="radio" :aria-checked="side === 'no'" :class="['t-no', { on: side === 'no' }]" @click="side = 'no'">NO <span>{{ cur.pct === null ? 50 : 100 - Math.round(cur.pct) }}%</span></button></div>
            <label class="lbl" for="amt">Amount (BOT)</label>
            <input id="amt" class="in" inputmode="decimal" autocomplete="off" v-model="amt[cur.id]" placeholder="0.0">
            <dl class="pay"><dt>Payout if {{ side.toUpperCase() }} wins</dt><dd>{{ cur.est ? "≈ " + f(cur.est[side]) + " BOT" : "Enter an amount" }}</dd>
              <dt>Fees</dt><dd>2% of the pool (1% creator, 1% protocol)</dd></dl>
            <p v-if="cur.isCreator" class="note">You created this market, so you cannot bet on it.</p>
            <button v-else-if="!account" class="btn big" @click="connect">Connect wallet to bet</button>
            <button v-else :class="['btn big', side === 'yes' ? 'b-yes' : 'b-no']" :disabled="busy || !cur.est" @click="bet(cur.id, side === 'yes')">Bet {{ side.toUpperCase() }}</button>
          </template>

          <div class="acts-col" v-if="cur.isCreator && cur.ph.key === 'awaiting'"><span class="lbl">Propose result</span>
            <div class="rowb"><button class="btn b-yes" :disabled="busy" @click="send(() => rw.propose(cur.id, 1))">YES</button><button class="btn b-no" :disabled="busy" @click="send(() => rw.propose(cur.id, 2))">NO</button>
            <button class="btn ghost" :disabled="busy" @click="send(() => rw.propose(cur.id, 3))">Invalid</button></div></div>
          <button v-if="cur.ph.key === 'disputable' && account && !cur.isCreator" class="btn ghost big" :disabled="busy" @click="send(() => rw.dispute(cur.id, { value: cur.m.bond }))">Dispute (post {{ f(cur.m.bond) }} BOT)</button>
          <button v-if="cur.ph.key === 'finalizable' && account" class="btn big" :disabled="busy" @click="send(() => rw.finalize(cur.id))">Finalize</button>
          <button v-if="cur.ph.key === 'expirable' && account" class="btn ghost big" :disabled="busy" @click="send(() => rw.expire(cur.id))">Expire &amp; refund</button>
          <button v-if="cur.mine && cur.mine.payout > 0n" class="btn big" :disabled="busy" @click="send(() => rw.claim(cur.id))">Claim {{ f(cur.mine.payout) }} BOT</button>
          <p v-if="!account && cur.ph.key !== 'betting'" class="muted">Connect a wallet to act on this market.</p>
        </div>

        <div class="rules"><h2 class="h2 tight">Bond and dispute rules</h2>
          <ul><li><b>Bond.</b> The creator posted <b>{{ f(cur.m.bond) }} BOT</b> (minimum 0.1) to back the result.</li>
            <li><b>Resolve.</b> After close the creator proposes YES, NO or Invalid within 3 days.</li>
            <li><b>Dispute.</b> Anyone can dispute within 24h by matching the bond of {{ f(cur.m.bond) }} BOT; an arbiter then decides.</li>
            <li><b>Stuck?</b> If the creator or arbiter goes silent, anyone can expire the market and everyone is refunded.</li></ul></div>
      </aside>
    </div>
  </template>

  <!-- CREATE -->
  <template v-else-if="route === '#/create'">
    <a class="back" href="#/">← All markets</a>
    <h1 class="h1">Create a market</h1>
    <div class="create">
      <div class="card">
        <label class="lbl" for="q">Question</label>
        <input id="q" class="in" v-model="q" maxlength="280" placeholder="Will … happen by …?">
        <div class="two"><div><label class="lbl" for="d">Closes in (days)</label><input id="d" class="in" type="number" min="1" max="365" v-model.number="days"></div>
          <div><label class="lbl" for="b">Bond (BOT, min 0.1)</label><input id="b" class="in" inputmode="decimal" v-model="bond"></div></div>
        <button v-if="!account" class="btn big" @click="connect">Connect wallet to create</button>
        <button v-else class="btn big" :disabled="busy || !q" @click="create">Create market</button>
        <p class="muted">Creating is a transaction from your wallet. Your bond is returned when the market resolves without a successful dispute.</p></div>
      <ol class="how"><li><b>Bond</b><span>Post a bond to open.</span></li><li><b>Close</b><span>Betting stops at close.</span></li><li><b>Resolve</b><span>You propose the result.</span></li><li><b>Dispute</b><span>24h to challenge.</span></li></ol>
    </div>
  </template>

  <!-- HOME -->
  <template v-else>
    <section class="hero">
      <div class="hero-copy"><p class="eyebrow">Prediction markets on BOT Chain</p>
        <h1 class="h1">What are the odds?</h1>
        <p class="lede">Binary YES/NO markets in BOT. Creators post a bond, resolve after close, and anyone can dispute within 24h by matching it. Browsing needs no wallet.</p></div>
      <a v-if="hero" class="tile hero-tile" :href="'#/market/' + hero.id" :aria-label="'Top market: ' + hero.m.question">
        <div class="meta"><span class="idtag">#{{ hero.id }}</span><span :class="chipCls(hero)">{{ chip(hero) }}</span><span class="muted">{{ hero.ph.key === "betting" ? "Top market" : "Latest market" }}</span></div>
        <h2 class="hq">{{ hero.m.question }}</h2>
        <div class="odds"><div class="oy"><small>YES</small><strong>{{ big(hero) }}<sup>%</sup></strong></div><div class="ono"><small>NO</small><strong>{{ hero.pct === null ? 50 : 100 - Math.round(hero.pct) }}<sup>%</sup></strong></div></div>
        <div class="split"><i :style="{ width: yp(hero) + '%' }"></i><b></b></div>
        <div class="foot"><span>Pool {{ f(hero.total) }} BOT</span><span>{{ closeNote(hero) }}</span></div></a>
      <div v-else class="tile hero-tile empty-tile"><div class="meta"><span class="chip c-open">Live board</span><span class="muted">{{ loaded ? "0 markets" : "Reading chain…" }}</span></div>
        <h2 class="hq">{{ loaded ? "The board is empty. The first market takes the top slot." : "Loading the board…" }}</h2>
        <div class="odds"><div class="oy"><small>YES</small><strong>–<sup>%</sup></strong></div><div class="ono"><small>NO</small><strong>–<sup>%</sup></strong></div></div>
        <div class="split ghosted"><i style="width:50%"></i><b></b></div>
        <div class="foot"><span>Pool 0 BOT</span><a class="btn sm" href="#/create">Create the first market</a></div></div>
    </section>

    <div class="filters" role="tablist" aria-label="Filter markets"><button v-for="[k, l] in FILTERS" :key="k" role="tab" :aria-selected="filter === k" :class="{ on: filter === k }" @click="filter = k">{{ l }} <span>{{ counts[k] }}</span></button></div>

    <section v-if="!markets.length && loaded && !err" class="empty" aria-label="No markets yet">
      <h2 class="h1 sm">No markets yet. Create the first.</h2>
      <p class="lede">Anyone with a wallet can open a market. Here is how one runs from start to payout.</p>
      <ol class="how"><li><b>1 · Bond</b><span>Post at least 0.1 BOT to open a question.</span></li><li><b>2 · Close</b><span>People bet YES or NO until the close time.</span></li><li><b>3 · Resolve</b><span>The creator proposes the result.</span></li><li><b>4 · Dispute</b><span>24h for anyone to match the bond and challenge.</span></li></ol>
      <a class="btn big" href="#/create">Create the first market</a></section>
    <p v-else-if="!markets.length && !err" class="note">Loading markets…</p>
    <p v-else-if="!shown.length" class="note">No markets in this filter.</p>
    <ul v-else class="grid"><li v-for="x in shown" :key="x.id"><a class="tile" :href="'#/market/' + x.id">
      <div class="meta"><span class="idtag">#{{ x.id }}</span><span :class="chipCls(x)">{{ chip(x) }}</span></div>
      <h3 class="tq">{{ x.m.question }}</h3>
      <div class="pct"><strong>{{ big(x) }}<sup>%</sup></strong><small>YES</small></div>
      <div class="split"><i :style="{ width: yp(x) + '%' }"></i><b></b></div>
      <div class="foot"><span>{{ f(x.total) }} BOT pool</span><span>{{ closeNote(x) }}</span></div></a></li></ul>
  </template>
  </main>
  <footer class="ft">PredictBox · BOT Chain Mainnet (677) · <a :href="EXPLORER" target="_blank" rel="noopener noreferrer">BOTScan</a></footer>
</div>
</template>
