import express from "express";
import cors from "cors";
import crypto from "crypto";
import fs from "fs";

const app = express();
app.use(cors());
app.use(express.json());

// ============================================================
// CONFIG — TENNIS-ONLY LIVE SCANNER v9.0
// ============================================================
const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";
const POLL_INTERVAL = 8000;            // full discovery cycle (8s — rate-limit safe)
const BOOK_BATCH_DELAY = 250;          // 250ms between orderbook fetches
const DISCOVERY_INTERVAL = 2 * 60 * 1000; // re-discover every 2 min
const MAX_DISCOVERY_PAGES = 15;
const FETCH_CONCURRENCY = 3;           // reduced from 6 to avoid 429s
const PORT = process.env.PORT || 3001;

// Tennis ticker prefixes
const TENNIS_PREFIXES = ["KXATP", "KXWTA", "KXTENNIS"];

// ============================================================
// AUTH — RSA-SHA256 signature
// ============================================================
const API_KEY_ID = process.env.KALSHI_API_KEY || "";
let PRIVATE_KEY = "";

const PEM_PATHS = [
  "kalshi_private_key.pem",
  "/app/kalshi_private_key.pem",
  "./kalshi_private_key.pem",
];

for (const p of PEM_PATHS) {
  try {
    if (fs.existsSync(p)) {
      PRIVATE_KEY = fs.readFileSync(p, "utf8");
      console.log(`[AUTH] Loaded private key from ${p}`);
      break;
    }
  } catch {}
}

if (!PRIVATE_KEY && process.env.KALSHI_PRIVATE_KEY_PEM) {
  PRIVATE_KEY = process.env.KALSHI_PRIVATE_KEY_PEM;
  console.log("[AUTH] Loaded private key from env KALSHI_PRIVATE_KEY_PEM");
}

function signRequest(method, path) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const message = timestamp + method.toUpperCase() + path;
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(message);
  sign.end();
  const signature = sign.sign(PRIVATE_KEY, "base64");
  return { timestamp, signature };
}

let rateLimitBackoff = 0; // ms to wait before next API call

