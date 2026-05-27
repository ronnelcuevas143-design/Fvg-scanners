import { useState, useEffect, useCallback, useRef } from "react";

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

const FUTURES_BASE = "https://fapi.binance.com";

// ✅ TELEGRAM CONFIG
const TELEGRAM_TOKEN = "8755442528:AAGgdF7mjlPGYQir_3LILYoUePMzJ-WeXrc";
const CHAT_ID = "8797963344";

// Philippine Time formatter
function toPHT(date) {
  return date.toLocaleString("en-PH", {
    timeZone: "Asia/Manila",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: true,
  });
}

function getTVLink(coin, tf) {
  const tvTF = {
    "1W":"W","1D":"D","4H":"240",
    "1H":"60","30M":"30","15M":"15"
  };
  return `https://www.tradingview.com/chart/?symbol=BINANCE:${coin}USDT.P&interval=${tvTF[tf]||"60"}`;
}

function msUntilNext15M() {
  const now = new Date();
  const minutes = now.getMinutes();
  const seconds = now.getSeconds();
  const ms = now.getMilliseconds();
  const nextMinute = Math.ceil((minutes + 1) / 15) * 15;
  const diffMinutes = nextMinute - minutes;
  const diffMs = (diffMinutes * 60 - seconds) * 1000 - ms;
  return diffMs <= 0 ? 15 * 60 * 1000 : diffMs;
}

async function requestNotificationPermission() {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  const result = await Notification.requestPermission();
  return result === "granted";
}

function sendNotification(title, body, coin) {
  if (Notification.permission !== "granted") return;
  const n = new Notification(title, {
    body,
    icon: "https://cryptologos.cc/logos/" + coin.toLowerCase() + "-logo.png",
    badge: "https://cryptologos.cc/logos/" + coin.toLowerCase() + "-logo.png",
    vibrate: [200, 100, 200],
    tag: coin,
    renotify: true,
  });
  setTimeout(() => n.close(), 8000);
}

// ✅ TELEGRAM ALERT FUNCTION
async function sendTelegramAlert(result) {
  try {
    const emoji = result.overallBias === "bullish" ? "🟢" : "🔴";
    const biasText = result.overallBias === "bullish" ? "BULLISH ▲" : "BEARISH ▼";
    const entries = result.validEntries.map(tf => {
      const p = result.tfData[tf].pattern;
      return `${tf}: ${p?.pattern || ""}`;
    }).join(" | ");
    const tier = getTier(result.score);
    const isTouched = result.validEntries.some(tf => result.tfData[tf].fvg?.touched);
    const tvLink = getTVLink(result.coin, result.validEntries[0]);
    const priceStr = result.price < 0.0001
      ? result.price.toFixed(8)
      : result.price < 1
      ? result.price.toFixed(5)
      : result.price.toFixed(3);
    const scanTime = toPHT(new Date());

    const msg =
`🎯 <b>VALID FVG SETUP</b>
━━━━━━━━━━━━━━━
${emoji} <b>${result.coin}/USDT</b> — ${biasText}
💰 Price: $${priceStr}
📊 Entry: ${entries}${isTouched ? "\n🎯 PRICE IN FVG ZONE" : ""}
⭐ Score: ${result.score} [Tier ${tier}]
📈 <a href="${tvLink}">Open TradingView Chart</a>
🕐 Detected: ${scanTime} PHT
━━━━━━━━━━━━━━━`;

    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: msg,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
  } catch (e) {
    console.log("Telegram error:", e.message);
  }
}

function playAlertSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();
    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);
    oscillator.frequency.setValueAtTime(880, ctx.currentTime);
    oscillator.frequency.setValueAtTime(660, ctx.currentTime + 0.1);
    oscillator.frequency.setValueAtTime(880, ctx.currentTime + 0.2);
    gainNode.gain.setValueAtTime(0.3, ctx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);
    oscillator.start(ctx.currentTime);
    oscillator.stop(ctx.currentTime + 0.4);
  } catch {}
}

