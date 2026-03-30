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
const POLL_INTERVAL = 5000;           // base poll for all markets
const FAST_POLL_INTERVAL = 2000;      // priority markets (top 30)
const DISCOVERY_INTERVAL = 3 * 60 * 1000; // re-discover every 3 min
const MAX_DISCOVERY_PAGES = 15;       // scan more pages
const MAX_TRACKED_MARKETS = 200;      // no artificial cap
const FETCH_CONCURRENCY = 6;
const PRIORITY_TIER_SIZE = 30;        // top N markets get fast polling
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
let priceHistory = {};       // ticker → [last N prices] for momentum
const HISTORY_LENGTH = 10;
let lastFetchTime = 0;
let lastFastFetchTime = 0;   // for priority tier
let lastDiscoveryTime = 0;
let trackedMarketUniverse = [];
let priorityTickers = new Set(); // top markets for fast polling
let discoveryStats = { total: 0, sports: 0, discovered: 0 };
let discoveryDebug = { sampleTitles: [], rejectedSamples: [], directCandidateSamples: [], filterReasons: {} };
const startTime = Date.now();
const marketMetaCache = new Map();

// ============================================================
// SPORT-SPECIFIC CONFIG
// ============================================================
const SPORT_CONFIG = {
  TENNIS: {
    peakThreshold: 50,
    minDrop: 3,
    weakDrop: 3, normalDrop: 5, strongDrop: 8,
    requireStabilization: false,
    priorityBoost: 20,   // tennis gets priority boost
    minVolume: 500,       // tennis can have lower volume
  },
  NBA: {
    peakThreshold: 55,
    minDrop: 5,
    weakDrop: 5, normalDrop: 8, strongDrop: 12,
    requireStabilization: true,
    priorityBoost: 10,
    minVolume: 1000,
  },
  NFL: {
    peakThreshold: 55,
    minDrop: 5,
    weakDrop: 5, normalDrop: 8, strongDrop: 12,
    requireStabilization: true,
    priorityBoost: 10,
    minVolume: 1000,
  },
  NHL: {
    peakThreshold: 52,
    minDrop: 4,
    weakDrop: 4, normalDrop: 6, strongDrop: 10,
    requireStabilization: false,
    priorityBoost: 5,
    minVolume: 800,
  },
  MLB: {
    peakThreshold: 52,
    minDrop: 4,
    weakDrop: 4, normalDrop: 6, strongDrop: 10,
    requireStabilization: false,
    priorityBoost: 5,
    minVolume: 800,
  },
};

function getSportConfig(sport) {
  return SPORT_CONFIG[sport] || SPORT_CONFIG.NBA; // default to NBA rules
}

// ============================================================
// PRIORITY SCORING — determines which markets get fast-polled
// ============================================================
function calculatePriorityScore(m) {
  const cfg = getSportConfig(m.sport);
  let score = 0;

  // Sport-specific boost
  score += cfg.priorityBoost;

  // Volume: higher = more important
  if (m.volume >= 5000) score += 30;
  else if (m.volume >= 2000) score += 20;
  else if (m.volume >= 1000) score += 10;

  // Price movement speed (recent change)
  const move = Math.abs(m.price - m.prev);
  if (move >= 5) score += 25;
  else if (move >= 3) score += 15;
  else if (move >= 1) score += 5;

  // Drop from peak (comeback candidate gets priority)
  const peak = peakPrices[m.ticker] || m.price;
  const drop = peak - m.price;
  if (drop >= cfg.strongDrop) score += 30;
  else if (drop >= cfg.normalDrop) score += 20;
  else if (drop >= cfg.minDrop) score += 10;

  // Wide spread = instability = interesting
  if (m.spread >= 5) score += 10;

  return score;
}

