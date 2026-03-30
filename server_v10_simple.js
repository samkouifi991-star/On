const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json());

// ============================================================
// CONFIG — SIMPLE TENNIS SCANNER v10
// ============================================================
const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";
const POLL_INTERVAL = 3000;
const PORT = process.env.PORT || 3001;

// ============================================================
// AUTH
// ============================================================
const API_KEY_ID = process.env.KALSHI_API_KEY || "";
let PRIVATE_KEY = "";

for (const p of ["kalshi_private_key.pem", "/app/kalshi_private_key.pem"]) {
  try { if (fs.existsSync(p)) { PRIVATE_KEY = fs.readFileSync(p, "utf8"); break; } } catch {}
}
if (!PRIVATE_KEY && process.env.KALSHI_PRIVATE_KEY_PEM) PRIVATE_KEY = process.env.KALSHI_PRIVATE_KEY_PEM;

function signRequest(method, path) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(ts + method.toUpperCase() + path);
  sign.end();
  return { timestamp: ts, signature: sign.sign(PRIVATE_KEY, "base64") };
}

async function kalshiFetch(path) {
  const headers = { "Content-Type": "application/json" };
  if (API_KEY_ID && PRIVATE_KEY) {
    const { timestamp, signature } = signRequest("GET", path);
    headers["KALSHI-ACCESS-KEY"] = API_KEY_ID;
    headers["KALSHI-ACCESS-SIGNATURE"] = signature;
    headers["KALSHI-ACCESS-TIMESTAMP"] = timestamp;
  }
  const res = await fetch(`${KALSHI_BASE}${path}`, { headers });
  if (res.status === 429) { await new Promise(r => setTimeout(r, 30000)); throw new Error("429"); }
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

// ============================================================
// STATE
// ============================================================
let markets = [];
let opportunities = [];
let peakPrices = {};
let previousPrices = {};
let scanCount = 0;
let lastScan = 0;
const startTime = Date.now();

// ============================================================
// DISCOVERY — extract tennis tickers from wrapper markets
// ============================================================
async function discoverTennisTickers() {
  const tennisTickers = new Set();
  let cursor = null;

  for (let page = 0; page < 8; page++) {
    try {
      const params = new URLSearchParams({ limit: "1000", status: "open" });
      if (cursor) params.set("cursor", cursor);
      const data = await kalshiFetch(`/markets?${params.toString()}`);
      const batch = data.markets || [];

      for (const m of batch) {
        // Direct tennis market
        if (/^(KXATP|KXWTA|KXTENNIS)/i.test(m.ticker || "")) {
          tennisTickers.add(m.ticker);
        }
        // Extract from wrapper Associated Markets
        const assoc = String((m.custom_strike || {})["Associated Markets"] || "");
        for (const t of assoc.split(",").map(s => s.trim()).filter(Boolean)) {
          if (/^(KXATP|KXWTA|KXTENNIS)/i.test(t)) tennisTickers.add(t);
        }
      }

      cursor = data.cursor;
      if (!cursor || batch.length === 0) break;
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.log(`[DISCOVERY] Page ${page} error: ${err.message}`);
      if (err.message === "429") await new Promise(r => setTimeout(r, 30000));
      break;
    }
  }

  console.log(`[DISCOVERY] Found ${tennisTickers.size} unique tennis tickers`);
  return Array.from(tennisTickers);
}

// ============================================================
// HYDRATE — get live prices for each tennis ticker
// ============================================================
async function hydrateMarket(ticker) {
  try {
    const data = await kalshiFetch(`/markets/${ticker}`);
    const m = data.market || data;
    if (!m || !m.ticker) return null;

    // Skip closed/settled
    const status = (m.status || "").toLowerCase();
    if (["closed", "settled", "finalized", "inactive"].includes(status)) return null;

    // Get orderbook for live prices
    let yesBid = 0, yesAsk = 0, noBid = 0, noAsk = 0, midpoint = 0;
    try {
      const book = await kalshiFetch(`/markets/${ticker}/orderbook`);
      const ob = book?.orderbook_fp || {};
      const yesLevels = Array.isArray(ob.yes_dollars) ? ob.yes_dollars : [];
      const noLevels = Array.isArray(ob.no_dollars) ? ob.no_dollars : [];
      yesBid = yesLevels.length ? Math.max(...yesLevels.map(([p]) => Math.round(parseFloat(p) * 100))) : 0;
      noBid = noLevels.length ? Math.max(...noLevels.map(([p]) => Math.round(parseFloat(p) * 100))) : 0;
      yesAsk = noBid ? 100 - noBid : 0;
      noAsk = yesBid ? 100 - yesBid : 0;
      midpoint = yesBid && yesAsk ? Math.round((yesBid + yesAsk) / 2) : yesBid || yesAsk;
    } catch {}

    const price = yesAsk || midpoint || 0;
    if (price <= 0) return null;

    const prev = previousPrices[ticker] ?? price;
    const spread = yesAsk && yesBid ? yesAsk - yesBid : 0;

    return {
      ticker: m.ticker,
      title: (m.title || m.ticker).replace(/\s+winner\??$/i, "").trim(),
      match: (m.title || m.ticker).replace(/\s+winner\??$/i, "").trim(),
      price, prev, spread,
      volume: parseFloat(m.volume || m.volume_fp || 0),
      gameState: m.status || "active",
      status: "LIVE",
      sport: "TENNIS",
      yes_bid: yesBid, yes_ask: yesAsk, no_bid: noBid, no_ask: noAsk,
    };
  } catch (err) {
    if (err.message === "429") await new Promise(r => setTimeout(r, 30000));
    return null;
  }
}

// ============================================================
// SIMPLE COMEBACK DETECTION
// peak ≥ 50¢ AND drop ≥ 3¢ → signal
// ============================================================
function checkComeback(m) {
  const peak = peakPrices[m.ticker] || m.price;
  const drop = peak - m.price;
  if (peak < 50) return null;
  if (drop < 3) return null;
  if (m.price < 5 || m.price > 95) return null;

  const recovering = m.price > m.prev;
  let strength = "WEAK";
  if (drop >= 8) strength = "STRONG";
  else if (drop >= 5) strength = "NORMAL";

  return {
    id: `${m.ticker}-${Date.now()}`,
    type: "COMEBACK",
    match: m.match,
    sport: "TENNIS",
    ticker: m.ticker,
    price: m.price,
    prev: m.prev,
    edge: drop,
    direction: "YES",
    timestamp: Date.now(),
    description: `Peak ${peak}¢ → now ${m.price}¢ (dropped ${drop}¢)${recovering ? " — recovering" : ""}`,
    strength,
    score: drop * 10,
    action: "BUY",
    peakPrice: peak,
    dropSize: drop,
    recovering,
    volume: m.volume,
    spread: m.spread,
  };
}

// ============================================================
// MAIN SCAN
// ============================================================
let tennisTickers = [];
let lastDiscovery = 0;
let scanning = false;

async function scan() {
  if (scanning) return;
  scanning = true;

  try {
    // Re-discover every 2 min
    if (!tennisTickers.length || Date.now() - lastDiscovery > 120000) {
      tennisTickers = await discoverTennisTickers();
      lastDiscovery = Date.now();
    }

    if (!tennisTickers.length) {
      console.log("[SCAN] No tennis tickers found yet");
      scanning = false;
      return;
    }

    // Hydrate each ticker (with delay to avoid 429)
    const live = [];
    for (const ticker of tennisTickers) {
      const m = await hydrateMarket(ticker);
      if (m) live.push(m);
      await new Promise(r => setTimeout(r, 200)); // 200ms between requests
    }

    // Update peaks & prev prices
    for (const m of live) {
      const currentPeak = peakPrices[m.ticker] || 0;
      if (m.price > currentPeak) peakPrices[m.ticker] = m.price;
    }

    // Check comebacks
    const signals = [];
    const seen = new Set();
    for (const m of live) {
      if (seen.has(m.ticker)) continue;
      const sig = checkComeback(m);
      if (sig) { signals.push(sig); seen.add(m.ticker); }
    }

    // Update prev prices AFTER detection
    for (const m of live) previousPrices[m.ticker] = m.price;

    // Merge signals (newest per ticker)
    const tickerMap = new Map();
    for (const s of [...signals, ...opportunities]) {
      if (!tickerMap.has(s.ticker)) tickerMap.set(s.ticker, s);
    }
    opportunities = Array.from(tickerMap.values()).sort((a, b) => b.edge - a.edge).slice(0, 50);

    markets = live.sort((a, b) => b.volume - a.volume);
    lastScan = Date.now();
    scanCount++;

    console.log(`[SCAN #${scanCount}] ${live.length} live tennis | ${signals.length} new signals | ${opportunities.length} total signals`);
  } catch (err) {
    console.error("[SCAN ERROR]", err.message);
  } finally {
    scanning = false;
  }
}

// ============================================================
// API
// ============================================================
app.get("/api/markets", (req, res) => res.json(markets));
app.get("/api/opportunities", (req, res) => res.json(opportunities));
app.get("/api/status", (req, res) => {
  const levels = { STRONG: 0, NORMAL: 0, WEAK: 0 };
  opportunities.forEach(o => levels[o.strength]++);
  res.json({
    connected: scanCount > 0,
    lastScan,
    marketsScanned: markets.length,
    activeOpportunities: opportunities.length,
    sports: { TENNIS: markets.length },
    totalSignals: opportunities.length,
    signalLevels: levels,
    uptime: (Date.now() - startTime) / 1000,
  });
});
app.get("/api/debug", (req, res) => res.json({
  scanCount, tickers: tennisTickers.length, markets: markets.length, signals: opportunities.length,
  peaks: Object.entries(peakPrices).map(([t, p]) => ({ ticker: t, peak: p, current: markets.find(m => m.ticker === t)?.price, drop: p - (markets.find(m => m.ticker === t)?.price || p) })),
}));
app.get("/health", (req, res) => res.json({ status: "ok", scans: scanCount, markets: markets.length }));

// ============================================================
// START
// ============================================================
console.log("=".repeat(50));
console.log("  TENNIS LIVE SCANNER v10 — SIMPLE");
console.log("  Markets: ALL live ATP/WTA");
console.log("  Signals: peak≥50 + drop≥3");
console.log("  Poll: every 3s");
console.log(`  Auth: ${API_KEY_ID ? "✓" : "✗"} key | ${PRIVATE_KEY ? "✓" : "✗"} pem`);
console.log("=".repeat(50));

scan();
setInterval(scan, POLL_INTERVAL);

app.listen(PORT, () => console.log(`[SERVER] Port ${PORT}`));
