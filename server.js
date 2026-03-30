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
const POLL_INTERVAL = 15000;
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
let peakPrices = {};
let lastFetchTime = 0;
const startTime = Date.now();

// ============================================================
// HELPERS
// ============================================================
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

function isSportsMarket(m) {
  if (!m || typeof m.ticker !== "string") return false;

  const ticker = m.ticker.toUpperCase();

  // Keep current production sports source
  if (ticker.startsWith(TICKER_PREFIX) || ticker.startsWith("KXMVECROSSCATEGORY")) return true;

  // Also allow canonical direct sports series if present
  if (/^(KXNBA|KXNFL|KXNHL|KXTENNIS|KXMLB|KXSOCCER)/i.test(ticker)) return true;

  return false;
}

function isCleanSingleMarket(m) {
  if (!m) return false;

  const title = (m.title || "").toLowerCase().trim();
  const ticker = (m.ticker || "").toUpperCase();

  if (!title) return false;

  // Hard reject obvious combos/parlays
  if (title.includes(",")) return false;
  if (title.includes("+")) return false;
  if (ticker.includes("MULTI") || ticker.includes("COMBO") || ticker.includes("PARLAY")) return false;

  const yesMatches = title.match(/\byes\b/g) || [];
  if (yesMatches.length > 1) return false;

  const hasVs = /\bvs\.?\b/.test(title);
  const hasWillWin = /^will\s+.+\s+win\??$/i.test(title);
  const hasSingleYesWin = yesMatches.length === 1 && /\bwin\b/.test(title);

  // Allow exactly one clean winner-style structure
  if (!hasVs && !hasWillWin && !hasSingleYesWin) return false;

  // Reject player/team prop style markets (not match winner markets)
  if (/\b(points?|rebounds?|assists?|yards?|touchdowns?|strikeouts?|threes?|goals?\s+scored|over\/?under|total|at least|or more|\d+\+)\b/i.test(title)) {
    return false;
  }

  if (title.length > 120) return false;

  if (hasVs) {
    const sides = title.split(/\bvs\.?\b/).map((s) => s.trim()).filter(Boolean);
    if (sides.length !== 2) return false;
    if (sides[0].length < 2 || sides[1].length < 2) return false;
  }

  return true;
}

function isTradableMarket(m) {
  if (!m) return false;
  const p = extractPrices(m);
  const price = p.yes_ask || p.last_price || p.prev_price;
  return price > 0;
}

function classifySport(title, ticker) {
  const t = ((title || "") + " " + (ticker || "")).toLowerCase();
  if (/kxnba|nba|basketball|lakers|celtics|nuggets|warriors|bucks|76ers|knicks|nets|heat|suns|mavs|clippers|rockets|thunder|timberwolves|grizzlies|pelicans|kings|hawks|cavaliers|pistons|pacers|magic|bulls|hornets|wizards|raptors|spurs|blazers|jazz|denver|boston|san antonio|cleveland|minnesota|philadelphia|phoenix|los angeles l|chicago|dallas|memphis|atlanta|miami|sacramento|detroit|indiana|orlando|charlotte|washington|toronto|portland|utah|new york k|brooklyn|houston|oklahoma|golden state|milwaukee|jokić|murray|wembanyama|mitchell|harden|giddey|mobley|braun|johnson|porziņģis|draymond|green|castle|vassell/i.test(t)) return "NBA";
  if (/kxnfl|nfl|football|chiefs|eagles|bills|49ers|cowboys|ravens|dolphins|lions|bengals|steelers|texans|packers|jaguars|broncos|seahawks|chargers|vikings|saints|falcons|bears|commanders|browns|panthers|titans|raiders|colts|rams|buccaneers/i.test(t)) return "NFL";
  if (/kxnhl|nhl|hockey|rangers|bruins|oilers|avalanche|hurricanes|stars|maple leafs|canadiens|lightning|penguins|capitals|flames|senators|kraken|blue jackets|sabres|red wings|islanders|devils|wild|predators|canucks|ducks|coyotes|sharks|blues|blackhawks|flyers|goals scored/i.test(t)) return "NHL";
  if (/kxtennis|tennis|atp|wta|djokovic|sinner|alcaraz|medvedev|zverev|rublev|tsitsipas|ruud|fritz|swiatek|sabalenka|gauff|rybakina|pegula|halys|schwaerzler|navone|shevchenko|tirante|vallejo|vukic|udvardy|merida|hurkacz|roland|french|wimbledon/i.test(t)) return "TENNIS";
  if (/kxmlb|mlb|baseball|yankees|red sox|dodgers|mets|cubs|braves|astros|phillies|padres|mariners|orioles|guardians|twins|royals|brewers|diamondbacks|reds|pirates|rays|blue jays|angels|athletics|marlins|nationals|rockies|white sox|tigers|cardinals|cincinnati|tampa bay|kansas city|new york y|new york m|arizona|colorado|san francisco|san diego|seattle|baltimore|st\. louis|runs scored|stanton|judge/i.test(t)) return "MLB";
  return "OTHER";
}