// ============================================================
// COMEBACK CANDIDATE PRE-FILTER — only these get signal logic
// ============================================================
function isComebackCandidate(m) {
  if (!m || m.price <= 0) return false;
  const cfg = getSportConfig(m.sport);
  const peak = peakPrices[m.ticker] || m.price;
  const drop = peak - m.price;

  // Was ever a favorite (peak above threshold)
  if (peak < cfg.peakThreshold) return false;

  // Has dropped enough from peak
  if (drop < cfg.minDrop) return false;

  // Still has meaningful price (not settled near 0 or 100)
  if (m.price < 10 || m.price > 92) return false;

  // Meets sport-specific volume minimum
  if (m.volume < cfg.minVolume) return false;

  return true;
}
const startTime = Date.now();
const marketMetaCache = new Map();

// ============================================================
// HELPERS
// ============================================================
function dollarsToCents(val) {
  if (typeof val === "number") return Math.round(val * 100);
  const n = parseFloat(val);
  return isNaN(n) ? 0 : Math.round(n * 100);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function isCleanSingleMarket(m, trackRejection = false) {
  if (!m) return false;

  const rawTitle = (m.title || "").trim();
  const title = rawTitle.toLowerCase();
  const ticker = (m.ticker || "").toUpperCase();

  if (!title) { if (trackRejection) trackReject("no_title", ticker); return false; }

  // Hard reject obvious combos/parlays
  if (title.includes(",")) { if (trackRejection) trackReject("has_comma", rawTitle); return false; }
  if (title.includes("+")) { if (trackRejection) trackReject("has_plus", rawTitle); return false; }
  if (ticker.includes("MULTI") || ticker.includes("COMBO") || ticker.includes("PARLAY")) {
    if (trackRejection) trackReject("combo_ticker", rawTitle);
    return false;
  }

  const yesMatches = title.match(/\byes\b/g) || [];
  if (yesMatches.length > 1) { if (trackRejection) trackReject("multi_yes", rawTitle); return false; }

  // Reject player/team prop style markets
  if (/\b(points?|rebounds?|assists?|yards?|touchdowns?|strikeouts?|threes?|goals?\s+scored|over\/?under|total|at least|or more|\d+\+)\b/i.test(title)) {
    if (trackRejection) trackReject("prop_market", rawTitle);
    return false;
  }

  if (title.length > 120) { if (trackRejection) trackReject("too_long", rawTitle); return false; }

  const hasVs = /\bvs\.?\b/i.test(rawTitle);
  const hasAtWinner = /\bat\b/i.test(rawTitle) && /\bwinner\b/i.test(rawTitle);
  const hasWillWin = /\bwill\b.*\bwin\b/i.test(title);
  const hasSingleYesWin = yesMatches.length === 1 && /\bwin\b/.test(title);
  const hasToWin = /\bto\s+win\b/i.test(title);
  const hasWinner = /\bwinner\b/i.test(title);

  // Accept any winner-style structure
  if (!hasVs && !hasAtWinner && !hasWillWin && !hasSingleYesWin && !hasToWin && !hasWinner) {
    if (trackRejection) trackReject("no_winner_pattern", rawTitle);
    return false;
  }

  return true;
}

function trackReject(reason, sample) {
  discoveryDebug.filterReasons[reason] = (discoveryDebug.filterReasons[reason] || 0) + 1;
  if (!discoveryDebug.rejectedSamples) discoveryDebug.rejectedSamples = [];
  if (discoveryDebug.rejectedSamples.length < 30) {
    discoveryDebug.rejectedSamples.push({ reason, sample: (sample || "").slice(0, 100) });
  }
}

function isLiveMarket(m) {
  if (!m) return false;
  // Kalshi uses: status "open"/"active"/"closed"/"settled"
  // and sometimes an "is_active" or game_status field
  const status = (m.status || "").toLowerCase();
  const gameStatus = (m.game_status || m.result || "").toLowerCase();

  // Reject settled, closed, or finalized markets
  if (["closed", "settled", "finalized", "inactive"].includes(status)) return false;
  if (["settled", "closed", "finalized"].includes(gameStatus)) return false;

  // Accept open/active markets
  return true;
}

function isTradableMarket(m) {
  if (!m) return false;
  if (!isLiveMarket(m)) return false;
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
  const displayTitle = (m.title || m.ticker).replace(/\s+winner\??$/i, "").trim();

  const price = p.yes_ask || p.last_price || p.prev_price || 0;
  const prev = previousPrices[m.ticker] ?? price;
  const spread = (p.yes_ask && p.yes_bid) ? p.yes_ask - p.yes_bid : 0;

  // Seed peak from all available price sources on first observation
  if (!peakPrices[m.ticker]) {
    const seedPeak = Math.max(price, prev, p.last_price || 0, p.prev_price || 0);
    if (seedPeak > 0) {
      peakPrices[m.ticker] = seedPeak;
      console.log(`[PEAK] Seeded ${m.ticker}: peak=${seedPeak}¢ (price=${price}, prev=${prev}, last=${p.last_price}, prevPrice=${p.prev_price})`);
    }
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
    sport,
    yes_bid: p.yes_bid,
    yes_ask: p.yes_ask,
    no_bid: p.no_bid,
    no_ask: p.no_ask,
  };
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

  return {
    yesBid,
    yesAsk,
    noBid,
    noAsk,
    midpoint,
    volume: bookDepth(yesLevels) + bookDepth(noLevels),
  };
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let index = 0;

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const currentIndex = index++;
      try {
        results[currentIndex] = await worker(items[currentIndex], currentIndex);
      } catch (err) {
        console.warn(`[LIVE] Skipping item ${items[currentIndex]}: ${err.message}`);
        results[currentIndex] = null;
      }
    }
  });

  await Promise.all(runners);
  return results.filter(Boolean);
}

