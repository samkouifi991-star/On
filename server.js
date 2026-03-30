const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3001;
const KALSHI_API = "https://api.elections.kalshi.com/trade-api/v2";
const POLL_INTERVAL = 3000;

// ── State ──
let liveMarkets = [];
let signals = [];
const peaks = {};

// ── Step 1: Fetch tennis markets ──
async function fetchTennisMarkets() {
  const allMarkets = [];

  // Search with multiple tennis-related terms
  const searches = ["KXATP", "KXWTA"];

  for (const term of searches) {
    try {
      let cursor = null;
      let hasMore = true;

      while (hasMore) {
        let url = `${KALSHI_API}/markets?limit=100&status=active&ticker=${term}`;
        if (cursor) url += `&cursor=${cursor}`;

        const res = await fetch(url, {
          headers: { "Accept": "application/json" }
        });

        if (!res.ok) {
          console.error(`[FETCH] ${term}: API returned ${res.status}`);
          break;
        }

        const data = await res.json();
        const markets = data.markets || [];
        allMarkets.push(...markets);

        cursor = data.cursor;
        hasMore = cursor && markets.length === 100;

        // Small delay to avoid rate limits
        if (hasMore) await sleep(200);
      }
    } catch (err) {
      console.error(`[FETCH] ${term} error:`, err.message);
    }
  }

  // Also try event-based search
  try {
    const res = await fetch(`${KALSHI_API}/events?status=open&series_ticker=KXATP&limit=100`, {
      headers: { "Accept": "application/json" }
    });
    if (res.ok) {
      const data = await res.json();
      for (const event of (data.events || [])) {
        if (event.markets) allMarkets.push(...event.markets);
      }
    }
  } catch (err) {
    console.error("[FETCH] ATP events error:", err.message);
  }

  try {
    const res = await fetch(`${KALSHI_API}/events?status=open&series_ticker=KXWTA&limit=100`, {
      headers: { "Accept": "application/json" }
    });
    if (res.ok) {
      const data = await res.json();
      for (const event of (data.events || [])) {
        if (event.markets) allMarkets.push(...event.markets);
      }
    }
  } catch (err) {
    console.error("[FETCH] WTA events error:", err.message);
  }

  // Deduplicate by ticker
  const seen = new Set();
  const unique = [];
  for (const m of allMarkets) {
    const ticker = m.ticker || "";
    if (!seen.has(ticker)) {
      seen.add(ticker);
      unique.push(m);
    }
  }

  console.log(`[FETCH] Found ${unique.length} total tennis markets`);
  return unique;
}

// ── Step 2: Filter live only ──
function filterLive(markets) {
  return markets.filter(m => {
    const status = (m.status || "").toLowerCase();
    const ticker = (m.ticker || "").toUpperCase();
    // Accept active/open/live markets with tennis tickers
    const isTennis = ticker.includes("KXATP") || ticker.includes("KXWTA");
    const isLive = status === "active" || status === "open" || status === "live";
    return isTennis && isLive;
  });
}

// ── Step 3: Track peaks ──
function trackPeaks(markets) {
  for (const m of markets) {
    const price = m.yes_bid || m.last_price || m.yes_ask || 0;
    m.currentPrice = price;

    if (!peaks[m.ticker] || price > peaks[m.ticker]) {
      peaks[m.ticker] = price;
    }
    m.peak = peaks[m.ticker];
    m.drop = Math.round((m.peak - price) * 100) / 100;
  }
}

// ── Step 4: Detect signals ──
function detectSignals(markets) {
  const results = [];

  for (const m of markets) {
    const peakCents = Math.round(m.peak * 100);
    const dropCents = Math.round(m.drop * 100);

    if (peakCents >= 50 && dropCents >= 3) {
      let strength = "WEAK";
      if (dropCents >= 10) strength = "STRONG";
      else if (dropCents >= 5) strength = "NORMAL";

      results.push({
        ticker: m.ticker,
        title: m.title || m.subtitle || m.ticker,
        price: m.currentPrice,
        peak: m.peak,
        drop: m.drop,
        dropCents,
        strength,
        time: new Date().toISOString()
      });
    }
  }

  return results;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Scanner loop ──
async function scan() {
  console.log("[SCAN] Fetching markets...");
  const allTennis = await fetchTennisMarkets();
  const live = filterLive(allTennis);

  trackPeaks(live);
  const newSignals = detectSignals(live);

  liveMarkets = live.map(m => ({
    ticker: m.ticker,
    title: m.title || m.subtitle || m.ticker,
    price: m.currentPrice,
    peak: m.peak,
    drop: m.drop,
    status: m.status
  }));

  signals = newSignals;

  console.log(`[SCAN] ${live.length} live tennis markets | ${newSignals.length} signals`);
}

setInterval(scan, POLL_INTERVAL);
scan();

// ── API Routes ──
app.get("/api/markets", (req, res) => {
  res.json({ count: liveMarkets.length, markets: liveMarkets });
});

app.get("/api/signals", (req, res) => {
  res.json({ count: signals.length, signals });
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    markets: liveMarkets.length,
    signals: signals.length,
    uptime: process.uptime()
  });
});

app.listen(PORT, () => {
  console.log(`Tennis Scanner running on port ${PORT}`);
});
