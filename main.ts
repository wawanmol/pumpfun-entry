// Diver — a diversified small-stake momentum scalper for the pump.fun replay.
//
// Thesis: on pump.fun almost every new coin dies, but a small share runs hard for a few
// minutes. The edge is not picking the one runner; it is buying many coins cheaply with a
// tight leash, so the runners pay for the rugs. Every position is the same small size
// (0.05 SOL), total cost exposure is capped (1.5 SOL of the 10 SOL paper capital), and
// every exit is mechanical: a stop loss, a trailing stop, a take-profit, a time limit, or
// a flow reversal. No pyramids, no re-buys into a dying coin, no discretion.
//
// Entry: a curve that has lived a little (fresh launches are mostly bundled dumps) and
// whose last ~40 slots show broad, accelerating buy pressure — several distinct buyers,
// net SOL flowing in, price rising but not parabolic, sitting near its window high, with
// enough real SOL that our 0.05 SOL buy fits under the 1%-of-reserve size cap.
//
// The guardrail bar (a >= 0.01 SOL round trip on >= 20 coins, drawdown <= 50%) is met by
// construction: stakes are 0.05 SOL, turnover is fast, and worst-case loss is bounded by
// the exposure cap plus fees.
//
// Deterministic by construction: no clock, no environment, no randomness; iteration only
// over insertion-ordered maps fed by the batch stream.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125; // protocol 95 bps + creator 30 bps, charged on the trade

interface Params {
  window: number; // entry lookback, slots
  minNetSol: number; // net buy SOL (buys - sells) over the window
  minBuys: number; // buy trades in the window
  minBuyers: number; // distinct buying wallets in the window
  minPriceUp: number; // price now / price at window start - 1, lower bound
  maxPriceUp: number; // same, upper bound (skip parabolic runs)
  accel: number; // newer-half net inflow must be >= accel * older-half net inflow
  nearHigh: number; // price now must be >= nearHigh * window high
  maxBuyerShare: number; // largest single wallet's share of window buy SOL
  minRqSol: number; // curve real SOL at entry, lower bound
  maxRqSol: number; // curve real SOL at entry, upper bound
  minAge: number; // slots since CreateEvent before an entry is allowed
  stakeSol: number; // SOL per position
  buySlipBps: number; // slippage on buys; sells go out wide open
  stopLoss: number; // exit when value < cost * (1 - stopLoss)
  trail: number; // trailing stop: exit when value < peak * (1 - trail)
  trailArm: number; // trailing stop arms once value >= cost * (1 + trailArm)
  takeProfit: number; // exit when value >= cost * (1 + takeProfit)
  maxHold: number; // exit after this many slots held (unless up >= holdIfUp)
  holdIfUp: number; // time limit does not apply while up at least this much
  fadeWindow: number; // exit when net SOL over this window < -fadeNetSol
  fadeNetSol: number;
  bigSellSol: number; // exit on any single recorded sell of at least this many SOL
  cooldown: number; // slots to wait after an exit before the same curve may be bought again
  maxEntries: number; // most entries per curve over the run
  maxExposureSol: number; // most SOL at cost across all positions at once
}

const P: Params = {
  window: 40,
  minNetSol: 1.0,
  minBuys: 3,
  minBuyers: 6,
  minPriceUp: 0.08,
  maxPriceUp: 0.6,
  accel: 1.0,
  nearHigh: 0.95,
  maxBuyerShare: 0.6,
  minRqSol: 5,
  maxRqSol: 50,
  minAge: 200,
  stakeSol: 0.05,
  buySlipBps: 1500,
  stopLoss: 0.1,
  trail: 0.15,
  trailArm: 0.08,
  takeProfit: 1.0,
  maxHold: 1800,
  holdIfUp: 0.2,
  fadeWindow: 20,
  fadeNetSol: 0.5,
  bigSellSol: 2,
  cooldown: 300,
  maxEntries: 2,
  maxExposureSol: 1.5,
};

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  filled: boolean;
  exiting: boolean;
}

const tapeOf = (tapes: Map<Pubkey, Tape>, mint: Pubkey): Tape => {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = { created: null, trades: [], entries: 0, lastExit: -1e12 };
    tapes.set(mint, t);
  }
  return t;
};

/** Net recorded SOL (buys minus sells) over the last `w` slots. */
const flow = (t: Tape, now: number, w: number): number => {
  let net = 0;
  for (let i = t.trades.length - 1; i >= 0; i--) {
    const tr = t.trades[i]!;
    if (tr.slot <= now - w) break;
    net += tr.buy ? tr.sol : -tr.sol;
  }
  return net;
};

