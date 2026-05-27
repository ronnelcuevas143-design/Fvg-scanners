const fetch = require("node-fetch");
const express = require("express");
const app = express();

// ✅ UPDATED TOKEN
const TELEGRAM_TOKEN = "8755442528:AAGgdF7mjlPGYQir_3LILYoUePMzJ-WeXrc";
const CHAT_ID = "8797963344";
const FUTURES_BASE = "https://fapi.binance.com";
const RENDER_URL = "https://fvg-scanner-bot.onrender.com";

const COINS = [
  "BTC","ETH","BNB","SOL","XRP","ADA","AVAX","DOT","MATIC","LINK",
  "LTC","UNI","ATOM","FIL","APT","ARB","OP","INJ","SUI","SEI",
  "TIA","WLD","BLUR","DYDX","GMX","PEPE","WIF","BONK","JUP","PYTH"
];

const ALL_TFS = ["1W","1D","4H","1H","30M","15M"];
const ENTRY_TFS = ["1H","30M","15M"];
const TF_MAP = {
  "1W":"1w","1D":"1d","4H":"4h",
  "1H":"1h","30M":"30m","15M":"15m"
};

function toPHT(date) {
  return date.toLocaleString("en-PH", {
    timeZone: "Asia/Manila",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: true,
  });
}

function getExactCandleTime() {
  const now = new Date();
  const phtOffset = 8 * 60;
  const utcMins = now.getUTCHours() * 60 + now.getUTCMinutes();
  const phtMins = (utcMins + phtOffset) % (24 * 60);
  const exactMins = Math.floor(phtMins / 15) * 15;
  const hours = Math.floor(exactMins / 60);
  const mins = exactMins % 60;
  const period = hours >= 12 ? "PM" : "AM";
  const displayHours = hours % 12 || 12;
  const displayMins = mins.toString().padStart(2, "0");
  return `${displayHours}:${displayMins}:00 ${period}`;
}

function getTVLink(coin, tf) {
  const tvTF = {
    "1W":"W","1D":"D","4H":"240",
    "1H":"60","30M":"30","15M":"15"
  };
  return `https://www.tradingview.com/chart/?symbol=BINANCE:${coin}USDT.P&interval=${tvTF[tf]||"60"}`;
}

async function fetchWithTimeout(url, timeout = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

async function fetchKlines(symbol, interval) {
  const res = await fetchWithTimeout(
    `${FUTURES_BASE}/fapi/v1/klines?symbol=${symbol}USDT&interval=${interval}&limit=101`
  );
  const raw = await res.json();
  const closed = raw.slice(0, -1);
  return closed.map(k => ({
    time: k[0], open: parseFloat(k[1]),
    high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4])
  }));
}

async function fetchPrice(symbol) {
  const res = await fetchWithTimeout(
    `${FUTURES_BASE}/fapi/v1/ticker/price?symbol=${symbol}USDT`
  );
  const data = await res.json();
  return parseFloat(data.price);
}

function detectFVG(candles, price) {
  const fvgs = [];
  for (let i = 1; i < candles.length - 1; i++) {
    const prev = candles[i-1], curr = candles[i], next = candles[i+1];
    if (next.low > prev.high) fvgs.push({
      type:"bullish", top:next.low, bottom:prev.high,
      mid:(next.low+prev.high)/2,
      touched: price>=prev.high*0.999 && price<=next.low*1.001
    });
    if (next.high < prev.low) fvgs.push({
      type:"bearish", top:prev.low, bottom:next.high,
      mid:(prev.low+next.high)/2,
      touched: price>=next.high*0.999 && price<=prev.low*1.001
    });
  }
  return fvgs.length ? fvgs[fvgs.length-1] : null;
}

function candleOverlapsFVG(c, fvg) {
  const top = Math.max(c.open, c.close);
  const bot = Math.min(c.open, c.close);
  return bot <= fvg.top && top >= fvg.bottom;
}