function normalizeMarket(m) {
  const p = extractPrices(m);
  const customStrike = m.custom_strike || {};
  const associatedEvents = customStrike["Associated Events"] || "";
  const sport = classifySport((m.title || m.ticker) + " " + associatedEvents, m.ticker);

  const price = p.yes_ask || p.last_price || p.prev_price || 0;
  const prev = previousPrices[m.ticker] ?? price;
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
// SIGNAL ENGINE v6 — TIERED COMEBACK DETECTOR
// ============================================================
// Produces WEAK / NORMAL / STRONG signals using a scoring system.
// Base filters are relaxed (peak >= 60¢, drop >= 10¢) so signals
// are always present. Quality is ranked by score 0-100.
// ============================================================

function getComebackSignal(m) {
  if (!m) return null;

  const peak = peakPrices[m.ticker] || m.price;
  const price = m.price;
  const prev = m.prev;

  // Base filter: peak must have been a favorite
  if (peak < 60) return null;

  const drop = peak - price;
  if (drop < 10) return null;

  // Price zone filter
  if (price < 15 || price > 85) return null;

  const stabilizing = Math.abs(price - prev) < 2;
  const recovering = price > prev;

  // --- Scoring system (0-100) ---
  let score = 0;

  // Drop strength
  if (drop >= 20) score += 40;
  else if (drop >= 15) score += 25;
  else score += 10;

  // Recovery behavior
  if (recovering) score += 30;
  else if (stabilizing) score += 15;

  // Liquidity quality (bonuses)
  if (m.volume >= 100) score += 15;
  if (m.spread <= 5) score += 15;

  // Late game penalty (soft — reduces score, doesn't block)
  // We can't get real quarter/time from Kalshi API, so we skip
  // hard game-state checks. The penalty is available for future use.

  // Liquidity penalties
  if (m.volume < 50) score -= 20;
  if (m.spread > 7) score -= 20;

  // Clamp score
  score = Math.max(0, Math.min(100, score));

  // Determine level
  let level = "WEAK";
  if (score >= 70) level = "STRONG";
  else if (score >= 40) level = "NORMAL";

  return {
    id: `${m.ticker}-comeback-${Date.now()}`,
    type: "COMEBACK",
    match: m.match,
    sport: m.sport,
    ticker: m.ticker,
    price,
    prev,
    edge: drop,
    direction: "YES",
    timestamp: Date.now(),
    description: `Peaked at ${peak}¢, dropped ${drop}¢ to ${price}¢ — ${recovering ? "recovering" : stabilizing ? "stabilizing" : "falling"}`,
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

function detectOpportunities(currentMarkets) {
  const newOpps = [];
  const seen = new Set();

  for (const m of currentMarkets) {
    if (m.price <= 0) continue;

    // Update peak price tracking
    const currentPeak = peakPrices[m.ticker] || 0;
    if (m.price > currentPeak) {
      peakPrices[m.ticker] = m.price;
    }

    // Update peak from prev too
    const prev = previousPrices[m.ticker];
    if (prev !== undefined && prev > (peakPrices[m.ticker] || 0)) {
      peakPrices[m.ticker] = prev;
    }

    const signal = getComebackSignal(m);
    if (!signal) continue;

    // Deduplicate by ticker (keep highest score)
    if (seen.has(m.ticker)) continue;
    seen.add(m.ticker);

    newOpps.push(signal);
  }

  // Sort by score descending
  newOpps.sort((a, b) => b.score - a.score);
  return newOpps;
}

// ============================================================
// MARKET FETCHING
// ============================================================
async function fetchAllMarkets() {
  const now = Date.now();
  if (now - lastFetchTime < POLL_INTERVAL - 1000) return;

  const allMarkets = [];
  let cursor = null;

  try {
    for (let page = 0; page < 10; page++) {
      const params = new URLSearchParams({ limit: "200", status: "open" });
      if (cursor) params.set("cursor", cursor);

      const data = await kalshiFetch(`/markets?${params.toString()}`);
      const batch = data.markets || [];
      allMarkets.push(...batch);

      cursor = data.cursor;
      if (!cursor || batch.length === 0) break;
      if (cursor) await new Promise((r) => setTimeout(r, 500));
    }

    lastFetchTime = Date.now();

    const sportsMarkets = allMarkets.filter(isSportsMarket);
    const cleanMarkets = sportsMarkets
      .filter(isCleanSingleMarket)
      .filter(isTradableMarket);

    console.log("Sample clean markets:", cleanMarkets.slice(0, 5));

    const normalized = cleanMarkets.slice(0, 500).map(normalizeMarket);

    const filtered = normalized.filter(
      (m) => ["NBA", "NFL", "NHL", "TENNIS", "MLB"].includes(m.sport)
    );

    // Detect opportunities BEFORE updating prices
    const newOpps = detectOpportunities(filtered);

    // Update previous prices AFTER detection
    for (const m of filtered) {
      previousPrices[m.ticker] = m.price;
    }

    // Merge: new signals first, then keep recent old ones, cap at 50
    // Deduplicate by ticker — keep newest
    const tickerMap = new Map();
    for (const opp of [...newOpps, ...opportunities]) {
      if (!tickerMap.has(opp.ticker)) {
        tickerMap.set(opp.ticker, opp);
      }
    }
    opportunities = Array.from(tickerMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, 50);

    markets = filtered;
    lastScan = Date.now();
    scanCount++;

    const sportCounts = {};
    filtered.forEach((m) => {
      sportCounts[m.sport] = (sportCounts[m.sport] || 0) + 1;
    });

    const levelCounts = { STRONG: 0, NORMAL: 0, WEAK: 0 };
    opportunities.forEach((o) => {
      levelCounts[o.strength] = (levelCounts[o.strength] || 0) + 1;
    });

    console.log(
      `[SCAN #${scanCount}] ${allMarkets.length} total → ${sportsMarkets.length} sports → ${cleanMarkets.length} clean+tradable → ${filtered.length} tracked | Signals: ${opportunities.length} (S:${levelCounts.STRONG} N:${levelCounts.NORMAL} W:${levelCounts.WEAK}) | Sports: ${JSON.stringify(sportCounts)}`
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

  const levelCounts = { STRONG: 0, NORMAL: 0, WEAK: 0 };
  opportunities.forEach((o) => {
    levelCounts[o.strength] = (levelCounts[o.strength] || 0) + 1;
  });

  res.json({
    connected: markets.length > 0 || scanCount > 0,
    lastScan,
    marketsScanned: markets.length,
    activeOpportunities: opportunities.length,
    sports: sportCounts,
    totalSignals: opportunities.length,
    signalLevels: levelCounts,
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
console.log("  KALSHI EDGE SCANNER v6.0 — TIERED COMEBACK DETECTOR");
console.log("  Signal Levels: WEAK | NORMAL | STRONG (scored 0-100)");
console.log(`  API Key: ${API_KEY_ID ? "✓ configured" : "✗ missing KALSHI_API_KEY"}`);
console.log(`  Private Key: ${PRIVATE_KEY ? "✓ loaded" : "✗ missing PEM file"}`);
console.log(`  Poll Interval: ${POLL_INTERVAL}ms`);
console.log("=".repeat(60));

fetchAllMarkets();
setInterval(fetchAllMarkets, POLL_INTERVAL);

app.listen(PORT, () => {
  console.log(`[SERVER] Listening on port ${PORT}`);
});