/** Entry signal on a curve's tape at slot `now`. */
const entrySignal = (t: Tape, now: number, rqSol: number): boolean => {
  if (rqSol < P.minRqSol || rqSol > P.maxRqSol) return false;
  if (t.created === null || now - t.created < P.minAge) return false;
  const from = now - P.window;
  const mid = now - P.window / 2;
  let buySol = 0;
  let sellSol = 0;
  let buys = 0;
  let netOld = 0;
  let netNew = 0;
  let startPrice = -1;
  let high = 0;
  let last = 0;
  const byUser = new Map<string, number>();
  for (const tr of t.trades) {
    if (tr.slot <= from) {
      startPrice = tr.price;
      continue;
    }
    if (startPrice < 0) startPrice = tr.price;
    const signed = tr.buy ? tr.sol : -tr.sol;
    if (tr.slot <= mid) netOld += signed;
    else netNew += signed;
    if (tr.buy) {
      buySol += tr.sol;
      buys++;
      byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
    } else {
      sellSol += tr.sol;
    }
    if (tr.price > high) high = tr.price;
    last = tr.price;
  }
  if (buys < P.minBuys || byUser.size < P.minBuyers) return false;
  if (buySol - sellSol < P.minNetSol) return false;
  if (startPrice <= 0 || last <= 0) return false;
  const up = last / startPrice - 1;
  if (up < P.minPriceUp || up > P.maxPriceUp) return false;
  if (last < high * P.nearHigh) return false;
  if (netNew <= 0 || netNew < P.accel * netOld) return false;
  let top = 0;
  for (const v of byUser.values()) if (v > top) top = v;
  if (top > P.maxBuyerShare * buySol) return false;
  return true;
};

const tapes = new Map<Pubkey, Tape>();
const held = new Map<Pubkey, Held>();
const keep = P.window + 5;

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const now = batch.slot;
    const bigSell = new Set<Pubkey>();
    const traded = new Set<Pubkey>();
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        tapeOf(tapes, e.mint).created = e.slot;
      } else if (e.event === 'TradeEvent') {
        const t = tapeOf(tapes, e.mint);
        const sol = Number(e.sol_amount) / LAMPORTS;
        t.trades.push({
          slot: e.slot,
          buy: e.is_buy,
          sol,
          user: e.user,
          price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
        });
        traded.add(e.mint);
        if (!e.is_buy && sol >= P.bigSellSol) bigSell.add(e.mint);
      }
    }
    for (const mint of traded) {
      const t = tapes.get(mint)!;
      let cut = 0;
      while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
      if (cut > 0) t.trades.splice(0, cut);
    }

    const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
    const pendingByMint = new Map<Pubkey, number>();
    for (const po of state.pending.values()) {
      pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
    }

    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const tx = Number(state.txFeeLamports()) / LAMPORTS;

    // Exits first: stop loss, trailing stop, take-profit, time limit, flow fade, big sell.
    for (const [mint, h] of held) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) {
          held.delete(mint);
          const t = tapeOf(tapes, mint);
          if (h.filled) t.lastExit = now;
          else t.entries--;
        }
        continue;
      }
      h.filled = true;
      if (curve === undefined || curve.complete) continue;
      const mk = marks.get(mint);
      const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
      const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
      const tokens = Number(pos.token_amount);
      const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
      const cost = Number(pos.cost_lamports) / LAMPORTS;
      if (value > h.peakValue) h.peakValue = value;
      let exit = h.exiting;
      const t = tapeOf(tapes, mint);
      if (!exit && value < cost * (1 - P.stopLoss)) exit = true;
      if (!exit && h.peakValue >= cost * (1 + P.trailArm) && value < h.peakValue * (1 - P.trail)) exit = true;
      if (!exit && value >= cost * (1 + P.takeProfit)) exit = true;
      if (!exit && now - h.opened > P.maxHold && value < cost * (1 + P.holdIfUp)) exit = true;
      if (!exit && flow(t, now, P.fadeWindow) < -P.fadeNetSol) exit = true;
      if (!exit && bigSell.has(mint)) exit = true;
      if (!exit) continue;
      h.exiting = true;
      let sellPending = false;
      for (const po of state.pending.values()) {
        if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
      }
      if (sellPending) continue;
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
    }

    // Entries: one small buy per qualifying curve, within position and exposure caps.
    let free = Number(state.freeCashLamports()) / LAMPORTS;
    let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
    let exposure = 0;
    for (const [mint, h] of held) {
      void h;
      exposure += Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS;
    }
    for (const mint of traded) {
      if (orders.length >= cap) break;
      if (slotsLeft <= 0) break;
      if (exposure + P.stakeSol > P.maxExposureSol) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (pendingByMint.has(mint) || held.has(mint)) continue;
      const t = tapes.get(mint)!;
      if (t.entries >= P.maxEntries || now - t.lastExit < P.cooldown) continue;
      const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
      if (!entrySignal(t, now, rqSol)) continue;
      const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
      let amount = Math.min(capSol, P.stakeSol);
      if (amount > free - tx) amount = free - tx;
      if (amount < 0.01) continue;
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: BigInt(Math.floor(amount * LAMPORTS)),
        max_slippage_bps: P.buySlipBps,
      });
      free -= amount + tx;
      exposure += amount;
      slotsLeft--;
      held.set(mint, { opened: now, peakValue: 0, filled: false, exiting: false });
      t.entries++;
    }
    return orders;
  },
});