function detectPattern(candles, fvg) {
  if (!fvg || candles.length < 3) return null;
  const c1 = candles[candles.length-3];
  const c2 = candles[candles.length-2];
  const c3 = candles[candles.length-1];
  const body = c => Math.abs(c.close - c.open);
  const avg = (c1.close+c2.close+c3.close)/3;
  const min = avg * 0.001;
  if (body(c1)<min || body(c2)<min || body(c3)<min) return null;
  if (body(c2) <= body(c1) || body(c2) <= body(c3)) return null;
  const anyIn = candleOverlapsFVG(c1,fvg)||candleOverlapsFVG(c2,fvg)||candleOverlapsFVG(c3,fvg);
  if (!anyIn) return null;
  const b1=c1.close>c1.open, b2=c2.close>c2.open, b3=c3.close>c3.open;
  if (!b1&&b2&&!b3&&fvg.type==="bullish") return {pattern:"RGR",bias:"bullish"};
  if (b1&&!b2&&b3&&fvg.type==="bearish") return {pattern:"GRG",bias:"bearish"};
  return null;
}

async function scanCoin(coin) {
  try {
    const price = await fetchPrice(coin);
    const tfData = {};
    for (const tf of ALL_TFS) {
      try {
        const candles = await fetchKlines(coin, TF_MAP[tf]);
        const fvg = detectFVG(candles, price);
        const pattern = ENTRY_TFS.includes(tf) ? detectPattern(candles, fvg) : null;
        tfData[tf] = { fvg, pattern };
        if (fvg) {
          console.log(`  📊 ${coin} ${tf}: FVG ${fvg.type} [${fvg.bottom.toFixed(4)}-${fvg.top.toFixed(4)}]${fvg.touched?" 🎯TOUCHED":""}${pattern?" ✅"+pattern.pattern:""}`);
        }
      } catch {
        tfData[tf] = { fvg:null, pattern:null };
      }
      await new Promise(res => setTimeout(res, 100));
    }
    const anyFVG = ALL_TFS.some(tf => tfData[tf].fvg);
    if (!anyFVG) return null;
    let bull=0, bear=0;
    ALL_TFS.forEach(tf => {
      const f = tfData[tf].fvg;
      if (f) { if(f.type==="bullish") bull++; else bear++; }
    });
    const bias = bull>=bear ? "bullish" : "bearish";
    const validEntries = ENTRY_TFS.filter(tf => {
      const p = tfData[tf].pattern;
      return p && p.bias === bias;
    });
    if (!validEntries.length) {
      const patterns = ENTRY_TFS.map(tf => {
        const p = tfData[tf].pattern;
        return `${tf}:${p ? p.pattern+"("+p.bias+")" : "none"}`;
      }).join(" ");
      console.log(`  ❌ ${coin}: bias=${bias} patterns=[${patterns}] → no valid entries`);
      return null;
    }
    const touched = ALL_TFS.filter(tf => tfData[tf].fvg?.touched).length;
    const score = touched*20 + validEntries.length*15 + (bias==="bullish"?5:0);
    return { coin, price, bias, validEntries, tfData, score };
  } catch (e) {
    console.log(`Error scanning ${coin}: ${e.message}`);
    return null;
  }
}

async function sendTelegram(msg) {
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: msg,
          parse_mode: "HTML",
          disable_web_page_preview: true
        })
      }
    );
    const data = await res.json();
    if (!data.ok) {
      console.log("Telegram API error:", JSON.stringify(data));
    }
  } catch (e) {
    console.log("Telegram error:", e.message);
  }
}

async function selfPing() {
  try {
    await fetchWithTimeout(`${RENDER_URL}/health`, 8000);
    console.log(`[${toPHT(new Date())}] Self-ping OK`);
  } catch (e) {
    console.log(`Self-ping failed: ${e.message}`);
  }
}

setInterval(selfPing, 10 * 60 * 1000);

let prevSetups = new Map();
let isScanning = false;

