const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3001;
const KALSHI_API = "https://api.elections.kalshi.com/trade-api/v2";
const POLL_INTERVAL = 3000;
const TENNIS_SERIES = ["KXATPMATCH", "KXWTAMATCH"];

// ── State ──
let liveMarkets = [];
let signals = [];
const peaks = {};

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Step 1: Fetch tennis markets using correct series tickers ──
async function fetchTennisMarkets() {
  const allMarkets = [];

  for (const series of TENNIS_SERIES) {
    try {
      const url = `${KALSHI_API}/events?series_ticker=${series}&limit=100&status=open&with_nested_markets=true`;
      const res = await fetch(url, {
        headers: { "Accept": "application/json" }
      });

      if (!res.ok) {
        console.error(`[FETCH] ${series}: API returned ${res.status}`);
        continue;
      }

      const data = await res.json();
      const events = data.events || [];

      for (const event of events) {
        const markets = event.markets || [];
        for (const m of markets) {
          allMarkets.push({
            ticker: m.ticker,
            title: m.title || event.title,
            event_ticker: event.event_ticker,
            status: m.status,
            yes_bid: parseFloat(m.yes_bid_dollars) || 0,
            yes_ask: parseFloat(m.yes_ask_dollars) || 0,
            last_price: parseFloat(m.last_price_dollars) || 0,
            volume: parseInt(m.volume_fp) || 0,
            series: series
          });
        }
      }

      // Small delay between series requests
      await sleep(200);
    } catch (err) {
      console.error(`[FETCH] ${series} error:`, err.message);
    }
  }

  return allMarkets;
}

// ── Step 2: Filter live/active only ──
function filterLive(markets) {
  return markets.filter(m => m.status === "active");
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

// ── Step 4: Detect signals (peak >= 50¢, drop >= 3¢) ──
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
        title: m.title,
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
    title: m.title,
    price: m.currentPrice,
    peak: m.peak,
    drop: m.drop,
    status: m.status,
    series: m.series
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