async function fetchFuturesKlines(symbol, interval, limit = 101) {
  const res = await fetch(
    `${FUTURES_BASE}/fapi/v1/klines?symbol=${symbol}USDT&interval=${interval}&limit=${limit}`
  );
  if (!res.ok) throw new Error("Klines failed");
  const raw = await res.json();
  const closed = raw.slice(0, -1);
  return closed.map((k) => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
  }));
}

async function fetchFuturesPrice(symbol) {
  const res = await fetch(
    `${FUTURES_BASE}/fapi/v1/ticker/price?symbol=${symbol}USDT`
  );
  if (!res.ok) throw new Error("Price failed");
  const data = await res.json();
  return parseFloat(data.price);
}

function detectLatestFVG(candles, currentPrice) {
  const fvgs = [];
  for (let i = 1; i < candles.length - 1; i++) {
    const prev = candles[i - 1];
    const next = candles[i + 1];
    const curr = candles[i];
    if (next.low > prev.high) {
      fvgs.push({
        type: "bullish",
        top: next.low,
        bottom: prev.high,
        mid: (next.low + prev.high) / 2,
        time: curr.time,
        index: i,
      });
    }
    if (next.high < prev.low) {
      fvgs.push({
        type: "bearish",
        top: prev.low,
        bottom: next.high,
        mid: (prev.low + next.high) / 2,
        time: curr.time,
        index: i,
      });
    }
  }
  if (fvgs.length === 0) return null;
  const latest = fvgs[fvgs.length - 1];
  const touched =
    currentPrice >= latest.bottom * 0.999 &&
    currentPrice <= latest.top * 1.001;
  return { ...latest, touched };
}

function candleOverlapsFVG(candle, fvg) {
  const candleTop = Math.max(candle.open, candle.close);
  const candleBottom = Math.min(candle.open, candle.close);
  return candleBottom <= fvg.top && candleTop >= fvg.bottom;
}

function detectStrictPattern(candles, fvg) {
  if (!fvg || candles.length < 3) return null;
  const c1 = candles[candles.length - 3];
  const c2 = candles[candles.length - 2];
  const c3 = candles[candles.length - 1];
  const body = (c) => Math.abs(c.close - c.open);
  const c1Body = body(c1);
  const c2Body = body(c2);
  const c3Body = body(c3);
  const avgPrice = (c1.close + c2.close + c3.close) / 3;
  const minBody = avgPrice * 0.001;
  if (c1Body < minBody || c2Body < minBody || c3Body < minBody) return null;
  if (c2Body <= c1Body || c2Body <= c3Body) return null;
  const c1Bull = c1.close > c1.open;
  const c2Bull = c2.close > c2.open;
  const c3Bull = c3.close > c3.open;
  const anyInFVG =
    candleOverlapsFVG(c1, fvg) ||
    candleOverlapsFVG(c2, fvg) ||
    candleOverlapsFVG(c3, fvg);
  if (!anyInFVG) return null;
  if (!c1Bull && c2Bull && !c3Bull) {
    if (fvg.type !== "bullish") return null;
    return { pattern: "RGR", bias: "bullish", candles: [c1, c2, c3] };
  }
  if (c1Bull && !c2Bull && c3Bull) {
    if (fvg.type !== "bearish") return null;
    return { pattern: "GRG", bias: "bearish", candles: [c1, c2, c3] };
  }
  return null;
}