function getSetupKey(r) {
  return r.validEntries.map(tf => {
    const p = r.tfData[tf].pattern;
    return `${tf}:${p.pattern}`;
  }).join("|");
}

async function runScan() {
  if (isScanning) {
    console.log("⚠️ Scan already running, skipping...");
    return;
  }
  isScanning = true;
  const scanTime = getExactCandleTime();
  console.log(`[${scanTime}] Scanning 30 coins...`);
  try {
    const results = [];
    for (const coin of COINS) {
      const r = await scanCoin(coin);
      if (r) results.push(r);
      await new Promise(res => setTimeout(res, 300));
    }
    results.sort((a,b) => b.score - a.score);
    const newSetups = results.filter(r => {
      const key = getSetupKey(r);
      return prevSetups.get(r.coin) !== key;
    });
    if (newSetups.length > 0) {
      await sendTelegram(
`🔍 <b>FVG SCAN — ${scanTime} PHT</b>
━━━━━━━━━━━━━━━
Found <b>${newSetups.length}</b> new/updated setup(s)!`
      );
      for (const r of newSetups) {
        const emoji = r.bias === "bullish" ? "🟢" : "🔴";
        const bias = r.bias === "bullish" ? "BULLISH ▲" : "BEARISH ▼";
        const entries = r.validEntries.map(tf => {
          const p = r.tfData[tf].pattern;
          return `${tf}: ${p.pattern}`;
        }).join(" | ");
        const tvLink = getTVLink(r.coin, r.validEntries[0]);
        const tier = r.score>=50?"S":r.score>=30?"A":r.score>=15?"B":"C";
        const isTouched = r.validEntries.some(tf => r.tfData[tf].fvg?.touched);
        const msg =
`🎯 <b>VALID FVG SETUP</b>
━━━━━━━━━━━━━━━
${emoji} <b>${r.coin}/USDT</b> — ${bias}
💰 Price: $${r.price < 0.0001 ? r.price.toFixed(8) : r.price < 1 ? r.price.toFixed(5) : r.price.toFixed(3)}
📊 Entry: ${entries}${isTouched ? "\n🎯 PRICE IN FVG ZONE" : ""}
⭐ Score: ${r.score} [Tier ${tier}]
📈 <a href="${tvLink}">Open TradingView Chart</a>
🕐 Candle Close: ${scanTime} PHT
━━━━━━━━━━━━━━━`;
        await sendTelegram(msg);
        console.log(`✅ Sent: ${r.coin} ${bias} Score:${r.score}`);
        await new Promise(res => setTimeout(res, 500));
      }
    } else {
      console.log(`[${scanTime}] No new/updated setups.`);
    }
    prevSetups = new Map(results.map(r => [r.coin, getSetupKey(r)]));
  } catch (e) {
    console.log(`❌ Scan error: ${e.message}`);
  } finally {
    isScanning = false;
  }
}

function msUntilNext15M() {
  const now = new Date();
  const mins = now.getMinutes();
  const secs = now.getSeconds();
  const ms = now.getMilliseconds();
  const next = Math.ceil((mins+1)/15)*15;
  const diff = (next-mins)*60*1000 - secs*1000 - ms;
  return diff <= 0 ? 15*60*1000 : diff;
}

function scheduleScanner() {
  const ms = msUntilNext15M();
  console.log(`⏱ Next scan in ${Math.round(ms/1000)}s`);
  setTimeout(() => {
    runScan();
    setInterval(runScan, 15*60*1000);
  }, ms);
}

app.get("/", (req, res) => res.send("FVG Scanner Bot is running! 🚀"));
app.get("/health", (req, res) => res.json({
  status: "ok",
  time: toPHT(new Date()),
  nextScanIn: `${Math.round(msUntilNext15M()/1000)}s`
}));

app.listen(3000, () => {
  console.log("🚀 Server running on port 3000");
  selfPing();
  scheduleScanner();
});