function isUnderlyingGameTicker(ticker) {
  if (!ticker || typeof ticker !== "string") return false;
  const upper = ticker.toUpperCase().trim();

  if (/PTS|REB|AST|PASS|RUSH|REC|SHOT|GOAL|SAVE|HR|HIT|RBI|STRIKEOUT|THREE|SPREAD|TOTAL/.test(upper)) {
    return false;
  }

  return upper.includes("GAME") || /^(KXTENNIS|KXATP|KXWTA|KXNBA|KXNFL|KXNHL|KXMLB|KXSOCCER)/.test(upper);
}

function extractUnderlyingMarketTickers(sourceMarkets) {
  const unique = new Set();

  for (const market of sourceMarkets) {
    const customStrike = market?.custom_strike || {};
    const associatedMarkets = String(customStrike["Associated Markets"] || "")
      .split(",")
      .map((ticker) => ticker.trim())
      .filter(Boolean);

    for (const ticker of associatedMarkets) {
      if (isUnderlyingGameTicker(ticker)) {
        unique.add(ticker);
        if (unique.size >= MAX_TRACKED_MARKETS) {
          return Array.from(unique);
        }
      }
    }
  }

  return Array.from(unique);
}

async function fetchMarketMeta(ticker) {
  if (marketMetaCache.has(ticker)) return marketMetaCache.get(ticker);

  const data = await kalshiFetch(`/markets/${ticker}`);
  const market = data.market || data;
  if (!market?.ticker) return null;

  marketMetaCache.set(ticker, market);
  return market;
}