async function scanCoin(coin) {
  let currentPrice;
  try {
    currentPrice = await fetchFuturesPrice(coin);
  } catch {
    return null;
  }
  const tfData = {};
  for (const tf of ALL_TFS) {
    try {
      const candles = await fetchFuturesKlines(coin, TF_MAP[tf], 101);
      const fvg = detectLatestFVG(candles, currentPrice);
      const pattern = ENTRY_TFS.includes(tf)
        ? detectStrictPattern(candles, fvg)
        : null;
      tfData[tf] = { fvg, pattern, candles };
    } catch {
      tfData[tf] = { fvg: null, pattern: null, candles: [] };
    }
  }
  const anyFVG = ALL_TFS.some((tf) => tfData[tf].fvg !== null);
  if (!anyFVG) return null;
  const entryConfirmations = ENTRY_TFS.filter((tf) => tfData[tf].pattern !== null);
  if (entryConfirmations.length === 0) return null;
  let bullCount = 0, bearCount = 0;
  ALL_TFS.forEach((tf) => {
    const fvg = tfData[tf].fvg;
    if (fvg) {
      if (fvg.type === "bullish") bullCount++;
      else bearCount++;
    }
  });
  const overallBias = bullCount >= bearCount ? "bullish" : "bearish";
  const validEntries = entryConfirmations.filter((tf) => {
    const p = tfData[tf].pattern;
    return p && p.bias === overallBias;
  });
  if (validEntries.length === 0) return null;
  const touchedCount = ALL_TFS.filter((tf) => tfData[tf].fvg?.touched).length;
  const score = touchedCount * 20 + validEntries.length * 15 +
    (overallBias === "bullish" ? 5 : 0);
  return { coin, price: currentPrice, tfData, overallBias, validEntries, touchedCount, score };
}

const TIER_COLORS = {
  S: { bg: "#ff3c5f", text: "#fff" },
  A: { bg: "#ff8c00", text: "#fff" },
  B: { bg: "#f5c518", text: "#000" },
  C: { bg: "#4ecdc4", text: "#000" },
};

function getTier(score) {
  if (score >= 50) return "S";
  if (score >= 30) return "A";
  if (score >= 15) return "B";
  return "C";
}

function CandleViz({ candles }) {
  if (!candles || candles.length < 3) return null;
  return (
    <div style={{ display: "flex", gap: 2, alignItems: "center" }}>
      {candles.map((c, i) => {
        const isBull = c.close > c.open;
        return (
          <div key={i} style={{ display: "flex", flexDirection: "column",
            alignItems: "center", gap: 1 }}>
            <div style={{ width: 1, height: 4, background: isBull ? "#22c55e" : "#ef4444" }} />
            <div style={{
              width: 8, height: i === 1 ? 16 : 10, borderRadius: 2,
              background: isBull ? "#22c55e" : "#ef4444",
              opacity: i === 1 ? 1 : 0.65,
            }} />
            <div style={{ width: 1, height: 4, background: isBull ? "#22c55e" : "#ef4444" }} />
          </div>
        );
      })}
    </div>
  );
}

function FVGBadge({ fvg }) {
  if (!fvg) return <span style={{ color: "#374151", fontSize: 9 }}>—</span>;
  const isBull = fvg.type === "bullish";
  return (
    <div style={{
      padding: "3px 7px", borderRadius: 4, fontSize: 9, fontWeight: 700,
      background: fvg.touched
        ? (isBull ? "#22c55e30" : "#ef444430")
        : (isBull ? "#22c55e10" : "#ef444410"),
      color: isBull ? "#22c55e" : "#ef4444",
      border: `1px solid ${fvg.touched
        ? (isBull ? "#22c55e60" : "#ef444460")
        : (isBull ? "#22c55e25" : "#ef444425")}`,
      display: "flex", alignItems: "center", gap: 4,
    }}>
      {fvg.touched && <span style={{ color: "#f59e0b" }}>●</span>}
      {isBull ? "▲" : "▼"} {fvg.bottom.toFixed(4)}–{fvg.top.toFixed(4)}
    </div>
  );
}

