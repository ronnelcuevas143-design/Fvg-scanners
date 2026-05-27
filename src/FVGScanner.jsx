import { useState, useEffect, useRef, useCallback } from "react";

// ✅ CONFIG
const TELEGRAM_TOKEN = "8755442528:AAGgdF7mjlPGYQir_3LILYoUePMzJ-WeXrc";
const CHAT_ID = "8797963344";
const FUTURES_BASE = "https://fapi.binance.com";

const COINS = [
  "BTC","ETH","BNB","SOL","XRP","ADA","AVAX","DOT","MATIC","LINK",
  "LTC","UNI","ATOM","FIL","APT","ARB","OP","INJ","SUI","SEI",
  "TIA","WLD","BLUR","DYDX","GMX","PEPE","WIF","BONK","JUP","PYTH"
];

const ALL_TFS = ["1W","1D","4H","1H","30M","15M"];
const ENTRY_TFS = ["1H","30M","15M"];
const TF_MAP = { "1W":"1w","1D":"1d","4H":"4h","1H":"1h","30M":"30m","15M":"15m" };
const TV_MAP  = { "1W":"W","1D":"D","4H":"240","1H":"60","30M":"30","15M":"15" };

function toPHT(date) {
  return date.toLocaleString("en-PH", {
    timeZone:"Asia/Manila", hour:"2-digit", minute:"2-digit", second:"2-digit", hour12:true
  });
}
function getTVLink(coin, tf) {
  return `https://www.tradingview.com/chart/?symbol=BINANCE:${coin}USDT.P&interval=${TV_MAP[tf]||"60"}`;
}
function msUntilNext15M() {
  const now = new Date();
  const mins = now.getMinutes(), secs = now.getSeconds(), ms = now.getMilliseconds();
  const next = Math.ceil((mins + 1) / 15) * 15;
  const diff = (next - mins) * 60000 - secs * 1000 - ms;
  return diff <= 0 ? 15 * 60000 : diff;
}
function getTier(score) {
  if (score >= 50) return "S";
  if (score >= 30) return "A";
  if (score >= 15) return "B";
  return "C";
}

// ── API ──────────────────────────────────────────────────
async function fetchKlines(symbol, interval) {
  const res = await fetch(`${FUTURES_BASE}/fapi/v1/klines?symbol=${symbol}USDT&interval=${interval}&limit=101`);
  if (!res.ok) throw new Error("Klines failed");
  const raw = await res.json();
  return raw.slice(0, -1).map(k => ({
    time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
    low: parseFloat(k[3]), close: parseFloat(k[4])
  }));
}
async function fetchPrice(symbol) {
  const res = await fetch(`${FUTURES_BASE}/fapi/v1/ticker/price?symbol=${symbol}USDT`);
  if (!res.ok) throw new Error("Price failed");
  return parseFloat((await res.json()).price);
}

// ── DETECTION ────────────────────────────────────────────
function detectFVG(candles, price) {
  const fvgs = [];
  for (let i = 1; i < candles.length - 1; i++) {
    const p = candles[i-1], n = candles[i+1], c = candles[i];
    if (n.low > p.high) fvgs.push({ type:"bullish", top:n.low, bottom:p.high, mid:(n.low+p.high)/2,
      touched: price >= p.high*0.999 && price <= n.low*1.001 });
    if (n.high < p.low) fvgs.push({ type:"bearish", top:p.low, bottom:n.high, mid:(p.low+n.high)/2,
      touched: price >= n.high*0.999 && price <= p.low*1.001 });
  }
  return fvgs.length ? fvgs[fvgs.length-1] : null;
}
function overlapsFVG(c, fvg) {
  const top = Math.max(c.open, c.close), bot = Math.min(c.open, c.close);
  return bot <= fvg.top && top >= fvg.bottom;
}
function detectPattern(candles, fvg) {
  if (!fvg || candles.length < 3) return null;
  const c1 = candles[candles.length-3], c2 = candles[candles.length-2], c3 = candles[candles.length-1];
  const body = c => Math.abs(c.close - c.open);
  const avg = (c1.close+c2.close+c3.close)/3;
  if (body(c1)<avg*0.001 || body(c2)<avg*0.001 || body(c3)<avg*0.001) return null;
  if (body(c2) <= body(c1) || body(c2) <= body(c3)) return null;
  if (!overlapsFVG(c1,fvg) && !overlapsFVG(c2,fvg) && !overlapsFVG(c3,fvg)) return null;
  const b1=c1.close>c1.open, b2=c2.close>c2.open, b3=c3.close>c3.open;
  if (!b1&&b2&&!b3&&fvg.type==="bullish") return { pattern:"RGR", bias:"bullish", lastTime:c3.time };
  if (b1&&!b2&&b3&&fvg.type==="bearish")  return { pattern:"GRG", bias:"bearish", lastTime:c3.time };
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
      } catch { tfData[tf] = { fvg:null, pattern:null }; }
      await new Promise(r => setTimeout(r, 80));
    }
    const anyFVG = ALL_TFS.some(tf => tfData[tf].fvg);
    if (!anyFVG) return null;
    let bull=0, bear=0;
    ALL_TFS.forEach(tf => { const f=tfData[tf].fvg; if(f){ f.type==="bullish"?bull++:bear++; } });
    const bias = bull >= bear ? "bullish" : "bearish";
    const validEntries = ENTRY_TFS.filter(tf => tfData[tf].pattern?.bias === bias);
    if (!validEntries.length) return null;
    const touched = ALL_TFS.filter(tf => tfData[tf].fvg?.touched).length;
    const score = touched*20 + validEntries.length*15 + (bias==="bullish"?5:0);
    return { coin, price, bias, validEntries, tfData, score };
  } catch { return null; }
}