async function discoverTrackedMarketUniverse() {
  const allMarkets = [];
  let cursor = null;

  for (let page = 0; page < MAX_DISCOVERY_PAGES; page++) {
    const params = new URLSearchParams({ limit: "200", status: "open" });
    if (cursor) params.set("cursor", cursor);

    const data = await kalshiFetch(`/markets?${params.toString()}`);
    const batch = data.markets || [];
    allMarkets.push(...batch);

    cursor = data.cursor;
    if (!cursor || batch.length === 0) break;
    await sleep(300);
  }

  console.log(`[DISCOVERY] Fetched ${allMarkets.length} total markets`);

  // Reset debug info
  discoveryDebug = { sampleTitles: [], rejectedSamples: [], directCandidateSamples: [], filterReasons: {} };

  // Log sample titles from the feed
  discoveryDebug.sampleTitles = allMarkets.slice(0, 20).map(m => ({
    ticker: m.ticker,
    title: (m.title || "").slice(0, 100),
    status: m.status,
    custom_strike_keys: Object.keys(m.custom_strike || {}),
  }));

  // Strategy 1: Extract underlying tickers from combo wrappers
  const sportsMarkets = allMarkets.filter(isSportsMarket);
  console.log(`[DISCOVERY] Sports wrappers: ${sportsMarkets.length}`);

  if (sportsMarkets.length > 0) {
    const sample = sportsMarkets[0];
    console.log(`[DISCOVERY] Sample wrapper ticker: ${sample.ticker}, custom_strike keys: ${JSON.stringify(Object.keys(sample.custom_strike || {}))}`);
    if (sample.custom_strike) {
      console.log(`[DISCOVERY] Sample custom_strike: ${JSON.stringify(sample.custom_strike).slice(0, 500)}`);
    }
  }

  const candidateTickers = extractUnderlyingMarketTickers(sportsMarkets);
  console.log(`[DISCOVERY] Extracted ${candidateTickers.length} underlying tickers from wrappers`);

  // Strategy 2: Direct discovery — find sports markets, track why non-sports rejected
  const sportMatches = allMarkets.filter(m => {
    if (!m || !m.ticker) return false;
    const sport = classifySport(m.title || m.ticker, m.ticker);
    return sport !== "OTHER";
  });
  console.log(`[DISCOVERY] Sport-classified markets (non-OTHER): ${sportMatches.length}`);

  // Now filter for clean singles with rejection tracking
  const directCandidates = sportMatches.filter(m => isCleanSingleMarket(m, true));
  console.log(`[DISCOVERY] Direct clean singles found: ${directCandidates.length}`);
  console.log(`[DISCOVERY] Filter rejections: ${JSON.stringify(discoveryDebug.filterReasons)}`);

  if (directCandidates.length > 0) {
    console.log(`[DISCOVERY] Sample direct: ${directCandidates.slice(0, 5).map(m => m.ticker + ' = ' + m.title).join(' | ')}`);
    discoveryDebug.directCandidateSamples = directCandidates.slice(0, 10).map(m => ({ ticker: m.ticker, title: m.title }));
  }

  // Also log sample sport-classified titles that failed the clean filter
  const failedClean = sportMatches.filter(m => !isCleanSingleMarket(m));
  if (failedClean.length > 0) {
    console.log(`[DISCOVERY] Sample sport markets that FAILED clean filter: ${failedClean.slice(0, 5).map(m => m.ticker + ' = ' + (m.title || '').slice(0, 80)).join(' | ')}`);
  }

  // Merge: underlying tickers + direct candidates
  const allCandidateTickers = new Set(candidateTickers);
  for (const m of directCandidates) {
    allCandidateTickers.add(m.ticker);
    marketMetaCache.set(m.ticker, m);
  }

  const mergedTickers = Array.from(allCandidateTickers).slice(0, MAX_TRACKED_MARKETS);
  console.log(`[DISCOVERY] Merged candidate tickers: ${mergedTickers.length}`);

  const discoveredMarkets = await mapWithConcurrency(
    mergedTickers,
    FETCH_CONCURRENCY,
    async (ticker) => {
      const market = marketMetaCache.get(ticker) || await fetchMarketMeta(ticker);
      if (!market) return null;
      marketMetaCache.set(ticker, market);
      if (!isCleanSingleMarket(market)) {
        return null;
      }
      return market;
    }
  );

  trackedMarketUniverse = discoveredMarkets.slice(0, MAX_TRACKED_MARKETS);
  lastDiscoveryTime = Date.now();
  discoveryStats = {
    total: allMarkets.length,
    sports: sportsMarkets.length,
    sportClassified: sportMatches.length,
    discovered: trackedMarketUniverse.length,
  };
  console.log(`[DISCOVERY] Final tracked universe: ${trackedMarketUniverse.length} markets`);
  if (trackedMarketUniverse.length > 0) {
    console.log(`[DISCOVERY] Sample tracked: ${trackedMarketUniverse.slice(0, 5).map(m => m.ticker).join(', ')}`);
  }
}