function SetupCard({ result }) {
  const tier = getTier(result.score);
  const tc = TIER_COLORS[tier];
  const [expanded, setExpanded] = useState(false);
  const isBull = result.overallBias === "bullish";
  return (
    <div style={{
      background: "#0d1117", borderRadius: 10,
      border: `1px solid ${isBull ? "#22c55e30" : "#ef444430"}`,
      overflow: "hidden",
    }}>
      <div onClick={() => setExpanded(!expanded)} style={{
        padding: "14px 16px", cursor: "pointer",
        background: isBull ? "#22c55e08" : "#ef444408",
        display: "flex", alignItems: "center", justifyContent: "space-between",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{
            display: "inline-flex", width: 28, height: 28, borderRadius: 6,
            background: tc.bg, color: tc.text,
            alignItems: "center", justifyContent: "center",
            fontSize: 12, fontWeight: 900,
          }}>{tier}</span>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span style={{ fontSize: 16, fontWeight: 800, color: "#fff" }}>{result.coin}</span>
              <span style={{ fontSize: 9, color: "#374151" }}>/USDT</span>
              <span style={{
                padding: "2px 7px", borderRadius: 3, fontSize: 9, fontWeight: 700,
                background: isBull ? "#22c55e20" : "#ef444420",
                color: isBull ? "#22c55e" : "#ef4444",
              }}>{isBull ? "▲ BULL" : "▼ BEAR"}</span>
              <a href={getTVLink(result.coin, result.validEntries[0])}
                target="_blank" rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                style={{
                  padding: "2px 7px", borderRadius: 3, fontSize: 9, fontWeight: 700,
                  background: "#1e293b", color: "#00d4ff",
                  textDecoration: "none", border: "1px solid #00d4ff30",
                }}>📈 TV</a>
            </div>
            <div style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>
              ${result.price < 0.0001 ? result.price.toFixed(8) :
                result.price < 1 ? result.price.toFixed(5) : result.price.toFixed(3)}
              <span style={{ fontSize: 9, color: "#374151", marginLeft: 6 }}>FUTURES</span>
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 18, fontWeight: 800,
              color: isBull ? "#22c55e" : "#ef4444" }}>{result.score}</div>
            <div style={{ fontSize: 8, color: "#374151" }}>SCORE</div>
          </div>
          <span style={{ color: "#374151" }}>{expanded ? "▲" : "▼"}</span>
        </div>
      </div>
      <div style={{ padding: "10px 16px", borderTop: "1px solid #1e293b",
        display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: 9, color: "#374151" }}>ENTRY:</span>
        {result.validEntries.map((tf) => {
          const p = result.tfData[tf].pattern;
          const fvg = result.tfData[tf].fvg;
          return (
            <a key={tf} href={getTVLink(result.coin, tf)}
              target="_blank" rel="noopener noreferrer"
              style={{
                display: "flex", alignItems: "center", gap: 6,
                background: "#111827", padding: "5px 10px", borderRadius: 6,
                border: `1px solid ${p.bias === "bullish" ? "#22c55e40" : "#ef444440"}`,
                textDecoration: "none",
              }}>
              <span style={{ fontSize: 9, color: "#64748b", fontWeight: 700 }}>{tf}</span>
              <CandleViz candles={p.candles} />
              <span style={{ fontSize: 9, fontWeight: 700,
                color: p.bias === "bullish" ? "#22c55e" : "#ef4444" }}>{p.pattern}</span>
              {fvg?.touched && <span style={{ fontSize: 8, color: "#f59e0b" }}>●FVG</span>}
              <span style={{ fontSize: 8, color: "#00d4ff60" }}>↗</span>
            </a>
          );
        })}
      </div>
      {expanded && (
        <div style={{ padding: "12px 16px", borderTop: "1px solid #1e293b",
          display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(155px, 1fr))", gap: 8 }}>
          {ALL_TFS.map((tf) => {
            const { fvg, pattern } = result.tfData[tf];
            const isEntry = ENTRY_TFS.includes(tf);
            const hasValidPattern = pattern && pattern.bias === result.overallBias;
            return (
              <a key={tf} href={getTVLink(result.coin, tf)}
                target="_blank" rel="noopener noreferrer"
                style={{
                  background: "#111827", borderRadius: 8, padding: 10,
                  border: fvg?.touched
                    ? `1px solid ${isBull ? "#22c55e50" : "#ef444450"}`
                    : "1px solid #1e293b",
                  textDecoration: "none", display: "block",
                }}>
                <div style={{ display: "flex", justifyContent: "space-between",
                  alignItems: "center", marginBottom: 6 }}>
                  <span style={{ fontSize: 10, fontWeight: 700,
                    color: isEntry ? "#00d4ff" : "#94a3b8" }}>{tf}</span>
                  {fvg?.touched && (
                    <span style={{ fontSize: 8, color: "#f59e0b",
                      background: "#f59e0b15", padding: "1px 5px", borderRadius: 2 }}>
                      ● IN FVG
                    </span>
                  )}
                </div>
                <FVGBadge fvg={fvg} />
                {isEntry && hasValidPattern && (
                  <div style={{ marginTop: 6, display: "flex",
                    alignItems: "center", gap: 5,
                    background: "#0d1117", padding: "4px 6px", borderRadius: 4 }}>
                    <CandleViz candles={pattern.candles} />
                    <div>
                      <div style={{ fontSize: 9, fontWeight: 700,
                        color: pattern.bias === "bullish" ? "#22c55e" : "#ef4444" }}>
                        {pattern.pattern}
                      </div>
                      <div style={{ fontSize: 8, color: "#22c55e80" }}>in FVG ✓</div>
                    </div>
                  </div>
                )}
                {isEntry && !hasValidPattern && (
                  <div style={{ marginTop: 6, fontSize: 9, color: "#1e293b" }}>No pattern</div>
                )}
                <div style={{ marginTop: 5, fontSize: 8, color: "#00d4ff40" }}>📈 Open TV ↗</div>
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function FVGScanner() {
  const [results, setResults] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [lastScan, setLastScan] = useState(null);
  const [nextScan, setNextScan] = useState(null);
  const [notifEnabled, setNotifEnabled] = useState(false);
  const [filter, setFilter] = useState("ALL");
  const [apiError, setApiError] = useState(null);
  const [prevCoins, setPrevCoins] = useState(new Set());
  const scheduleRef = useRef(null);

  const runScan = useCallback(async (isAuto = false) => {
    // ✅ Reschedule timer on manual scan too
    if (!isAuto) {
      if (scheduleRef.current) clearTimeout(scheduleRef.current);
      scheduleNextScan();
    }
    setScanning(true);
    setProgress(0);
    setApiError(null);
    const valid = [];

    for (let i = 0; i < COINS.length; i++) {
      try {
        const res = await scanCoin(COINS[i]);
        if (res !== null) valid.push(res);
      } catch {
        if (i === 0) setApiError("API error. Check connection.");
      }
      setProgress(Math.round(((i + 1) / COINS.length) * 100));
      await new Promise((r) => setTimeout(r, 150));
    }

    valid.sort((a, b) => b.score - a.score);
    setResults(valid);
    setLastScan(new Date());
    setScanning(false);

    // ✅ Notify new setups — Browser + Telegram
    if (isAuto && notifEnabled) {
      const newCoins = valid.filter((r) => !prevCoins.has(r.coin));
      if (newCoins.length > 0) {
        playAlertSound();
        for (const r of newCoins) {
          // Browser notification
          sendNotification(
            `🎯 ${r.coin} ${r.overallBias === "bullish" ? "▲ BULL" : "▼ BEAR"} Setup!`,
            `${r.validEntries.map(tf => `${tf}: ${r.tfData[tf].pattern?.pattern}`).join(" | ")} | Score: ${r.score}`,
            r.coin
          );
          // ✅ Telegram notification
          await sendTelegramAlert(r);
        }
      }
    }
    setPrevCoins(new Set(valid.map((r) => r.coin)));
  }, [notifEnabled, prevCoins]);

  const scheduleNextScan = useCallback(() => {
    if (scheduleRef.current) clearTimeout(scheduleRef.current);
    const ms = msUntilNext15M();
    const next = new Date(Date.now() + ms);
    setNextScan(next);
    scheduleRef.current = setTimeout(() => {
      runScan(true);
      scheduleNextScan();
    }, ms);
  }, [runScan]);

  useEffect(() => {
    runScan(false);
    scheduleNextScan();
    return () => { if (scheduleRef.current) clearTimeout(scheduleRef.current); };
  }, []);

  const handleNotifToggle = async () => {
    if (!notifEnabled) {
      const granted = await requestNotificationPermission();
      if (granted) {
        setNotifEnabled(true);
      } else {
        alert("Please allow notifications in your browser settings.");
      }
    } else {
      setNotifEnabled(false);
    }
  };

  const filtered = results.filter((r) =>
    filter === "ALL" || r.overallBias.toUpperCase() === filter
  );
  const bullCount = results.filter((r) => r.overallBias === "bullish").length;
  const bearCount = results.filter((r) => r.overallBias === "bearish").length;

  return (
    <div style={{ minHeight: "100vh", background: "#0a0b0f",
      color: "#e0e0e0", fontFamily: "'JetBrains Mono', 'Fira Code', monospace" }}>
      <div style={{ background: "linear-gradient(135deg, #0d1117, #111827)",
        borderBottom: "1px solid #1e293b", padding: "16px 20px",
        position: "sticky", top: 0, zIndex: 100 }}>
        <div style={{ display: "flex", alignItems: "center",
          justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 34, height: 34, borderRadius: 8,
              background: "linear-gradient(135deg, #00d4ff, #7b2fff)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 16, fontWeight: 900 }}>⊛</div>
            <div>
              <div style={{ fontSize: 16, fontWeight: 700, color: "#fff" }}>FVG SCANNER</div>
              <div style={{ fontSize: 9, color: "#4a5568" }}>
                FUTURES · IN-FVG PATTERN · PHT · 15M AUTO
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <button onClick={handleNotifToggle} style={{
              padding: "5px 10px", borderRadius: 6, border: "none", cursor: "pointer",
              background: notifEnabled ? "#f59e0b22" : "#1e293b",
              color: notifEnabled ? "#f59e0b" : "#64748b",
              fontSize: 10, fontFamily: "inherit" }}>
              {notifEnabled ? "🔔 ON" : "🔕 OFF"}
            </button>
            <button onClick={() => runScan(false)} disabled={scanning} style={{
              padding: "5px 14px", borderRadius: 6, border: "none",
              cursor: scanning ? "not-allowed" : "pointer",
              background: scanning ? "#1e293b" : "linear-gradient(135deg, #00d4ff, #7b2fff)",
              color: scanning ? "#4a5568" : "#fff",
              fontSize: 10, fontFamily: "inherit", fontWeight: 700 }}>
              {scanning ? `SCANNING ${progress}%` : "▶ SCAN NOW"}
            </button>
          </div>
        </div>
        <div style={{ marginTop: 8, display: "flex", gap: 12, flexWrap: "wrap" }}>
          <span style={{ fontSize: 9, color: "#374151" }}>
            🕐 PHT: {lastScan ? toPHT(lastScan) : "—"}
          </span>
          {nextScan && !scanning && (
            <span style={{ fontSize: 9, color: "#00d4ff60" }}>
              ⏱ NEXT 15M SCAN: {toPHT(nextScan)}
            </span>
          )}
        </div>
        {scanning && (
          <div style={{ marginTop: 8, height: 2, background: "#1e293b", borderRadius: 2 }}>
            <div style={{ height: "100%", borderRadius: 2,
              background: "linear-gradient(90deg, #00d4ff, #7b2fff)",
              width: `${progress}%`, transition: "width 0.15s" }} />
          </div>
        )}
      </div>

      {apiError && (
        <div style={{ background: "#1a0a00", padding: "8px 20px",
          fontSize: 11, color: "#ff8c00", borderBottom: "1px solid #ff8c0030" }}>
          ⚠ {apiError}
        </div>
      )}

      <div style={{ display: "flex", gap: 1, background: "#0d1117",
        borderBottom: "1px solid #1e293b" }}>
        {[
          { label: "VALID SETUPS", value: results.length, color: "#00d4ff" },
          { label: "BULLISH", value: bullCount, color: "#22c55e" },
          { label: "BEARISH", value: bearCount, color: "#ef4444" },
          { label: "SCANNED",
            value: `${Math.round(progress/100*COINS.length)}/${COINS.length}`,
            color: "#94a3b8" },
        ].map((s) => (
          <div key={s.label} style={{ flex: 1, padding: "10px 8px",
            textAlign: "center", borderRight: "1px solid #1e293b" }}>
            <div style={{ fontSize: 20, fontWeight: 800, color: s.color }}>{s.value}</div>
            <div style={{ fontSize: 8, color: "#374151", letterSpacing: "0.1em" }}>{s.label}</div>
          </div>
        ))}
      </div>

      <div style={{ padding: "10px 16px", display: "flex", gap: 6,
        background: "#0d1117", borderBottom: "1px solid #1e293b" }}>
        {["ALL","BULLISH","BEARISH"].map((f) => (
          <button key={f} onClick={() => setFilter(f)} style={{
            padding: "5px 12px", borderRadius: 6, border: "none", cursor: "pointer",
            background: filter === f
              ? f === "BULLISH" ? "#22c55e22" : f === "BEARISH" ? "#ef444422" : "#00d4ff22"
              : "#111827",
            color: filter === f
              ? f === "BULLISH" ? "#22c55e" : f === "BEARISH" ? "#ef4444" : "#00d4ff"
              : "#4a5568",
            fontSize: 10, fontFamily: "inherit" }}>{f}</button>
        ))}
      </div>

      <div style={{ padding: "16px", display: "flex", flexDirection: "column", gap: 10 }}>
        {scanning && results.length === 0 && (
          <div style={{ textAlign: "center", padding: "60px 20px", color: "#374151" }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>⊛</div>
            <div style={{ fontSize: 12 }}>Scanning futures market...</div>
            <div style={{ fontSize: 10, marginTop: 6, color: "#1e293b" }}>
              Pattern must form inside FVG zone
            </div>
          </div>
        )}
        {!scanning && filtered.length === 0 && (
          <div style={{ textAlign: "center", padding: "60px 20px", color: "#374151" }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>◎</div>
            <div style={{ fontSize: 12 }}>No valid setups found.</div>
            <div style={{ fontSize: 10, marginTop: 6, color: "#1e293b" }}>
              Waiting for next 15M candle close...
            </div>
          </div>
        )}
        {filtered.map((r) => (
          <SetupCard key={r.coin} result={r} />
        ))}
      </div>

      <div style={{ padding: "14px 20px", borderTop: "1px solid #1e293b",
        background: "#0a0b0f", fontSize: 10, color: "#374151",
        display: "flex", gap: 16, flexWrap: "wrap" }}>
        <span>● = Price in FVG</span>
        <span style={{ color: "#22c55e" }}>RGR = Bullish</span>
        <span style={{ color: "#ef4444" }}>GRG = Bearish</span>
        <span>Pattern inside FVG zone only</span>
        <span style={{ color: "#f59e0b" }}>🔔 = Browser + Telegram Alert</span>
        <span>Auto scan every 15M close PHT</span>
      </div>
    </div>
  );
}