// ── NOTIFICATIONS ────────────────────────────────────────
async function requestNotifPermission() {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  return (await Notification.requestPermission()) === "granted";
}
function sendBrowserNotif(coin, bias, pattern, score, tf) {
  if (Notification.permission !== "granted") return;
  const emoji = bias === "bullish" ? "🟢" : "🔴";
  const n = new Notification(`${emoji} ${coin}/USDT — ${bias.toUpperCase()}`, {
    body: `${tf}: ${pattern} | Score: ${score} [Tier ${getTier(score)}]`,
    tag: `fvg-${coin}`,
    requireInteraction: true,
  });
  n.onclick = () => { window.open(getTVLink(coin, tf), "_blank"); n.close(); };
}
function playSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(660, ctx.currentTime + 0.15);
    osc.frequency.setValueAtTime(880, ctx.currentTime + 0.3);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
    osc.start(); osc.stop(ctx.currentTime + 0.5);
  } catch {}
}
async function sendTelegram(result) {
  try {
    const emoji = result.bias === "bullish" ? "🟢" : "🔴";
    const biasText = result.bias === "bullish" ? "BULLISH ▲" : "BEARISH ▼";
    const entries = result.validEntries.map(tf => `${tf}: ${result.tfData[tf].pattern?.pattern}`).join(" | ");
    const tier = getTier(result.score);
    const isTouched = result.validEntries.some(tf => result.tfData[tf].fvg?.touched);
    const tvLink = getTVLink(result.coin, result.validEntries[0]);
    const priceStr = result.price < 0.0001 ? result.price.toFixed(8)
      : result.price < 1 ? result.price.toFixed(5) : result.price.toFixed(3);
    const msg =
`🎯 <b>FVG SETUP DETECTED</b>
━━━━━━━━━━━━━━━
${emoji} <b>${result.coin}/USDT</b> — ${biasText}
💰 Price: $${priceStr}
📊 Entry: ${entries}${isTouched ? "\n🎯 PRICE IN FVG ZONE" : ""}
⭐ Score: ${result.score} [Tier ${tier}]
📈 <a href="${tvLink}">Open TradingView</a>
🕐 ${toPHT(new Date())} PHT
━━━━━━━━━━━━━━━`;
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ chat_id:CHAT_ID, text:msg, parse_mode:"HTML", disable_web_page_preview:true })
    });
  } catch(e) { console.log("TG error:", e.message); }
}

// ── TIER COLORS ──────────────────────────────────────────
const TIER_COLORS = { S:"#ff3c5f", A:"#ff8c00", B:"#f5c518", C:"#4ecdc4" };