async function hydrateTrackedMarkets() {
  return mapWithConcurrency(trackedMarketUniverse, FETCH_CONCURRENCY, async (market) => {
    const bookData = await kalshiFetch(`/markets/${market.ticker}/orderbook`);
    const book = summarizeOrderbook(bookData);

    return {
      ...market,
      yes_bid_dollars: book.yesBid / 100,
      yes_ask_dollars: book.yesAsk / 100,
      no_bid_dollars: book.noBid / 100,
      no_ask_dollars: book.noAsk / 100,
      last_price_dollars: book.midpoint / 100,
      previous_price_dollars: (previousPrices[market.ticker] || book.midpoint) / 100,
      volume: book.volume,
    };
  });
}

// ============================================================
// SIGNAL ENGINE v7 — MULTI-STRATEGY DETECTOR
// ============================================================
// Strategies:
//   1. COMEBACK — peak drop detection (WEAK/NORMAL/STRONG)
//   2. SETUP — early detection before full drop
//   3. TENNIS_SPIKE — overextended favorite in tennis
// Momentum confirmation boosts signal strength.
// ============================================================

function updatePriceHistory(ticker, price) {
  if (!priceHistory[ticker]) priceHistory[ticker] = [];
  priceHistory[ticker].push(price);
  if (priceHistory[ticker].length > HISTORY_LENGTH) {
    priceHistory[ticker].shift();
  }
}

function getMomentum(ticker) {
  const hist = priceHistory[ticker];
  if (!hist || hist.length < 3) return "FLAT";
  const last3 = hist.slice(-3);
  if (last3[0] > last3[1] && last3[1] > last3[2]) return "DOWN";  // falling
  if (last3[0] < last3[1] && last3[1] < last3[2]) return "UP";    // rising
  return "FLAT";
}

function getMomentumBoost(ticker) {
  const mom = getMomentum(ticker);
  if (mom === "DOWN") return 15;  // price falling = comeback opportunity
  if (mom === "UP") return 5;     // recovering
  return 0;
}