async function kalshiFetch(path) {
  // Respect rate limit backoff
  if (rateLimitBackoff > 0) {
    const wait = rateLimitBackoff;
    rateLimitBackoff = 0;
    await sleep(wait);
  }

  const headers = { "Content-Type": "application/json" };

  if (API_KEY_ID && PRIVATE_KEY) {
    const { timestamp, signature } = signRequest("GET", path);
    headers["KALSHI-ACCESS-KEY"] = API_KEY_ID;
    headers["KALSHI-ACCESS-SIGNATURE"] = signature;
    headers["KALSHI-ACCESS-TIMESTAMP"] = timestamp;
  }

  const res = await fetch(`${KALSHI_BASE}${path}`, { headers });

  if (res.status === 429) {
    console.warn("[RATE LIMIT] 429 — backing off 45s");
    rateLimitBackoff = 45000;
    throw new Error("Rate limited (429)");
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Kalshi API ${res.status}: ${text}`);
  }
  return res.json();
}

// ============================================================
// STATE
// ============================================================
let markets = [];          // ALL live tennis markets (always displayed)
let opportunities = [];    // only comeback signals
let lastScan = 0;
let scanCount = 0;
let previousPrices = {};
let peakPrices = {};
let priceHistory = {};
const HISTORY_LENGTH = 10;
let lastDiscoveryTime = 0;
let discoveredTennisMarkets = []; // raw market objects from discovery
let discoveryStats = { total: 0, tennisFound: 0, liveDisplayed: 0 };
const startTime = Date.now();

// ============================================================
// HELPERS
// ============================================================
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dollarsToCents(val) {
  if (typeof val === "number") return Math.round(val * 100);
  const n = parseFloat(val);
  return isNaN(n) ? 0 : Math.round(n * 100);
}

function parseVolume(m) {
  const v = m.volume || m.volume_fp || m.volume_24h_fp || "0";
  return typeof v === "number" ? v : parseFloat(v) || 0;
}

function extractPrices(m) {
  return {
    yes_bid: dollarsToCents(m.yes_bid_dollars || m.yes_bid || 0),
    yes_ask: dollarsToCents(m.yes_ask_dollars || m.yes_ask || 0),
    no_bid: dollarsToCents(m.no_bid_dollars || m.no_bid || 0),
    no_ask: dollarsToCents(m.no_ask_dollars || m.no_ask || 0),
    last_price: dollarsToCents(m.last_price_dollars || m.last_price || 0),
    prev_price: dollarsToCents(m.previous_price_dollars || m.previous_price || 0),
    volume: parseVolume(m),
  };
}

function isTennisMarket(m) {
  if (!m || !m.ticker) return false;
  const upper = m.ticker.toUpperCase();
  return TENNIS_PREFIXES.some(p => upper.startsWith(p));
}

function isLiveMarket(m) {
  if (!m) return false;
  const status = (m.status || "").toLowerCase();
  const gameStatus = (m.game_status || m.result || "").toLowerCase();
  if (["closed", "settled", "finalized", "inactive"].includes(status)) return false;
  if (["settled", "closed", "finalized"].includes(gameStatus)) return false;
  return true;
}

function isCleanSingleMatch(m) {
  if (!m) return false;
  const title = (m.title || "").toLowerCase();
  const ticker = (m.ticker || "").toUpperCase();

  // Reject combos/parlays
  if (title.includes(",") || title.includes("+")) return false;
  if (ticker.includes("MULTI") || ticker.includes("COMBO") || ticker.includes("PARLAY")) return false;

  // Reject props
  if (/\b(points?|rebounds?|assists?|over\/?under|total|at least|or more|\d+\+)\b/i.test(title)) return false;

  // Must have match-like pattern
  const hasVs = /\bvs\.?\b/i.test(m.title || "");
  const hasWillWin = /\bwill\b.*\bwin\b/i.test(title);
  const hasMatch = /\bmatch\b/i.test(title);

  return hasVs || hasWillWin || hasMatch;
}

function bestBookPrice(levels) {
  if (!Array.isArray(levels) || levels.length === 0) return 0;
  return levels.reduce((best, [price]) => Math.max(best, dollarsToCents(price)), 0);
}

function bookDepth(levels) {
  if (!Array.isArray(levels)) return 0;
  return levels.slice(0, 5).reduce((sum, [, qty]) => sum + (parseFloat(qty) || 0), 0);
}

function summarizeOrderbook(orderbookData) {
  const book = orderbookData?.orderbook_fp || {};
  const yesLevels = Array.isArray(book.yes_dollars) ? book.yes_dollars : [];
  const noLevels = Array.isArray(book.no_dollars) ? book.no_dollars : [];
  const yesBid = bestBookPrice(yesLevels);
  const noBid = bestBookPrice(noLevels);
  const yesAsk = noBid ? Math.max(0, 100 - noBid) : 0;
  const noAsk = yesBid ? Math.max(0, 100 - yesBid) : 0;
  const midpoint = yesBid && yesAsk ? Math.round((yesBid + yesAsk) / 2) : yesBid || yesAsk || 0;
  return { yesBid, yesAsk, noBid, noAsk, midpoint, volume: bookDepth(yesLevels) + bookDepth(noLevels) };
}

function normalizeMarket(m) {
  const p = extractPrices(m);
  const displayTitle = (m.title || m.ticker).replace(/\s+winner\??$/i, "").trim();
  const price = p.yes_ask || p.last_price || p.prev_price || 0;
  const prev = previousPrices[m.ticker] ?? price;
  const spread = (p.yes_ask && p.yes_bid) ? p.yes_ask - p.yes_bid : 0;

  // Seed peak
  if (!peakPrices[m.ticker]) {
    const seedPeak = Math.max(price, prev, p.last_price || 0, p.prev_price || 0);
    if (seedPeak > 0) peakPrices[m.ticker] = seedPeak;
  }

  return {
    ticker: m.ticker,
    title: displayTitle,
    match: displayTitle,
    price,
    prev,
    spread,
    volume: p.volume,
    gameState: m.status || "active",
    status: "LIVE",
    sport: "TENNIS",
    yes_bid: p.yes_bid,
    yes_ask: p.yes_ask,
    no_bid: p.no_bid,
    no_ask: p.no_ask,
  };
}

// ============================================================
// DISCOVERY — Find ALL live tennis markets
// ============================================================
async function discoverTennisMarkets() {
  const allMarkets = [];
  let cursor = null;

  for (let page = 0; page < MAX_DISCOVERY_PAGES; page++) {
    try {
      const params = new URLSearchParams({ limit: "200", status: "open" });
      if (cursor) params.set("cursor", cursor);

      const data = await kalshiFetch(`/markets?${params.toString()}`);
      const batch = data.markets || [];
      allMarkets.push(...batch);

      cursor = data.cursor;
      if (!cursor || batch.length === 0) break;
      await sleep(400); // rate-limit safe delay between pages
    } catch (err) {
      console.warn(`[DISCOVERY] Page ${page} error: ${err.message}`);
      if (err.message.includes("429")) {
        await sleep(45000);
      }
      break;
    }
  }

  console.log(`[DISCOVERY] Fetched ${allMarkets.length} total markets from API`);

  // Filter: ONLY tennis + live + clean single match
  const tennisOnly = allMarkets.filter(m =>
    isTennisMarket(m) && isLiveMarket(m) && isCleanSingleMatch(m)
  );

  console.log(`[DISCOVERY] Found ${tennisOnly.length} live tennis match markets`);

  // Also log what we rejected
  const tennisAll = allMarkets.filter(isTennisMarket);
  const tennisLive = tennisAll.filter(isLiveMarket);
  const tennisRejected = tennisLive.filter(m => !isCleanSingleMatch(m));
  if (tennisRejected.length > 0) {
    console.log(`[DISCOVERY] Rejected ${tennisRejected.length} non-match tennis markets: ${tennisRejected.slice(0, 3).map(m => m.title).join(" | ")}`);
  }

  discoveredTennisMarkets = tennisOnly;
  lastDiscoveryTime = Date.now();
  discoveryStats = {
    total: allMarkets.length,
    tennisFound: tennisOnly.length,
    tennisAll: tennisAll.length,
    tennisLive: tennisLive.length,
  };

  return tennisOnly;
}

// ============================================================
// HYDRATE — Get live prices for tennis markets (rate-limit safe)
// ============================================================
async function hydrateTennisMarkets(tennisMarkets) {
  const hydrated = [];

  for (let i = 0; i < tennisMarkets.length; i++) {
    const market = tennisMarkets[i];
    try {
      const bookData = await kalshiFetch(`/markets/${market.ticker}/orderbook`);
      const book = summarizeOrderbook(bookData);
      hydrated.push({
        ...market,
        yes_bid_dollars: book.yesBid / 100,
        yes_ask_dollars: book.yesAsk / 100,
        no_bid_dollars: book.noBid / 100,
        no_ask_dollars: book.noAsk / 100,
        last_price_dollars: book.midpoint / 100,
        previous_price_dollars: (previousPrices[market.ticker] || book.midpoint) / 100,
        volume: book.volume || parseVolume(market),
      });

      // Delay between each orderbook fetch to avoid 429
      if (i < tennisMarkets.length - 1) {
        await sleep(BOOK_BATCH_DELAY);
      }
    } catch (err) {
      console.warn(`[HYDRATE] ${market.ticker}: ${err.message}`);
      if (err.message.includes("429")) {
        await sleep(45000);
      }
      // Still include market with basic data
      hydrated.push(market);
    }
  }

  return hydrated;
}

// ============================================================
// SIGNAL ENGINE — TENNIS COMEBACK DETECTOR
// ============================================================
// Tennis-specific: low thresholds, no stabilization, fast reversals
// ============================================================

function updatePriceHistory(ticker, price) {
  if (!priceHistory[ticker]) priceHistory[ticker] = [];
  priceHistory[ticker].push(price);
  if (priceHistory[ticker].length > HISTORY_LENGTH) priceHistory[ticker].shift();
}

function getMomentum(ticker) {
  const hist = priceHistory[ticker];
  if (!hist || hist.length < 3) return "FLAT";
  const last3 = hist.slice(-3);
  if (last3[0] > last3[1] && last3[1] > last3[2]) return "DOWN";
  if (last3[0] < last3[1] && last3[1] < last3[2]) return "UP";
  return "FLAT";
}

function getMomentumBoost(ticker) {
  const mom = getMomentum(ticker);
  if (mom === "DOWN") return 15;
  if (mom === "UP") return 5;
  return 0;
}

function getComebackSignal(m) {
  if (!m) return null;
  const peak = peakPrices[m.ticker] || m.price;
  const price = m.price;
  const prev = m.prev;

  // Tennis thresholds: peak ≥ 50, drop ≥ 3
  if (peak < 50) return null;
  const drop = peak - price;
  if (drop < 3) return null;
  if (price < 10 || price > 92) return null;

  const recovering = price > prev;

  let score = 0;

  // Drop scoring
  if (drop >= 16) score += 40;
  else if (drop >= 12) score += 30;
  else if (drop >= 8) score += 20;
  else if (drop >= 5) score += 12;
  else score += 5;

  // Recovery / fast reversal (no stabilization needed for tennis)
  if (recovering) score += 30;
  if (recovering && drop >= 5) score += 15; // fast reversal bonus

  score += getMomentumBoost(m.ticker);

  // Volume
  if (m.volume >= 5000) score += 15;
  else if (m.volume >= 2000) score += 10;
  else if (m.volume >= 500) score += 5;

  // Spread — wider spread = more volatile = interesting for tennis
  if (m.spread >= 5) score += 10;

  score = Math.max(0, Math.min(100, score));

  // Level
  let level = "WEAK";
  if (drop >= 8 && score >= 50) level = "STRONG";
  else if (drop >= 5 && score >= 30) level = "NORMAL";

  const momentum = getMomentum(m.ticker);

  return {
    id: `${m.ticker}-comeback-${Date.now()}`,
    type: "COMEBACK",
    match: m.match,
    sport: "TENNIS",
    ticker: m.ticker,
    price,
    prev,
    edge: drop,
    direction: "YES",
    timestamp: Date.now(),
    description: `Peaked at ${peak}¢, dropped ${drop}¢ to ${price}¢ — ${recovering ? "recovering" : "falling"} [${momentum}]`,
    strength: level,
    score,
    action: "BUY",
    peakPrice: peak,
    dropSize: drop,
    recovering,
    volume: m.volume,
    spread: m.spread,
  };
}

function getTennisSpikeSignal(m) {
  if (!m) return null;
  const price = m.price;
  if (price < 75) return null;
  if (m.volume < 500) return null;

  const hist = priceHistory[m.ticker];
  const earliestPrice = hist && hist.length > 0 ? hist[0] : m.prev;
  const wasEven = earliestPrice >= 35 && earliestPrice <= 65;
  if (!wasEven) return null;

  let level = "WEAK";
  let score = 30;

  if (price >= 95) { level = "STRONG"; score = 85; }
  else if (price >= 90) { level = "STRONG"; score = 75; }
  else if (price >= 85) { level = "NORMAL"; score = 60; }
  else if (price >= 80) { level = "NORMAL"; score = 50; }
  else { level = "WEAK"; score = 40; }

  if (m.volume >= 5000) score += 15;
  else if (m.volume >= 2000) score += 10;

  const fading = m.price < m.prev;
  if (fading) score += 15;

  score = Math.max(0, Math.min(100, score));

  return {
    id: `${m.ticker}-spike-${Date.now()}`,
    type: "COMEBACK",
    match: m.match,
    sport: "TENNIS",
    ticker: m.ticker,
    price,
    prev: m.prev,
    edge: price - earliestPrice,
    direction: "NO",
    timestamp: Date.now(),
    description: `TENNIS SPIKE: Was ~${earliestPrice}¢, now ${price}¢ — overextended${fading ? " [FADING]" : ""}`,
    strength: level,
    score,
    action: "BUY",
    peakPrice: price,
    dropSize: 0,
    recovering: false,
    volume: m.volume,
    spread: m.spread,
  };
}

function getEarlySetupSignal(m) {
  if (!m) return null;
  const price = m.price;
  if (price < 60) return null;
  if (m.spread < 2) return null;
  if (m.volume < 500) return null;

  const peak = peakPrices[m.ticker] || price;
  const drop = peak - price;
  if (drop >= 3) return null; // comeback handles it

  let score = 10;
  if (price >= 80) score += 20;
  else if (price >= 75) score += 15;
  else if (price >= 70) score += 10;
  else if (price >= 65) score += 5;

  if (m.spread >= 5) score += 15;
  else if (m.spread >= 3) score += 10;

  if (m.volume >= 5000) score += 15;
  else if (m.volume >= 2000) score += 10;

  score += getMomentumBoost(m.ticker);
  score = Math.max(0, Math.min(100, score));

  return {
    id: `${m.ticker}-setup-${Date.now()}`,
    type: "COMEBACK",
    match: m.match,
    sport: "TENNIS",
    ticker: m.ticker,
    price,
    prev: m.prev,
    edge: 0,
    direction: "YES",
    timestamp: Date.now(),
    description: `SETUP: Favorite at ${price}¢ with ${m.spread}¢ spread — watching for drop`,
    strength: "WEAK",
    score,
    action: "BUY",
    peakPrice: peak,
    dropSize: 0,
    recovering: false,
    volume: m.volume,
    spread: m.spread,
  };
}

// ============================================================
// MAIN SCAN LOOP
// ============================================================
let scanning = false;

async function scanTennisMarkets() {
  if (scanning) return; // prevent overlapping scans
  scanning = true;

  try {
    const now = Date.now();

    // Re-discover periodically or on first run
    if (!discoveredTennisMarkets.length || now - lastDiscoveryTime >= DISCOVERY_INTERVAL) {
      await discoverTennisMarkets();
    }

    if (discoveredTennisMarkets.length === 0) {
      console.log("[SCAN] No tennis markets discovered — waiting...");
      scanning = false;
      return;
    }

    // Hydrate with live orderbook data (sequential to avoid 429)
    const hydrated = await hydrateTennisMarkets(discoveredTennisMarkets);

    // Normalize ALL tennis markets (no filtering — show everything)
    const normalized = hydrated
      .map(normalizeMarket)
      .filter(m => m.price > 0); // only skip truly broken data

    // Update price tracking for ALL markets
    for (const m of normalized) {
      updatePriceHistory(m.ticker, m.price);
      const currentPeak = peakPrices[m.ticker] || 0;
      if (m.price > currentPeak) peakPrices[m.ticker] = m.price;
      const prev = previousPrices[m.ticker];
      if (prev !== undefined && prev > (peakPrices[m.ticker] || 0)) {
        peakPrices[m.ticker] = prev;
      }
    }

    // SIGNAL DETECTION — separate from market display
    const newOpps = [];
    const seen = new Set();
    for (const m of normalized) {
      if (seen.has(m.ticker)) continue;
      const comeback = getComebackSignal(m);
      if (comeback) { seen.add(m.ticker); newOpps.push(comeback); continue; }
      const spike = getTennisSpikeSignal(m);
      if (spike) { seen.add(m.ticker); newOpps.push(spike); continue; }
      const setup = getEarlySetupSignal(m);
      if (setup) { seen.add(m.ticker); newOpps.push(setup); continue; }
    }
    newOpps.sort((a, b) => b.score - a.score);

    // Update previous prices AFTER detection
    for (const m of normalized) {
      previousPrices[m.ticker] = m.price;
    }

    // Merge signals (keep newest per ticker)
    const tickerMap = new Map();
    for (const opp of [...newOpps, ...opportunities]) {
      if (!tickerMap.has(opp.ticker)) tickerMap.set(opp.ticker, opp);
    }
    opportunities = Array.from(tickerMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, 50);

    // Sort markets by volume (most active first)
    markets = normalized.sort((a, b) => b.volume - a.volume);
    lastScan = Date.now();
    scanCount++;

    discoveryStats.liveDisplayed = markets.length;

    const levelCounts = { STRONG: 0, NORMAL: 0, WEAK: 0 };
    opportunities.forEach(o => { levelCounts[o.strength] = (levelCounts[o.strength] || 0) + 1; });

    console.log(
      `[SCAN #${scanCount}] ${markets.length} live tennis markets | ${opportunities.length} signals (S:${levelCounts.STRONG} N:${levelCounts.NORMAL} W:${levelCounts.WEAK}) | Hydration: ${hydrated.length}/${discoveredTennisMarkets.length}`
    );
  } catch (err) {
    console.error("[SCAN ERROR]", err.message);
  } finally {
    scanning = false;
  }
}

