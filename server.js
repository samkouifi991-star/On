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
const DISCOVERY_INTERVAL = 5 * 60 * 1000;
const MAX_DISCOVERY_PAGES = 10;
const MAX_TRACKED_MARKETS = 60;
const FETCH_CONCURRENCY = 4;
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
let lastDiscoveryTime = 0;
let trackedMarketUniverse = [];
let discoveryStats = { total: 0, sports: 0, discovered: 0 };
let discoveryDebug = { sampleTitles: [], rejectedSamples: [], directCandidateSamples: [], filterReasons: {} };
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

  try {
    if (!trackedMarketUniverse.length || now - lastDiscoveryTime >= DISCOVERY_INTERVAL) {
      await discoverTrackedMarketUniverse();
    }

    const cleanMarkets = (await hydrateTrackedMarkets())
      .filter(isCleanSingleMarket)
      .filter(isTradableMarket);

    console.log("Sample clean markets:", cleanMarkets.slice(0, 5));

    const normalized = cleanMarkets.slice(0, MAX_TRACKED_MARKETS).map(normalizeMarket);

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
    lastFetchTime = Date.now();
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
      `[SCAN #${scanCount}] ${discoveryStats.total} source → ${discoveryStats.sports} sports wrappers → ${discoveryStats.discovered} discovered singles → ${cleanMarkets.length} clean+tradable → ${filtered.length} tracked | Signals: ${opportunities.length} (S:${levelCounts.STRONG} N:${levelCounts.NORMAL} W:${levelCounts.WEAK}) | Sports: ${JSON.stringify(sportCounts)}`
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
    return { ticker, peak, currentPrice, drop, wouldSignal: peak >= 60 && drop >= 10 && currentPrice >= 15 && currentPrice <= 85 };
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
