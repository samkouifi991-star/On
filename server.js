import express from "express";
import cors from "cors";
import crypto from "crypto";
import fs from "fs";

const app = express();
app.use(cors());
app.use(express.json());

// ============================================================
// CONFIG
// ============================================================
const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";
const TICKER_PREFIX = "KXMVESPORTSMULTIGAMEEXTENDED";
const POLL_INTERVAL = 15000; // 15s to avoid 429s
const PORT = process.env.PORT || 3001;

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

async function kalshiFetch(path) {
  const headers = { "Content-Type": "application/json" };

  if (API_KEY_ID && PRIVATE_KEY) {
    const { timestamp, signature } = signRequest("GET", path);
    headers["KALSHI-ACCESS-KEY"] = API_KEY_ID;
    headers["KALSHI-ACCESS-SIGNATURE"] = signature;
    headers["KALSHI-ACCESS-TIMESTAMP"] = timestamp;
  }

  const res = await fetch(`${KALSHI_BASE}${path}`, { headers });

  // Rate limit backoff
  if (res.status === 429) {
    console.warn("[RATE LIMIT] 429 — backing off 30s");
    await new Promise((r) => setTimeout(r, 30000));
    throw new Error("Rate limited (429)");
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Kalshi API ${res.status}: ${text}`);
  }
  return res.json();
}

// ============================================================
// STATE + CACHE
// ============================================================
let markets = [];
let opportunities = [];
let lastScan = 0;
let scanCount = 0;
let previousPrices = {};
let peakPrices = {};       // Track peak price per ticker
let lastSignalTime = {};   // Cooldown tracker per ticker
let lastFetchTime = 0;
const startTime = Date.now();

// ============================================================
// FILTERS
// ============================================================
// Helper: parse dollar string to cents (integer)
function dollarsToCents(val) {
  if (typeof val === "number") return Math.round(val * 100);
  const n = parseFloat(val);
  return isNaN(n) ? 0 : Math.round(n * 100);
}

// Helper: parse volume string to number
function parseVolume(m) {
  const v = m.volume || m.volume_fp || m.volume_24h_fp || "0";
  return typeof v === "number" ? v : parseFloat(v) || 0;
}

// Helper: extract cent prices from API market object
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

function isSportsMarket(m) {
  if (!m || typeof m.ticker !== "string") return false;
  return m.ticker.startsWith(TICKER_PREFIX) || m.ticker.startsWith("KXMVECROSSCATEGORY");
}

// Combo markets are ONE-SIDED: yes_bid is almost always 0.
// We accept any market that has a yes_ask price (the real price).
function isTradableMarket(m) {
  if (!m) return false;
  const p = extractPrices(m);
  const price = p.yes_ask || p.last_price || p.prev_price;
  // Accept if there's any meaningful price data
  return price > 0;
}

function classifySport(title, ticker) {
  const t = ((title || "") + " " + (ticker || "")).toLowerCase();
  if (/kxnba|nba|basketball|lakers|celtics|nuggets|warriors|bucks|76ers|knicks|nets|heat|suns|mavs|clippers|rockets|thunder|timberwolves|grizzlies|pelicans|kings|hawks|cavaliers|pistons|pacers|magic|bulls|hornets|wizards|raptors|spurs|blazers|jazz|denver|boston|san antonio|cleveland|minnesota|philadelphia|phoenix|los angeles l|chicago|dallas|memphis|atlanta|miami|sacramento|detroit|indiana|orlando|charlotte|washington|toronto|portland|utah|new york k|brooklyn|houston|oklahoma|golden state|milwaukee|jokić|murray|wembanyama|mitchell|harden|giddey|mobley|braun|johnson|porziņģis|draymond|green|castle|vassell/i.test(t)) return "NBA";
  if (/kxnfl|nfl|football|chiefs|eagles|bills|49ers|cowboys|ravens|dolphins|lions|bengals|steelers|texans|packers|jaguars|broncos|seahawks|chargers|vikings|saints|falcons|bears|commanders|browns|panthers|titans|raiders|colts|rams|buccaneers/i.test(t)) return "NFL";
  if (/kxnhl|nhl|hockey|rangers|bruins|oilers|avalanche|hurricanes|stars|maple leafs|canadiens|lightning|penguins|capitals|flames|senators|kraken|blue jackets|sabres|red wings|islanders|devils|wild|predators|canucks|ducks|coyotes|sharks|blues|blackhawks|flyers|goals scored/i.test(t)) return "NHL";
  if (/kxtennis|tennis|atp|wta|djokovic|sinner|alcaraz|medvedev|zverev|rublev|tsitsipas|ruud|fritz|swiatek|sabalenka|gauff|rybakina|pegula|halys|schwaerzler|navone|shevchenko|tirante|vallejo|vukic|udvardy|merida|hurkacz|roland|french|wimbledon/i.test(t)) return "TENNIS";
  if (/kxmlb|mlb|baseball|yankees|red sox|dodgers|mets|cubs|braves|astros|phillies|padres|mariners|orioles|guardians|twins|royals|brewers|diamondbacks|reds|pirates|rays|blue jays|angels|athletics|marlins|nationals|rockies|white sox|tigers|cardinals|cincinnati|tampa bay|kansas city|new york y|new york m|arizona|colorado|san francisco|san diego|seattle|baltimore|st\. louis|runs scored|stanton|judge/i.test(t)) return "MLB";
  // Fallback: check custom_strike Associated Events for sport prefixes
  return "OTHER";
}

function normalizeMarket(m) {
  const p = extractPrices(m);
  const customStrike = m.custom_strike || {};
  const associatedEvents = customStrike["Associated Events"] || "";
  const sport = classifySport((m.title || m.ticker) + " " + associatedEvents, m.ticker);

  // For one-sided combo markets: yes_ask IS the price
  const price = p.yes_ask || p.last_price || p.prev_price || 0;
  const prev = previousPrices[m.ticker] ?? price;
  // Spread only meaningful when both sides exist
  const spread = (p.yes_ask && p.yes_bid) ? p.yes_ask - p.yes_bid : 0;

  return {
    ticker: m.ticker,
    title: m.title || m.ticker,
    match: m.title || m.ticker,
    price,
    prev,
    spread,
    volume: p.volume,
    gameState: m.status || "active",
    status: "LIVE",
    sport,
    yes_bid: p.yes_bid,
    yes_ask: p.yes_ask,
    no_bid: p.no_bid,
    no_ask: p.no_ask,
  };
}

// ============================================================
// SIGNAL ENGINE v5 — FAVORITE COMEBACK DETECTOR (strict filters)
// ============================================================
// Only detects high-quality comeback setups:
//   1. Strong favorite (peak ≥ 65¢)
//   2. Large panic drop (≥ 20¢ from peak)
//   3. Price in recovery zone (20-70¢)
//   4. Liquidity confirmed (volume ≥ 100, spread ≤ 5¢)
//   5. Stabilizing or recovering (not still falling)
//   6. 60s cooldown per market (prevent spam)
// ============================================================

const SIGNAL_COOLDOWN_MS = 60000; // 60 seconds

function isComebackOpportunity(m) {
  if (!m) return false;

  const peak = peakPrices[m.ticker] || m.price;
  const price = m.price;
  const prev = m.prev;

  // FAVORITE FILTER: peak must have been a strong favorite
  if (peak < 65) return false;

  // PANIC DROP: must have dropped at least 20¢ from peak
  const drop = peak - price;
  if (drop < 20) return false;

  // PRICE ZONE: avoid dead or already recovered markets
  if (price < 20 || price > 70) return false;

  // LIQUIDITY: must have real trading activity
  if (m.volume < 100) return false;
  if (m.spread > 5) return false;

  // STABILIZATION / RECOVERY: price must not still be falling
  const stabilizing = Math.abs(price - prev) < 2;
  const recovering = price > prev;
  if (!(stabilizing || recovering)) return false;

  // COOLDOWN: don't signal same market within 60s
  const lastSignal = lastSignalTime[m.ticker] || 0;
  if (Date.now() - lastSignal < SIGNAL_COOLDOWN_MS) return false;

  return true;
}

function detectOpportunities(currentMarkets) {
  const newOpps = [];

  for (const m of currentMarkets) {
    if (m.price <= 0) continue;

    // Update peak price tracking
    const currentPeak = peakPrices[m.ticker] || 0;
    if (m.price > currentPeak) {
      peakPrices[m.ticker] = m.price;
    }

    // Skip first scan (no baseline)
    const prev = previousPrices[m.ticker];
    if (prev === undefined) continue;

    // Update peak from historical data too
    if (prev > (peakPrices[m.ticker] || 0)) {
      peakPrices[m.ticker] = prev;
    }

    if (!isComebackOpportunity(m)) continue;

    const peak = peakPrices[m.ticker];
    const drop = peak - m.price;
    const recovering = m.price > prev;

    // Record signal time for cooldown
    lastSignalTime[m.ticker] = Date.now();

    newOpps.push({
      id: `${m.ticker}-comeback-${Date.now()}`,
      type: "COMEBACK",
      match: m.match,
      sport: m.sport,
      ticker: m.ticker,
      price: m.price,
      prev,
      edge: drop,
      direction: "YES",
      timestamp: Date.now(),
      description: `Favorite comeback: peaked at ${peak}¢, dropped ${drop}¢ to ${m.price}¢ — ${recovering ? "recovering" : "stabilizing"}`,
      strength: drop >= 30 ? "STRONG" : "MODERATE",
      peakPrice: peak,
      dropSize: drop,
      recovering,
      action: "BUY",
      volume: m.volume,
      spread: m.spread,
    });
  }

  return newOpps;
}

// ============================================================
// MARKET FETCHING — with cache + backoff
// ============================================================
async function fetchAllMarkets() {
  const now = Date.now();

  // Cache guard — don't re-fetch within interval
  if (now - lastFetchTime < POLL_INTERVAL - 1000) {
    return;
  }

  const allMarkets = [];
  let cursor = null;

  try {
    // Fetch max 10 pages (2000 markets) to capture sports markets
    for (let page = 0; page < 10; page++) {
      const params = new URLSearchParams({ limit: "200", status: "open" });
      if (cursor) params.set("cursor", cursor);

      const data = await kalshiFetch(`/markets?${params.toString()}`);
      const batch = data.markets || [];
      allMarkets.push(...batch);

      cursor = data.cursor;
      if (!cursor || batch.length === 0) break;

      // Small delay between pages to avoid burst rate limits
      if (cursor) await new Promise((r) => setTimeout(r, 500));
    }

    lastFetchTime = Date.now();

    // Filter: sports → has price → normalize → cap at 500
    const sportsMarkets = allMarkets.filter(isSportsMarket);
    const tradable = sportsMarkets.filter(isTradableMarket);
    const normalized = tradable.slice(0, 500).map(normalizeMarket);

    // Keep NBA, NFL, NHL, TENNIS, MLB (drop only unclassified OTHER)
    const filtered = normalized.filter(
      (m) => ["NBA", "NFL", "NHL", "TENNIS", "MLB"].includes(m.sport)
    );

    // Detect opportunities before updating prices
    const newOpps = detectOpportunities(filtered);

    // Update previous prices AFTER detection
    for (const m of filtered) {
      previousPrices[m.ticker] = m.price;
    }

    // Keep last 20 opportunities (fewer, higher quality)
    opportunities = [...newOpps, ...opportunities].slice(0, 20);
    markets = filtered;
    lastScan = Date.now();
    scanCount++;

    const sportCounts = {};
    filtered.forEach((m) => {
      sportCounts[m.sport] = (sportCounts[m.sport] || 0) + 1;
    });

    console.log(
      `[SCAN #${scanCount}] ${allMarkets.length} total → ${sportsMarkets.length} sports → ${tradable.length} priced → ${filtered.length} tracked | NewOpps: ${newOpps.length} TotalOpps: ${opportunities.length} | Sports: ${JSON.stringify(sportCounts)}`
    );
  } catch (err) {
    console.error("[SCAN ERROR]", err.message);
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
  const sportCounts = {};
  markets.forEach((m) => {
    sportCounts[m.sport] = (sportCounts[m.sport] || 0) + 1;
  });

  res.json({
    connected: markets.length > 0 || scanCount > 0,
    lastScan,
    marketsScanned: markets.length,
    activeOpportunities: opportunities.length,
    sports: sportCounts,
    totalSignals: opportunities.length,
    uptime: (Date.now() - startTime) / 1000,
  });
});

