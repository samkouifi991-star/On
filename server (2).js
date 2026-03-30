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
const peaks = {}; // ticker -> highest price seen

// ── Step 1: Fetch all markets ──
async function fetchMarkets() {
  try {
    const res = await fetch(`${KALSHI_API}/events?status=open&limit=200`, {
      headers: { "Accept": "application/json" }
    });
    if (!res.ok) {
      console.error(`[FETCH] API returned ${res.status}`);
      return [];
    }
    const data = await res.json();
    return data.events || [];
  } catch (err) {
    console.error("[FETCH] Error:", err.message);
    return [];
  }
}

// ── Step 2: Filter live tennis only ──
function filterLiveTennis(events) {
  const tennisMarkets = [];

  for (const event of events) {
    const ticker = (event.ticker || "").toUpperCase();
    const title = (event.title || "").toUpperCase();
    const category = (event.category || "").toUpperCase();

    const isTennis =
      ticker.includes("KXATP") ||
      ticker.includes("KXWTA") ||
      ticker.includes("ATP") ||
      ticker.includes("WTA") ||
      category.includes("TENNIS") ||
      title.includes("TENNIS");

    if (!isTennis) continue;

    // Pull child markets from the event
    const markets = event.markets || [];
    if (markets.length > 0) {
      for (const m of markets) {
        tennisMarkets.push({
          ticker: m.ticker || event.ticker,
          title: m.title || event.title,
          yes_price: m.yes_bid || m.last_price || 0,
          status: m.status || event.status,
          event_ticker: event.ticker
        });
      }
    } else {
      tennisMarkets.push({
        ticker: event.ticker,
        title: event.title,
        yes_price: event.last_price || 0,
        status: event.status,
        event_ticker: event.ticker
      });
    }
  }

  return tennisMarkets;
}

// ── Step 3: Track peaks and detect signals ──
function trackPeaks(markets) {
  for (const m of markets) {
    const price = m.yes_price;
    if (!peaks[m.ticker] || price > peaks[m.ticker]) {
      peaks[m.ticker] = price;
    }
    m.peak = peaks[m.ticker];
    m.drop = Math.round((peaks[m.ticker] - price) * 100) / 100;
  }
}

function detectSignals(markets) {
  const newSignals = [];

  for (const m of markets) {
    const peakCents = Math.round(m.peak * 100);
    const dropCents = Math.round(m.drop * 100);

    if (peakCents >= 50 && dropCents >= 3) {
      let strength = "WEAK";
      if (dropCents >= 10) strength = "STRONG";
      else if (dropCents >= 5) strength = "NORMAL";

      newSignals.push({
        ticker: m.ticker,
        title: m.title,
        price: m.yes_price,
        peak: m.peak,
        drop: m.drop,
        dropCents,
        strength,
        time: new Date().toISOString()
      });
    }
  }

  return newSignals;
}

// ── Scanner loop ──
async function scan() {
  console.log("[SCAN] Fetching markets...");
  const events = await fetchMarkets();
  const tennis = filterLiveTennis(events);

  trackPeaks(tennis);
  const newSignals = detectSignals(tennis);

  liveMarkets = tennis;
  signals = newSignals;

  console.log(`[SCAN] ${tennis.length} live tennis markets | ${newSignals.length} signals`);
}

// Start polling
setInterval(scan, POLL_INTERVAL);
scan();

// ── API Routes ──
app.get("/api/markets", (req, res) => {
  res.json({
    count: liveMarkets.length,
    markets: liveMarkets
  });
});

app.get("/api/signals", (req, res) => {
  res.json({
    count: signals.length,
    signals
  });
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
