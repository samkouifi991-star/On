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

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Step 1: Fetch ALL open markets, then filter tennis locally ──
async function fetchTennisMarkets() {
  const allTennis = [];
  let cursor = null;
  let pages = 0;
  const MAX_PAGES = 10;

  try {
    while (pages < MAX_PAGES) {
      let url = `${KALSHI_API}/markets?limit=200&status=active`;
      if (cursor) url += `&cursor=${cursor}`;

      const res = await fetch(url, {
        headers: { "Accept": "application/json" }
      });

      if (!res.ok) {
        console.error(`[FETCH] API returned ${res.status}`);
        break;
      }

      const data = await res.json();
      const markets = data.markets || [];

      // Filter tennis locally
      for (const m of markets) {
        const ticker = (m.ticker || "").toUpperCase();
        const title = (m.title || "").toUpperCase();
        const eventTicker = (m.event_ticker || "").toUpperCase();

        if (
          ticker.includes("KXATP") || ticker.includes("KXWTA") ||
          eventTicker.includes("KXATP") || eventTicker.includes("KXWTA") ||
          title.includes("ATP") || title.includes("WTA") ||
          title.includes("TENNIS")
        ) {
          allTennis.push(m);
        }
      }

      pages++;
      cursor = data.cursor;

      // Stop if no more pages
      if (!cursor || markets.length < 200) break;

      // Rate limit protection
      await sleep(250);
    }
  } catch (err) {
    console.error("[FETCH] Error:", err.message);
  }

  console.log(`[FETCH] Scanned ${pages} pages, found ${allTennis.length} tennis markets`);
  return allTennis;
}

// ── Step 2: Keep only live/active ──
function filterLive(markets) {
  return markets.filter(m => {
    const status = (m.status || "").toLowerCase();
    return status === "active" || status === "open" || status === "live";
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
        title: m.title || m.ticker,
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

// ── Scanner loop ──
async function scan() {
  console.log("[SCAN] Fetching markets...");
  const allTennis = await fetchTennisMarkets();
  const live = filterLive(allTennis);

  trackPeaks(live);
  const newSignals = detectSignals(live);

  liveMarkets = live.map(m => ({
    ticker: m.ticker,
    title: m.title || m.ticker,
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