app.get("/api/debug", (req, res) => {
  const sample = markets.slice(0, 5).map((m) => ({
    ticker: m.ticker,
    price: m.price,
    prev: m.prev,
    yes_ask: m.yes_ask,
    yes_bid: m.yes_bid,
    no_ask: m.no_ask,
    volume: m.volume,
    sport: m.sport,
  }));
  res.json({
    scanCount,
    totalTracked: markets.length,
    totalOpps: opportunities.length,
    trackedTickers: Object.keys(previousPrices).length,
    sampleMarkets: sample,
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", scans: scanCount, markets: markets.length });
});

// ============================================================
// START
// ============================================================
console.log("=".repeat(60));
console.log("  KALSHI EDGE SCANNER — LIVE BACKEND v5.0 (comeback-only)");
console.log("  Signal Mode: FAVORITE COMEBACK DETECTOR (strict)");
console.log(`  API Key: ${API_KEY_ID ? "✓ configured" : "✗ missing KALSHI_API_KEY"}`);
console.log(`  Private Key: ${PRIVATE_KEY ? "✓ loaded" : "✗ missing PEM file"}`);
console.log(`  Ticker Filter: ${TICKER_PREFIX}`);
console.log(`  Poll Interval: ${POLL_INTERVAL}ms`);
console.log("=".repeat(60));

fetchAllMarkets();
setInterval(fetchAllMarkets, POLL_INTERVAL);

app.listen(PORT, () => {
  console.log(`[SERVER] Listening on port ${PORT}`);
});