// ============================================================
// API ROUTES
// ============================================================
app.get("/api/markets", (req, res) => {
  res.json(markets);
});

app.get("/api/opportunities", (req, res) => {
  res.json(opportunities);
});

app.get("/api/status", (req, res) => {
  const levelCounts = { STRONG: 0, NORMAL: 0, WEAK: 0 };
  opportunities.forEach(o => { levelCounts[o.strength] = (levelCounts[o.strength] || 0) + 1; });

  res.json({
    connected: markets.length > 0 || scanCount > 0,
    lastScan,
    marketsScanned: markets.length,
    activeOpportunities: opportunities.length,
    sports: { TENNIS: markets.length },
    totalSignals: opportunities.length,
    signalLevels: levelCounts,
    uptime: (Date.now() - startTime) / 1000,
  });
});

app.get("/api/debug", (req, res) => {
  res.json({
    scanCount,
    totalMarkets: markets.length,
    totalSignals: opportunities.length,
    discoveryStats,
    peaksTracked: Object.keys(peakPrices).length,
    sampleMarkets: markets.slice(0, 10).map(m => ({
      ticker: m.ticker, price: m.price, prev: m.prev, spread: m.spread, volume: m.volume,
      peak: peakPrices[m.ticker] || m.price, drop: (peakPrices[m.ticker] || m.price) - m.price,
    })),
  });
});