function getComebackSignal(m) {
  if (!m) return null;

  const cfg = getSportConfig(m.sport);
  const peak = peakPrices[m.ticker] || m.price;
  const price = m.price;
  const prev = m.prev;

  if (peak < cfg.peakThreshold) return null;
  const drop = peak - price;
  if (drop < cfg.minDrop) return null;
  if (price < 10 || price > 92) return null;
  if (m.volume < cfg.minVolume) return null;

  const recovering = price > prev;
  const stabilizing = cfg.requireStabilization ? Math.abs(price - prev) < 2 : false;

  let score = 0;

  // Drop strength — sport-specific
  if (drop >= cfg.strongDrop * 2) score += 40;
  else if (drop >= cfg.strongDrop * 1.5) score += 30;
  else if (drop >= cfg.strongDrop) score += 20;
  else if (drop >= cfg.normalDrop) score += 12;
  else score += 5;

  if (recovering) score += 30;
  else if (stabilizing) score += 15;

  // Fast reversal bonus for sports that don't require stabilization
  if (!cfg.requireStabilization && recovering && drop >= cfg.normalDrop) score += 15;

  score += getMomentumBoost(m.ticker);

  if (m.volume >= 5000) score += 15;
  else if (m.volume >= 2000) score += 10;
  if (cfg.requireStabilization) {
    if (m.spread <= 5) score += 15;
    if (m.spread > 7) score -= 20;
  } else {
    if (m.spread >= 5) score += 10;
  }

  score = Math.max(0, Math.min(100, score));

  let level = "WEAK";
  if (drop >= cfg.strongDrop && score >= 50) level = "STRONG";
  else if (drop >= cfg.normalDrop && score >= 30) level = "NORMAL";

  const momentum = getMomentum(m.ticker);

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
    description: `Peaked at ${peak}¢, dropped ${drop}¢ to ${price}¢ — ${recovering ? "recovering" : stabilizing ? "stabilizing" : "falling"} [${momentum}]`,
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

function getEarlySetupSignal(m) {
  if (!m) return null;
  const price = m.price;

  // Early detection: high-priced favorite with wide spread and volume
  if (price < 65) return null;
  if (m.spread < 3) return null;
  if (m.volume < 2000) return null;

  // Don't emit SETUP if we already have a COMEBACK for this ticker
  const peak = peakPrices[m.ticker] || price;
  const drop = peak - price;
  if (drop >= 5) return null; // comeback signal will handle it

  let score = 10;

  // Higher price = more potential for drop
  if (price >= 80) score += 20;
  else if (price >= 75) score += 15;
  else if (price >= 70) score += 10;

  // Wide spread = instability
  if (m.spread >= 6) score += 15;
  else if (m.spread >= 4) score += 10;

  // High volume = significance
  if (m.volume >= 5000) score += 15;
  else if (m.volume >= 3000) score += 10;

  // Momentum: if price just started falling, boost
  score += getMomentumBoost(m.ticker);

  score = Math.max(0, Math.min(100, score));

  return {
    id: `${m.ticker}-setup-${Date.now()}`,
    type: "COMEBACK",
    match: m.match,
    sport: m.sport,
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

function getTennisSpikeSignal(m) {
  if (!m) return null;
  if (m.sport !== "TENNIS") return null;

  const price = m.price;
  if (price < 75) return null;  // lowered from 85 — catch spikes earlier
  if (m.volume < 1000) return null;

  // Check if pre-game odds were roughly even (prev/seed ≈ 50 ± 15)
  const hist = priceHistory[m.ticker];
  const earliestPrice = hist && hist.length > 0 ? hist[0] : m.prev;

  // Wider "was even" window for tennis (35–65)
  const wasEven = earliestPrice >= 35 && earliestPrice <= 65;

  if (!wasEven) return null;

  let level = "WEAK";
  let score = 30;

  if (price >= 95) { level = "STRONG"; score = 85; }
  else if (price >= 90) { level = "STRONG"; score = 75; }
  else if (price >= 85) { level = "NORMAL"; score = 60; }
  else if (price >= 80) { level = "NORMAL"; score = 50; }
  else { level = "WEAK"; score = 40; }  // 75-80

  // Volume boost
  if (m.volume >= 5000) score += 15;
  else if (m.volume >= 2000) score += 10;

  // Fast reversal bonus: if price started dropping from spike, immediate signal
  const recovering = m.price < m.prev; // price coming back down = fade opportunity
  if (recovering) score += 15;

  score = Math.max(0, Math.min(100, score));

  return {
    id: `${m.ticker}-tennis-spike-${Date.now()}`,
    type: "COMEBACK",
    match: m.match,
    sport: m.sport,
    ticker: m.ticker,
    price,
    prev: m.prev,
    edge: price - earliestPrice,
    direction: "NO",
    timestamp: Date.now(),
    description: `TENNIS SPIKE: Was ~${earliestPrice}¢, now ${price}¢ — overextended favorite, fade opportunity${recovering ? " [REVERSING]" : ""}`,
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

// detectOpportunities is now inlined in fetchAllMarkets for efficiency

// ============================================================
// MARKET FETCHING — PRIORITY QUEUE ARCHITECTURE
// ============================================================
// Full scan: all markets every POLL_INTERVAL (5s)
// Fast scan: priority markets every FAST_POLL_INTERVAL (2s)
// ============================================================

async function fetchAllMarkets(fastOnly = false) {
  const now = Date.now();

  if (fastOnly) {
    if (now - lastFastFetchTime < FAST_POLL_INTERVAL - 500) return;
  } else {
    if (now - lastFetchTime < POLL_INTERVAL - 1000) return;
  }

  try {
    // Re-discover universe periodically
    if (!trackedMarketUniverse.length || now - lastDiscoveryTime >= DISCOVERY_INTERVAL) {
      await discoverTrackedMarketUniverse();
    }

    // For fast poll, only hydrate priority tickers
    let marketsToHydrate = trackedMarketUniverse;
    if (fastOnly && priorityTickers.size > 0) {
      marketsToHydrate = trackedMarketUniverse.filter(m => priorityTickers.has(m.ticker));
    }

    const cleanMarkets = (await mapWithConcurrency(marketsToHydrate, FETCH_CONCURRENCY, async (market) => {
      const bookData = await kalshiFetch(`/markets/${market.ticker}/orderbook`);
      const book = summarizeOrderbook(bookData);
      return {
        ...market,
        yes_bid_dollars: book.yesBid / 100,
        yes_ask_dollars: book.yesAsk / 100,
        no_bid_dollars: book.noBid / 100,
        no_ask_dollars: book.noAsk / 100,
        last_price_dollars: book.midpoint / 100,
        previous_price_dollars: (previousPrices[market.ticker] || book.midpoint) / 100,
        volume: book.volume,
      };
    }))
      .filter(isCleanSingleMarket)
      .filter(isTradableMarket);

    // Normalize ALL markets (no cap)
    const normalized = cleanMarkets.map(normalizeMarket);

    const allSports = normalized
      .filter((m) => ["NBA", "NFL", "NHL", "TENNIS", "MLB"].includes(m.sport));

    // Update price history + peaks for ALL markets (full tracking)
    for (const m of allSports) {
      updatePriceHistory(m.ticker, m.price);
      const currentPeak = peakPrices[m.ticker] || 0;
      if (m.price > currentPeak) peakPrices[m.ticker] = m.price;
      const prev = previousPrices[m.ticker];
      if (prev !== undefined && prev > (peakPrices[m.ticker] || 0)) {
        peakPrices[m.ticker] = prev;
      }
    }

    // COMEBACK CANDIDATE PRE-FILTER — only these get signal logic
    const comebackCandidates = allSports.filter(isComebackCandidate);

    // Also include setup/spike candidates (high price or tennis)
    const signalCandidates = allSports.filter(m => {
      if (comebackCandidates.some(c => c.ticker === m.ticker)) return false; // already included
      // Setup candidate: high-priced favorite
      if (m.price >= 65 && m.spread >= 3 && m.volume >= 2000) return true;
      // Tennis spike candidate
      if (m.sport === "TENNIS" && m.price >= 75 && m.volume >= 1000) return true;
      return false;
    });

    const allCandidates = [...comebackCandidates, ...signalCandidates];

    // Run signal engine ONLY on filtered candidates
    const newOpps = [];
    const seen = new Set();
    for (const m of allCandidates) {
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
    for (const m of allSports) {
      previousPrices[m.ticker] = m.price;
    }

    // Merge signals
    const tickerMap = new Map();
    for (const opp of [...newOpps, ...opportunities]) {
      if (!tickerMap.has(opp.ticker)) {
        tickerMap.set(opp.ticker, opp);
      }
    }
    opportunities = Array.from(tickerMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, 100);

    // PRIORITY QUEUE — score all markets, top N get fast polling
    const scored = allSports.map(m => ({ ticker: m.ticker, priority: calculatePriorityScore(m) }));
    scored.sort((a, b) => b.priority - a.priority);
    priorityTickers = new Set(scored.slice(0, PRIORITY_TIER_SIZE).map(s => s.ticker));

    markets = allSports;
    lastScan = Date.now();
    if (fastOnly) {
      lastFastFetchTime = Date.now();
    } else {
      lastFetchTime = Date.now();
      lastFastFetchTime = Date.now();
    }
    scanCount++;

    const sportCounts = {};
    allSports.forEach((m) => {
      sportCounts[m.sport] = (sportCounts[m.sport] || 0) + 1;
    });

    const levelCounts = { STRONG: 0, NORMAL: 0, WEAK: 0 };
    opportunities.forEach((o) => {
      levelCounts[o.strength] = (levelCounts[o.strength] || 0) + 1;
    });

    console.log(
      `[SCAN #${scanCount}${fastOnly ? " FAST" : ""}] ${allSports.length} live sports | ${comebackCandidates.length} comeback candidates | ${allCandidates.length} signal candidates | Priority: ${priorityTickers.size} | Signals: ${opportunities.length} (S:${levelCounts.STRONG} N:${levelCounts.NORMAL} W:${levelCounts.WEAK}) | Sports: ${JSON.stringify(sportCounts)}`
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

app.get("/api/discovery-debug", (req, res) => {
  res.json({
    discoveryStats,
    trackedUniverseSize: trackedMarketUniverse.length,
    trackedSample: trackedMarketUniverse.slice(0, 10).map(m => ({ ticker: m.ticker, title: (m.title || "").slice(0, 80) })),
    ...discoveryDebug,
  });
});

app.get("/api/peaks-debug", (req, res) => {
  const peakEntries = Object.entries(peakPrices).map(([ticker, peak]) => {
    const market = markets.find(m => m.ticker === ticker);
    const currentPrice = market ? market.price : null;
    const drop = currentPrice !== null ? peak - currentPrice : null;
    const volume = market ? market.volume : null;
    const sport = market ? market.sport : null;
    const isTennis = sport === "TENNIS";
    const peakReq = isTennis ? 50 : 55;
    const dropReq = isTennis ? 3 : 5;
    return { ticker, peak, currentPrice, drop, volume, sport, wouldSignal: peak >= peakReq && drop >= dropReq && currentPrice >= 15 && currentPrice <= 85 && volume >= 1000 };
  });
  peakEntries.sort((a, b) => (b.drop || 0) - (a.drop || 0));
  res.json({
    totalPeaksTracked: Object.keys(peakPrices).length,
    totalMarkets: markets.length,
    scanCount,
    uptimeSeconds: Math.round((Date.now() - startTime) / 1000),
    peaks: peakEntries,
  });
});

app.get("/api/priority-debug", (req, res) => {
  const allScored = markets.map(m => ({
    ticker: m.ticker,
    sport: m.sport,
    price: m.price,
    volume: m.volume,
    spread: m.spread,
    peak: peakPrices[m.ticker] || m.price,
    drop: (peakPrices[m.ticker] || m.price) - m.price,
    priority: calculatePriorityScore(m),
    isPriority: priorityTickers.has(m.ticker),
    isCandidate: isComebackCandidate(m),
  }));
  allScored.sort((a, b) => b.priority - a.priority);
  res.json({
    totalMarkets: markets.length,
    priorityCount: priorityTickers.size,
    candidateCount: allScored.filter(s => s.isCandidate).length,
    markets: allScored,
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", scans: scanCount, markets: markets.length, priority: priorityTickers.size });
});

// ============================================================
// START — DUAL-SPEED POLLING
// ============================================================
console.log("=".repeat(60));
console.log("  KALSHI EDGE SCANNER v8.0 — PRIORITY QUEUE ENGINE");
console.log("  Full scan: ALL live markets every 5s");
console.log("  Fast scan: TOP 30 priority markets every 2s");
console.log("  Pre-filter: Comeback candidates only get signal logic");
console.log("  Sport configs: TENNIS(50/3) NBA/NFL(55/5) NHL/MLB(52/4)");
console.log("  Strategies: COMEBACK | SETUP | TENNIS_SPIKE");
console.log("  Signal Levels: WEAK | NORMAL | STRONG (scored 0-100)");
console.log(`  API Key: ${API_KEY_ID ? "✓ configured" : "✗ missing KALSHI_API_KEY"}`);
console.log(`  Private Key: ${PRIVATE_KEY ? "✓ loaded" : "✗ missing PEM file"}`);
console.log("=".repeat(60));

// Initial full scan
fetchAllMarkets(false);

// Full scan every POLL_INTERVAL (5s)
setInterval(() => fetchAllMarkets(false), POLL_INTERVAL);

// Fast scan for priority markets every FAST_POLL_INTERVAL (2s)
setInterval(() => fetchAllMarkets(true), FAST_POLL_INTERVAL);

app.listen(PORT, () => {
  console.log(`[SERVER] Listening on port ${PORT}`);
});