// ── SETUP CARD ───────────────────────────────────────────
function SetupCard({ result }) {
  const [expanded, setExpanded] = useState(false);
  const tier = getTier(result.score);
  const isBull = result.bias === "bullish";
  return (
    <div style={{ background:"#0d1117", borderRadius:10, marginBottom:10,
      border:`1px solid ${isBull?"#22c55e30":"#ef444430"}`, overflow:"hidden" }}>
      <div onClick={() => setExpanded(!expanded)} style={{
        padding:"14px 16px", cursor:"pointer",
        background: isBull?"#22c55e08":"#ef444408",
        display:"flex", alignItems:"center", justifyContent:"space-between" }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <span style={{ display:"inline-flex", width:28, height:28, borderRadius:6,
            background:TIER_COLORS[tier], color: tier==="B"?"#000":"#fff",
            alignItems:"center", justifyContent:"center", fontSize:12, fontWeight:900 }}>{tier}</span>
          <div>
            <div style={{ display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" }}>
              <span style={{ fontSize:16, fontWeight:800, color:"#fff" }}>{result.coin}</span>
              <span style={{ fontSize:9, color:"#374151" }}>/USDT</span>
              <span style={{ padding:"2px 7px", borderRadius:3, fontSize:9, fontWeight:700,
                background:isBull?"#22c55e20":"#ef444420", color:isBull?"#22c55e":"#ef4444" }}>
                {isBull?"▲ BULL":"▼ BEAR"}
              </span>
              <a href={getTVLink(result.coin, result.validEntries[0])}
                target="_blank" rel="noopener noreferrer"
                onClick={e => e.stopPropagation()}
                style={{ padding:"2px 7px", borderRadius:3, fontSize:9, fontWeight:700,
                  background:"#1e293b", color:"#00d4ff", textDecoration:"none" }}>📈 TV</a>
            </div>
            <div style={{ fontSize:11, color:"#64748b", marginTop:2 }}>
              ${result.price < 0.0001 ? result.price.toFixed(8) : result.price < 1 ? result.price.toFixed(5) : result.price.toFixed(3)}
              <span style={{ fontSize:9, color:"#374151", marginLeft:6 }}>FUTURES</span>
            </div>
          </div>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <div style={{ textAlign:"right" }}>
            <div style={{ fontSize:18, fontWeight:800, color:isBull?"#22c55e":"#ef4444" }}>{result.score}</div>
            <div style={{ fontSize:8, color:"#374151" }}>SCORE</div>
          </div>
          <span style={{ color:"#374151" }}>{expanded?"▲":"▼"}</span>
        </div>
      </div>

      <div style={{ padding:"10px 16px", borderTop:"1px solid #1e293b",
        display:"flex", gap:8, flexWrap:"wrap", alignItems:"center" }}>
        <span style={{ fontSize:9, color:"#374151" }}>ENTRY:</span>
        {result.validEntries.map(tf => {
          const p = result.tfData[tf].pattern;
          const fvg = result.tfData[tf].fvg;
          return (
            <a key={tf} href={getTVLink(result.coin, tf)} target="_blank" rel="noopener noreferrer"
              style={{ display:"flex", alignItems:"center", gap:6, background:"#111827",
                padding:"5px 10px", borderRadius:6, textDecoration:"none",
                border:`1px solid ${isBull?"#22c55e40":"#ef444440"}` }}>
              <span style={{ fontSize:9, color:"#64748b", fontWeight:700 }}>{tf}</span>
              <span style={{ fontSize:9, fontWeight:700, color:isBull?"#22c55e":"#ef4444" }}>{p?.pattern}</span>
              {fvg?.touched && <span style={{ fontSize:8, color:"#f59e0b" }}>●FVG</span>}
            </a>
          );
        })}
      </div>

      {expanded && (
        <div style={{ padding:"12px 16px", borderTop:"1px solid #1e293b",
          display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(140px,1fr))", gap:8 }}>
          {ALL_TFS.map(tf => {
            const { fvg, pattern } = result.tfData[tf];
            const isEntry = ENTRY_TFS.includes(tf);
            const hasPattern = pattern?.bias === result.bias;
            return (
              <a key={tf} href={getTVLink(result.coin, tf)} target="_blank" rel="noopener noreferrer"
                style={{ background:"#111827", borderRadius:8, padding:10, textDecoration:"none",
                  border: fvg?.touched ? `1px solid ${isBull?"#22c55e50":"#ef444450"}` : "1px solid #1e293b" }}>
                <div style={{ display:"flex", justifyContent:"space-between", marginBottom:4 }}>
                  <span style={{ fontSize:10, fontWeight:700, color:isEntry?"#00d4ff":"#94a3b8" }}>{tf}</span>
                  {fvg?.touched && <span style={{ fontSize:8, color:"#f59e0b" }}>●FVG</span>}
                </div>
                {fvg ? (
                  <div style={{ fontSize:9, color:fvg.type==="bullish"?"#22c55e":"#ef4444" }}>
                    {fvg.type==="bullish"?"▲":"▼"} {fvg.bottom.toFixed(4)}–{fvg.top.toFixed(4)}
                  </div>
                ) : <div style={{ fontSize:9, color:"#374151" }}>No FVG</div>}
                {isEntry && hasPattern && (
                  <div style={{ fontSize:9, fontWeight:700, marginTop:4, color:isBull?"#22c55e":"#ef4444" }}>
                    {pattern.pattern} ✓
                  </div>
                )}
                <div style={{ fontSize:8, color:"#00d4ff40", marginTop:4 }}>📈 TV ↗</div>
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── MAIN ─────────────────────────────────────────────────
export default function FVGScanner() {
  const [results, setResults]       = useState([]);
  const [scanning, setScanning]     = useState(false);
  const [progress, setProgress]     = useState(0);
  const [lastScan, setLastScan]     = useState(null);
  const [nextScan, setNextScan]     = useState(null);
  const [notifOn, setNotifOn]       = useState(false);
  const [filter, setFilter]         = useState("ALL");
  const scheduleRef                 = useRef(null);
  const notifRef                    = useRef(false);

  // keep notifRef in sync
  useEffect(() => { notifRef.current = notifOn; }, [notifOn]);

  const runScan = useCallback(async () => {
    if (scanning) return;
    setScanning(true);
    setProgress(0);
    const valid = [];
    for (let i = 0; i < COINS.length; i++) {
      const r = await scanCoin(COINS[i]);
      if (r) valid.push(r);
      setProgress(Math.round((i+1)/COINS.length*100));
      await new Promise(r => setTimeout(r, 100));
    }
    valid.sort((a,b) => b.score - a.score);
    setResults(valid);
    setLastScan(new Date());
    setScanning(false);

    // ✅ Always alert for ALL setups found (not just new ones)
    if (notifRef.current && valid.length > 0) {
      playSound();
      for (const r of valid) {
        const tf = r.validEntries[0];
        const p  = r.tfData[tf].pattern?.pattern || "";
        sendBrowserNotif(r.coin, r.bias, p, r.score, tf);
        await sendTelegram(r);
        await new Promise(res => setTimeout(res, 300));
      }
    }
  }, [scanning]);

  const scheduleNext = useCallback(() => {
    if (scheduleRef.current) clearTimeout(scheduleRef.current);
    const ms   = msUntilNext15M();
    const next = new Date(Date.now() + ms);
    setNextScan(next);
    scheduleRef.current = setTimeout(async () => {
      await runScan();
      scheduleNext();
    }, ms);
  }, [runScan]);

  useEffect(() => {
    runScan();
    scheduleNext();
    return () => { if (scheduleRef.current) clearTimeout(scheduleRef.current); };
  }, []);

  const handleNotifToggle = async () => {
    if (!notifOn) {
      const ok = await requestNotifPermission();
      if (ok) setNotifOn(true);
      else alert("Allow notifications sa browser settings mo.");
    } else {
      setNotifOn(false);
    }
  };

  const handleScanNow = async () => {
    scheduleNext(); // reset timer
    await runScan();
  };

  const filtered = results.filter(r =>
    filter === "ALL" || r.bias.toUpperCase() === filter
  );

  return (
    <div style={{ minHeight:"100vh", background:"#0a0b0f", color:"#e0e0e0",
      fontFamily:"'JetBrains Mono','Fira Code',monospace" }}>

      {/* HEADER */}
      <div style={{ background:"linear-gradient(135deg,#0d1117,#111827)",
        borderBottom:"1px solid #1e293b", padding:"16px 20px",
        position:"sticky", top:0, zIndex:100 }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:10 }}>
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            <div style={{ width:34, height:34, borderRadius:8,
              background:"linear-gradient(135deg,#00d4ff,#7b2fff)",
              display:"flex", alignItems:"center", justifyContent:"center", fontSize:16 }}>⊛</div>
            <div>
              <div style={{ fontSize:16, fontWeight:700, color:"#fff" }}>FVG SCANNER</div>
              <div style={{ fontSize:9, color:"#4a5568" }}>FUTURES · RGR/GRG · PHT · 15M AUTO</div>
            </div>
          </div>
          <div style={{ display:"flex", gap:6, alignItems:"center", flexWrap:"wrap" }}>
            <button onClick={handleNotifToggle} style={{
              padding:"5px 10px", borderRadius:6, border:"none", cursor:"pointer",
              background: notifOn?"#f59e0b22":"#1e293b",
              color: notifOn?"#f59e0b":"#64748b", fontSize:10, fontFamily:"inherit" }}>
              {notifOn ? "🔔 ON" : "🔕 OFF"}
            </button>
            <button onClick={handleScanNow} disabled={scanning} style={{
              padding:"5px 14px", borderRadius:6, border:"none",
              cursor: scanning?"not-allowed":"pointer",
              background: scanning?"#1e293b":"linear-gradient(135deg,#00d4ff,#7b2fff)",
              color: scanning?"#4a5568":"#fff", fontSize:10, fontFamily:"inherit", fontWeight:700 }}>
              {scanning ? `SCANNING ${progress}%` : "▶ SCAN NOW"}
            </button>
          </div>
        </div>
        <div style={{ marginTop:8, display:"flex", gap:16, flexWrap:"wrap" }}>
          <span style={{ fontSize:9, color:"#374151" }}>
            🕐 LAST: {lastScan ? toPHT(lastScan) : "—"}
          </span>
          {nextScan && !scanning && (
            <span style={{ fontSize:9, color:"#00d4ff60" }}>
              ⏱ NEXT AUTO: {toPHT(nextScan)}
            </span>
          )}
        </div>
        {scanning && (
          <div style={{ marginTop:8, height:2, background:"#1e293b", borderRadius:2 }}>
            <div style={{ height:"100%", borderRadius:2,
              background:"linear-gradient(90deg,#00d4ff,#7b2fff)",
              width:`${progress}%`, transition:"width 0.15s" }} />
          </div>
        )}
      </div>

      {/* STATS */}
      <div style={{ display:"flex", background:"#0d1117", borderBottom:"1px solid #1e293b" }}>
        {[
          { label:"SETUPS", value:results.length, color:"#00d4ff" },
          { label:"BULLISH", value:results.filter(r=>r.bias==="bullish").length, color:"#22c55e" },
          { label:"BEARISH", value:results.filter(r=>r.bias==="bearish").length, color:"#ef4444" },
          { label:"SCANNED", value:`${Math.round(progress/100*COINS.length)}/${COINS.length}`, color:"#94a3b8" },
        ].map(s => (
          <div key={s.label} style={{ flex:1, padding:"10px 8px", textAlign:"center", borderRight:"1px solid #1e293b" }}>
            <div style={{ fontSize:20, fontWeight:800, color:s.color }}>{s.value}</div>
            <div style={{ fontSize:8, color:"#374151" }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* FILTER */}
      <div style={{ padding:"10px 16px", display:"flex", gap:6,
        background:"#0d1117", borderBottom:"1px solid #1e293b" }}>
        {["ALL","BULLISH","BEARISH"].map(f => (
          <button key={f} onClick={() => setFilter(f)} style={{
            padding:"5px 12px", borderRadius:6, border:"none", cursor:"pointer",
            background: filter===f ? (f==="BULLISH"?"#22c55e22":f==="BEARISH"?"#ef444422":"#00d4ff22") : "#111827",
            color: filter===f ? (f==="BULLISH"?"#22c55e":f==="BEARISH"?"#ef4444":"#00d4ff") : "#4a5568",
            fontSize:10, fontFamily:"inherit" }}>{f}</button>
        ))}
      </div>

      {/* RESULTS */}
      <div style={{ padding:16 }}>
        {scanning && results.length === 0 && (
          <div style={{ textAlign:"center", padding:"60px 20px", color:"#374151" }}>
            <div style={{ fontSize:32, marginBottom:12 }}>⊛</div>
            <div style={{ fontSize:12 }}>Scanning futures market...</div>
          </div>
        )}
        {!scanning && filtered.length === 0 && (
          <div style={{ textAlign:"center", padding:"60px 20px", color:"#374151" }}>
            <div style={{ fontSize:32, marginBottom:12 }}>◎</div>
            <div style={{ fontSize:12 }}>No valid setups found.</div>
            <div style={{ fontSize:10, marginTop:6, color:"#1e293b" }}>
              Next auto scan: {nextScan ? toPHT(nextScan) : "—"}
            </div>
          </div>
        )}
        {filtered.map(r => <SetupCard key={r.coin} result={r} />)}
      </div>

      {/* FOOTER */}
      <div style={{ padding:"14px 20px", borderTop:"1px solid #1e293b",
        fontSize:10, color:"#374151", display:"flex", gap:16, flexWrap:"wrap" }}>
        <span style={{ color:"#22c55e" }}>RGR = Bullish</span>
        <span style={{ color:"#ef4444" }}>GRG = Bearish</span>
        <span>● = Price in FVG zone</span>
        <span style={{ color:"#f59e0b" }}>🔔 = Browser + Telegram alert</span>
        <span>Auto scan every 15M PHT</span>
      </div>
    </div>
  );
}