app.get("/api/peaks-debug", (req, res) => {
  const peakEntries = Object.entries(peakPrices).map(([ticker, peak]) => {
    const market = markets.find(m => m.ticker === ticker);
    const currentPrice = market ? market.price : null;
    const drop = currentPrice !== null ? peak - currentPrice : null;
    const volume = market ? market.volume : null;
    return {
      ticker, peak, currentPrice, drop, volume,
      wouldSignal: peak >= 50 && drop >= 3 && currentPrice >= 10 && currentPrice <= 92,
    };
  });
  peakEntries.sort((a, b) => (b.drop || 0) - (a.drop || 0));
  res.json({ totalPeaksTracked: peakEntries.length, totalMarkets: markets.length, scanCount, peaks: peakEntries });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", scans: scanCount, markets: markets.length, signals: opportunities.length });
});

// ============================================================
// START — TENNIS-ONLY LIVE SCANNER
// ============================================================
console.log("=".repeat(60));
console.log("  KALSHI TENNIS SCANNER v9.0 — LIVE ONLY");
console.log("  Markets: ALL live ATP/WTA matches (no filtering)");
console.log("  Signals: Comeback detection (50¢ peak, 3¢ drop)");
console.log("  Polling: Every 8s (rate-limit safe)");
console.log("  Hydration: Sequential with 250ms delay");
console.log("  Strategies: COMEBACK | SPIKE | SETUP");
console.log(`  API Key: ${API_KEY_ID ? "✓ configured" : "✗ missing"}`);
console.log(`  Private Key: ${PRIVATE_KEY ? "✓ loaded" : "✗ missing"}`);
console.log("=".repeat(60));

// Initial scan
scanTennisMarkets();

// Continuous polling
setInterval(scanTennisMarkets, POLL_INTERVAL);

app.listen(PORT, () => {
  console.log(`[SERVER] Listening on port ${PORT}`);
});
