const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const GROQ_KEY = process.env.GROQ_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const TW_NAMES = {
  '0050':'元大台灣50','0056':'元大高股息','00878':'國泰永續高股息',
  '00881':'國泰台灣ESG永續','00919':'群益台灣精選高息','00929':'復華台灣科技優息',
  '00940':'元大台灣價值高息','00631L':'元大台灣50正2','00632R':'元大台灣50反1',
  '1101':'台泥','1216':'統一','1301':'台塑','1303':'南亞','1326':'台化',
  '2002':'中鋼','2207':'和泰車','2303':'聯電','2308':'台達電','2317':'鴻海',
  '2327':'國巨','2330':'台積電','2357':'華碩','2376':'技嘉','2377':'微星',
  '2379':'瑞昱','2382':'廣達','2395':'研華','2408':'南亞科','2409':'友達',
  '2412':'中華電','2454':'聯發科','2474':'可成','2603':'長榮','2609':'陽明',
  '2610':'華航','2615':'萬海','2618':'長榮航','2881':'富邦金','2882':'國泰金',
  '2883':'開發金','2884':'玉山金','2885':'元大金','2886':'兆豐金','2887':'台新金',
  '2890':'永豐金','2891':'中信金','2892':'第一金','2912':'統一超','3008':'大立光',
  '3034':'聯詠','3045':'台灣大','4904':'遠傳','4938':'和碩','5871':'中租-KY',
  '5880':'合庫金','6505':'台塑化','6669':'緯穎','6770':'力積電','8299':'群聯'
};

let twseNameCache = {};
let twseNameCacheTime = 0;
async function getTwseName(code) {
  const oneDay = 24 * 60 * 60 * 1000;
  if (Date.now() - twseNameCacheTime > oneDay) {
    try {
      const r = await axios.get('https://openapi.twse.com.tw/v1/opendata/t187ap03_L', { timeout: 8000 });
      const map = {};
      for (const item of r.data) {
        if (item['公司代號']) map[item['公司代號']] = item['公司簡稱'] || item['公司名稱'];
      }
      twseNameCache = map;
      twseNameCacheTime = Date.now();
    } catch (e) { console.log('TWSE name fetch error:', e.message); }
  }
  return twseNameCache[code] || '';
}

const SB = axios.create({
  baseURL: SUPABASE_URL + '/rest/v1',
  headers: {
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json',
    'Prefer': 'return=minimal'
  }
});

async function getWatchlist(userId) {
  try {
    const r = await SB.get('/watchlist?user_id=eq.' + userId + '&select=stock_code&order=created_at.asc');
    return r.data.map(row => row.stock_code);
  } catch (e) { return []; }
}
let watchlistHasShares = true; // 資料表若還沒有 shares 欄位，自動退回舊查詢
async function getWatchlistFull(userId) {
  try {
    const r = await SB.get('/watchlist?user_id=eq.' + userId + '&select=' + (watchlistHasShares ? 'stock_code,cost_price,shares' : 'stock_code,cost_price') + '&order=created_at.asc');
    return r.data;
  } catch (e) {
    if (watchlistHasShares) { watchlistHasShares = false; console.log('watchlist 沒有 shares 欄位，改用舊查詢（請在 Supabase 新增 shares 欄位）'); return getWatchlistFull(userId); }
    return [];
  }
}
async function addToWatchlist(userId, code, costPrice, shares) {
  try {
    const existing = await getWatchlist(userId);
    if (existing.includes(code)) return 'exists';
    if (existing.length >= 10) return 'full';
    const body = { user_id: userId, stock_code: code };
    if (costPrice) body.cost_price = costPrice;
    if (shares && watchlistHasShares) body.shares = shares;
    try { await SB.post('/watchlist', body); }
    catch (e) {
      if (body.shares) { delete body.shares; await SB.post('/watchlist', body); watchlistHasShares = false; return 'ok_noshares'; }
      throw e;
    }
    return 'ok';
  } catch (e) { return 'error'; }
}
async function updateWatchlistItem(userId, code, costPrice, shares) {
  try {
    const body = { cost_price: costPrice || null };
    if (watchlistHasShares) body.shares = shares || null;
    await SB.patch('/watchlist?user_id=eq.' + userId + '&stock_code=eq.' + code, body);
    return watchlistHasShares ? 'ok' : 'ok_noshares';
  } catch (e) {
    console.log('updateWatchlistItem 失敗:', e.response ? JSON.stringify(e.response.data) : e.message);
    return 'error';
  }
}
async function removeFromWatchlist(userId, code) {
  try {
    await SB.delete('/watchlist?user_id=eq.' + userId + '&stock_code=eq.' + code);
    try { await SB.delete('/alerts?user_id=eq.' + userId + '&stock_code=eq.' + code); } catch (e) {} // 連帶刪掉該股警示
    return 'ok';
  } catch (e) { return 'error'; }
}
async function getAllUsers() {
  try {
    const r = await SB.get('/watchlist?select=user_id&order=user_id');
    return [...new Set(r.data.map(row => row.user_id))];
  } catch (e) { return []; }
}
async function addAlert(userId, code, type, price) {
  try {
    const r = await SB.post('/alerts', { user_id: userId, stock_code: code, alert_type: type, target_price: price, triggered: false });
    console.log('addAlert ok:', code, type, price);
    return 'ok';
  } catch (e) {
    console.log('addAlert error:', e.response ? JSON.stringify(e.response.data) : e.message);
    return 'error';
  }
}
async function getAlerts(userId) {
  try {
    const r = await SB.get('/alerts?user_id=eq.' + userId + '&triggered=eq.false&select=*&order=created_at.asc');
    return r.data;
  } catch (e) { return []; }
}
async function deleteAlert(id) {
  try { await SB.delete('/alerts?id=eq.' + id); return 'ok'; } catch (e) { return 'error'; }
}
async function getAllActiveAlerts() {
  try {
    const r = await SB.get('/alerts?triggered=eq.false&select=*');
    return r.data;
  } catch (e) { return []; }
}
async function markAlertTriggered(id) {
  const h = { headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json' } };
  const url = SUPABASE_URL + '/rest/v1/alerts?id=eq.' + id;
  try { await axios.patch(url, { triggered: true, triggered_at: new Date().toISOString() }, h); return; } catch (e) {}
  try { await axios.patch(url, { triggered: true }, h); } catch (e) {} // 沒有 triggered_at 欄位時退回
}
async function getFiredAlerts(userId) {
  try {
    const r = await SB.get('/alerts?user_id=eq.' + userId + '&triggered=eq.true&select=*&order=created_at.desc&limit=30');
    return r.data;
  } catch (e) { return []; }
}

async function insertRecommendation(userId, code, name, signalType, score, priceAtSignal) {
  try {
    await SB.post('/recommendations', { user_id: userId, stock_code: code, stock_name: name, signal_type: signalType, score, price_at_signal: priceAtSignal });
  } catch (e) { console.log('insertRecommendation error:', e.response ? JSON.stringify(e.response.data) : e.message); }
}
async function hasRecommendationToday(userId, code, signalType) {
  try {
    const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' })).toISOString().slice(0, 10);
    const r = await SB.get('/recommendations?user_id=eq.' + userId + '&stock_code=eq.' + code + '&signal_type=eq.' + signalType + '&created_at=gte.' + today + '&select=id');
    return r.data.length > 0;
  } catch (e) { return false; }
}
async function getPendingRecommendations() {
  try {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const r = await SB.get('/recommendations?checked=eq.false&created_at=lte.' + cutoff + '&select=*');
    return r.data;
  } catch (e) { return []; }
}
async function updateRecommendationResult(id, resultPrice, resultPct, isCorrect) {
  try {
    await axios.patch(SUPABASE_URL + '/rest/v1/recommendations?id=eq.' + id,
      { result_price: resultPrice, result_pct: resultPct, is_correct: isCorrect, checked: true },
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json' } }
    );
  } catch (e) {}
}
async function getRecommendationStats(userId) {
  try {
    const r = await SB.get('/recommendations?user_id=eq.' + userId + '&checked=eq.true&select=*&order=created_at.desc&limit=50');
    return r.data;
  } catch (e) { return []; }
}
async function checkPendingRecommendations() {
  const pending = await getPendingRecommendations();
  for (const rec of pending) {
    try {
      const yahooSymbol = /^\d{4,6}[A-Z]{0,2}$/.test(rec.stock_code) ? rec.stock_code + '.TW' : rec.stock_code;
      const data = await getYahooData(yahooSymbol);
      if (!data) continue;
      const resultPct = ((data.price - rec.price_at_signal) / rec.price_at_signal * 100);
      const isCorrect = rec.signal_type === 'buy' ? resultPct > 0 : resultPct < 0;
      await updateRecommendationResult(rec.id, data.price, resultPct, isCorrect);
    } catch (e) {}
  }
}

async function push(userId, messages) {
  try {
    await axios.post('https://api.line.me/v2/bot/message/push',
      { to: userId, messages },
      { headers: { Authorization: 'Bearer ' + LINE_TOKEN, 'Content-Type': 'application/json' } }
    );
  } catch (e) { console.log('push error:', e.response ? JSON.stringify(e.response.data) : e.message); }
}
async function pushText(userId, text) { await push(userId, [{ type: 'text', text }]); }

async function reply(replyToken, messages) {
  try {
    await axios.post('https://api.line.me/v2/bot/message/reply',
      { replyToken, messages },
      { headers: { Authorization: 'Bearer ' + LINE_TOKEN, 'Content-Type': 'application/json' } }
    );
    return true;
  } catch (e) { console.log('reply error:', e.response ? JSON.stringify(e.response.data) : e.message); return false; }
}
async function replyOrPush(replyToken, userId, messages) {
  const ok = await reply(replyToken, messages);
  if (!ok) await push(userId, messages);
}
async function replyTextOrPush(replyToken, userId, text) { await replyOrPush(replyToken, userId, [{ type: 'text', text }]); }

async function yahooFetchWithRetry(url, timeout) {
  const retries = 2;
  for (let i = 0; i <= retries; i++) {
    try {
      return await axios.get(url, { timeout: timeout || 10000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    } catch (e) {
      const status = e.response ? e.response.status : null;
      if (status === 429 && i < retries) { await new Promise(r => setTimeout(r, 3000 * (i + 1))); continue; }
      throw e;
    }
  }
}

async function getYahooData(symbol) {
  try {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + symbol + '?interval=1d&range=6mo';
    const r = await yahooFetchWithRetry(url, 10000);
    const result = r.data.chart.result[0];
    const meta = result.meta;
    const yahooName = meta.longName || meta.shortName || '';
    const quotes = result.indicators.quote[0];
    const closes = quotes.close;
    const volumes = quotes.volume;
    const timestamps = result.timestamp;
    const price = meta.regularMarketPrice;
    const closesClean = closes.filter(c => c !== null);
    const prev = closesClean.length >= 2 ? closesClean[closesClean.length - 2] : meta.regularMarketPreviousClose;
    const change = price - prev;
    const labels = timestamps.map(ts => { const d = new Date(ts * 1000); return (d.getMonth() + 1) + '/' + d.getDate(); });
    return {
      price, change, changePct: (change / prev * 100).toFixed(2),
      volume: meta.regularMarketVolume, high52: meta.fiftyTwoWeekHigh, low52: meta.fiftyTwoWeekLow,
      dayHigh: meta.regularMarketDayHigh, dayLow: meta.regularMarketDayLow, currency: meta.currency,
      name: yahooName,
      labels, closes: closes.map(c => c ? parseFloat(c.toFixed(2)) : null), volumes: volumes.map(v => v || 0)
    };
  } catch (e) {
    if (symbol.endsWith('.TW')) { try { return await getYahooData(symbol.replace('.TW', '.TWO')); } catch (e2) {} }
    console.log('getYahooData \u5931\u6557 ' + symbol + ':', e.response ? e.response.status : e.message);
    return null;
  }
}

async function getSimplePrice(code) {
  const symbol = /^\d/.test(code) ? code + '.TW' : code;
  try {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + symbol + '?interval=1d&range=1d';
    const r = await yahooFetchWithRetry(url, 8000);
    return r.data.chart.result[0].meta.regularMarketPrice;
  } catch (e) {
    if (symbol.endsWith('.TW')) {
      try {
        const url2 = 'https://query1.finance.yahoo.com/v8/finance/chart/' + symbol.replace('.TW', '.TWO') + '?interval=1d&range=1d';
        const r2 = await yahooFetchWithRetry(url2, 8000);
        return r2.data.chart.result[0].meta.regularMarketPrice;
      } catch (e2) { return null; }
    }
    return null;
  }
}

function calcMA(closes, period) {
  return closes.map((_, i) => {
    if (i < period - 1) return null;
    const slice = closes.slice(i - period + 1, i + 1).filter(c => c !== null);
    if (slice.length < period) return null;
    return parseFloat((slice.reduce((a, b) => a + b, 0) / period).toFixed(2));
  });
}
function calcRSI(closes, period) {
  period = period || 14;
  const clean = closes.filter(c => c !== null);
  if (clean.length < period + 1) return null;
  const slice = clean.slice(-(period + 1));
  let gains = 0, losses = 0;
  for (let i = 1; i < slice.length; i++) { const diff = slice[i] - slice[i - 1]; if (diff > 0) gains += diff; else losses += Math.abs(diff); }
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return parseFloat((100 - (100 / (1 + (gains / period) / avgLoss))).toFixed(1));
}
function calcEMA(closes, period) {
  const clean = closes.filter(c => c !== null);
  if (clean.length < period) return null;
  const k = 2 / (period + 1);
  let ema = clean.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < clean.length; i++) ema = clean[i] * k + ema * (1 - k);
  return parseFloat(ema.toFixed(2));
}
function calcMACD(closes) {
  const ema12 = calcEMA(closes, 12); const ema26 = calcEMA(closes, 26);
  if (!ema12 || !ema26) return null;
  return parseFloat((ema12 - ema26).toFixed(3));
}
function calcBollinger(closes, period) {
  period = period || 20;
  const clean = closes.filter(c => c !== null);
  if (clean.length < period) return null;
  const slice = clean.slice(-period);
  const ma = slice.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(slice.reduce((a, b) => a + Math.pow(b - ma, 2), 0) / period);
  return { upper: parseFloat((ma + 2 * std).toFixed(2)), middle: parseFloat(ma.toFixed(2)), lower: parseFloat((ma - 2 * std).toFixed(2)) };
}

async function getChartUrl(title, labels, closes, ma5arr, ma20arr, ma60arr) {
  try {
    const n = 30; const sl = arr => arr.slice(-n);
    const config = {
      type: 'line',
      data: { labels: sl(labels), datasets: [
        { label: '\u6536\u76E4\u50F9', data: sl(closes), borderColor: '#2196F3', backgroundColor: 'rgba(33,150,243,0.08)', borderWidth: 2, pointRadius: 2, fill: true, tension: 0.1 },
        { label: 'MA5', data: sl(ma5arr), borderColor: '#FF9800', borderWidth: 1.5, pointRadius: 0, fill: false, tension: 0.1 },
        { label: 'MA20', data: sl(ma20arr), borderColor: '#E91E63', borderWidth: 1.5, pointRadius: 0, fill: false, tension: 0.1 },
        { label: 'MA60', data: sl(ma60arr), borderColor: '#9C27B0', borderWidth: 1.5, pointRadius: 0, fill: false, tension: 0.1 }
      ]},
      options: { title: { display: true, text: title + ' \u8FD130\u65E5\u8D70\u52E2', fontSize: 16 }, legend: { position: 'top' },
        scales: { yAxes: [{ ticks: { beginAtZero: false } }], xAxes: [{ ticks: { maxTicksLimit: 10 } }] } }
    };
    const qcRes = await axios.post('https://quickchart.io/chart/create', { chart: config, width: 600, height: 400, backgroundColor: 'white', format: 'png' }, { timeout: 10000 });
    return qcRes.data && qcRes.data.url ? qcRes.data.url : null;
  } catch (e) { return null; }
}

// 證交所 T86（三大法人買賣超日報，全市場一張表，單位：股）。欄位：4=外陸資買賣超(不含外資自營) 7=外資自營商買賣超 10=投信買賣超 11=自營商買賣超 18=三大法人合計
const t86Cache = new Map(); // 日期(YYYYMMDD) -> 該日全表（歷史日期不會變，快取到重啟）
const t86Num = x => parseInt(String(x || '0').replace(/,/g, '')) || 0;
async function getT86(dateStr) { // dateStr 省略＝最新一日；回傳 { date, rows } 或 null
  const key = dateStr || 'latest';
  if (dateStr && t86Cache.has(dateStr)) return t86Cache.get(dateStr);
  if (!dateStr && t86Cache.has('latest') && Date.now() - t86Cache.get('latest').at < 30 * 60 * 1000) return t86Cache.get('latest').v;
  try {
    const url = 'https://www.twse.com.tw/rwd/zh/fund/T86?response=json&selectType=ALLBUT0999' + (dateStr ? '&date=' + dateStr : '');
    const r = await axios.get(url, { timeout: 12000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const ok = r.data && r.data.stat === 'OK' && Array.isArray(r.data.data) && r.data.data.length > 0;
    const v = ok ? { date: String(r.data.date || dateStr || ''), rows: r.data.data } : null;
    if (dateStr) { if (v || dateStr < new Date(Date.now() + 8 * 3600000 - 2 * 86400000).toISOString().slice(0, 10).replace(/-/g, '')) t86Cache.set(dateStr, v); }
    else if (v) t86Cache.set('latest', { at: Date.now(), v });
    return v;
  } catch (e) { return null; }
}
async function getTWChipData(code) {
  try {
    const t = await getT86();
    if (!t) return null;
    const row = t.rows.find(item => String(item[0]).trim() === code);
    if (!row) return null;
    return { foreign: t86Num(row[4]) + t86Num(row[7]), invest: t86Num(row[10]), dealer: t86Num(row[11]), total: t86Num(row[18]) };
  } catch (e) { return null; }
}

// 連買／連賣天數：逐日抓 T86（往回最多 10 個交易日），淨買超 >0 算買、<0 算賣、=0 中斷
async function getTWChipHistory(code) {
  try {
    const days = [];
    const base = new Date(Date.now() + 8 * 3600000);
    for (let back = 0; back < 20 && days.length < 10; back++) {
      const d = new Date(base.getTime() - back * 86400000);
      const dow = d.getUTCDay(); if (dow === 0 || dow === 6) continue;
      const ds = d.toISOString().slice(0, 10).replace(/-/g, '');
      const t = await getT86(ds);
      if (!t) continue; // 假日或今天尚未公布
      const row = t.rows.find(item => String(item[0]).trim() === code);
      days.push({ foreign: row ? t86Num(row[4]) + t86Num(row[7]) : 0, invest: row ? t86Num(row[10]) : 0 });
      await new Promise(r => setTimeout(r, 250));
    }
    if (!days.length) return null;
    const streakOf = key => {
      let n = 0;
      for (const d of days) {
        const v = d[key]; const sg = v > 0 ? 1 : v < 0 ? -1 : 0;
        if (sg === 0) break;
        if (n === 0) n = sg; else if ((n > 0) === (sg > 0)) n += sg; else break;
      }
      return n;
    };
    return { foreignStreak: streakOf('foreign'), investStreak: streakOf('invest') };
  } catch (e) { return null; }
}

async function getTopInstitutionalStocks(n) {
  try {
    const url = 'https://www.twse.com.tw/rwd/zh/fund/T86?response=json&selectType=ALLBUT0999';
    const r = await axios.get(url, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.data || !r.data.data) return [];
    const parseNum = s => parseInt((s || '0').replace(/,/g, '')) || 0;
    const rows = r.data.data.map(row => ({ code: row[0], name: row[1], foreign: parseNum(row[4]) + parseNum(row[7]), invest: parseNum(row[10]) }));
    const topForeign = [...rows].sort((a, b) => b.foreign - a.foreign).slice(0, n);
    const topInvest = [...rows].sort((a, b) => b.invest - a.invest).slice(0, n);
    const merged = {};
    for (const s of topForeign) merged[s.code] = s;
    for (const s of topInvest) merged[s.code] = s;
    return Object.values(merged);
  } catch (e) { console.log('getTopInstitutionalStocks error:', e.response ? e.response.status : e.message); return []; }
}

function formatChip(chip, history) {
  if (!chip) return null;
  const fmt = n0 => { const n = Math.round(n0 / 1000); const sign = n >= 0 ? '+' : ''; return sign + n.toLocaleString() + ' \u5F35 ' + (n >= 0 ? '\u25B2' : '\u25BC'); };
  const streak = (n) => {
    if (!history || n === 0) return '';
    const days = Math.abs(n); const dir = n > 0 ? '\u9023\u8CB7' : '\u9023\u8CE3';
    return '  \u300E' + dir + days + '\u5929\u300F';
  };
  return '\u{1F3E6} \u7C4C\u78BC\u9762\uFF08\u4E09\u5927\u6CD5\u4EBA\uFF09\n\u5916\u8CC7\uFF1A' + fmt(chip.foreign) + streak(history ? history.foreignStreak : 0) + '\n\u6295\u4FE1\uFF1A' + fmt(chip.invest) + streak(history ? history.investStreak : 0) + '\n\u81EA\u71DF\uFF1A' + fmt(chip.dealer) + '\n\u5408\u8A08\uFF1A' + fmt(chip.total);
}

function classifyChipVolume(chip, history, volRatio, changePct) {
  if (!chip || !history) return null;
  const vr = parseFloat(volRatio); const pct = parseFloat(changePct);
  const fStreak = history.foreignStreak || 0; const iStreak = history.investStreak || 0;
  const buyDays = Math.max(fStreak > 0 ? fStreak : 0, iStreak > 0 ? iStreak : 0);
  const sellDays = Math.max(fStreak < 0 ? Math.abs(fStreak) : 0, iStreak < 0 ? Math.abs(iStreak) : 0);
  const volHigh = vr >= 1.5; const volLow = vr <= 0.7;
  const priceUp = pct > 0; const priceDown = pct < 0;
  const diverge = (fStreak > 0 && iStreak < 0) || (fStreak < 0 && iStreak > 0);
  if (diverge) return { cat: 'diverge', signal: '\u2696\uFE0F \u5206\u6B67\uFF08\u5916\u8CC7\u6295\u4FE1\u65B9\u5411\u4E0D\u4E00\uFF09', note: '\u8A0A\u865F\u6253\u6298\uFF0C\u5EFA\u8B70\u89C0\u671B' };
  if (buyDays > 0 && volHigh && priceUp) return { cat: 'strongBuy', signal: '\u{1F7E2} \u5075\u591A\u8A0A\u865F\u5F37', note: '\u6CD5\u4EBA\u9023\u8CB7 ' + buyDays + ' \u5929 + \u91CF\u5897(' + vr + '\u500D) + \u50F9\u6F32\uFF0C\u7C4C\u78BC\u91CF\u80FD\u5171\u632F\uFF0C\u52D5\u80FD\u53EF\u671F' };
  if (buyDays > 0 && volLow) return { cat: 'weakBuy', signal: '\u{1F7E1} \u5047\u8A0A\u865F\u504F\u591A', note: '\u6CD5\u4EBA\u9023\u8CB7 ' + buyDays + ' \u5929\u4F46\u91CF\u7E2E(' + vr + '\u500D)\uFF0C\u5E02\u5834\u4E0D\u71B1\uFF0C\u8B39\u9632\u9AD8\u6392\u5F0F\u5047\u96C6\u5DA5' };
  if (sellDays > 0 && volHigh && priceDown) return { cat: 'strongSell', signal: '\u{1F534} \u5075\u7A7A\u8A0A\u865F\u5F37', note: '\u6CD5\u4EBA\u9023\u8CE3 ' + sellDays + ' \u5929 + \u91CF\u5897(' + vr + '\u500D) + \u50F9\u8DCC\uFF0C\u5075\u51FA\u8CA8\u8A0A\u865F\u660E\u986F' };
  if (sellDays > 0 && volLow) return { cat: 'weakSell', signal: '\u{1F7E0} \u5047\u8A0A\u865F\u504F\u7A7A', note: '\u6CD5\u4EBA\u9023\u8CE3 ' + sellDays + ' \u5929\u4F46\u91CF\u7E2E(' + vr + '\u500D)\uFF0C\u5238\u5F35\u907F\u96AA\u610F\u5473\u6FC3\uFF0C\u53CD\u5F48\u6A5F\u6703\u5B58\u5728' };
  if ((priceUp && volLow) || (priceDown && volHigh && buyDays === 0 && sellDays === 0)) return { cat: 'divergePV', signal: '\u26A0\uFE0F \u91CF\u50F9\u80CC\u96E2', note: priceUp ? '\u50F9\u6F32\u4F46\u91CF\u7E2E\uFF0C\u4E0A\u6F32\u52D5\u80FD\u4E0D\u8DB3' : '\u91CF\u5897\u4F46\u7121\u660E\u986F\u6CD5\u4EBA\u65B9\u5411\uFF0C\u89C0\u5BDF\u662F\u5426\u8F49\u5F37' };
  return { cat: 'neutral', signal: '\u26AA \u7121\u660E\u986F\u5171\u632F', note: '\u6CD5\u4EBA\u65B9\u5411\u8207\u91CF\u80FD\u672A\u5F62\u6210\u6C7A\u5B9A\u6027\u8A0A\u865F' };
}

function formatChipVolumeSignal(chipCat) {
  if (!chipCat) return null;
  return '\u{1F4CA} \u7C4C\u78BC\u91CF\u80FD\u7D9C\u5408\u5224\u65B7\n' + chipCat.signal + '\n' + chipCat.note;
}

// 評分 v2（2026-11 依 5 年 × 30 檔歷史檢驗改版：前後兩半都贏過「全體」的條件才留下）
// 超賣 RSI<30 +2；乖離月線 ≥10% +2、5~10% +1（動能）；大盤在 60MA 之上 +1／之下 -1。
// MACD、均線排列、成交量檢驗後沒有預測力，已移除。籌碼無法回測，只留 ±0.5 微調。
function calcBuyScore(price, ma5, ma20, ma60, rsi, macd, chipCat, mktUp) {
  return features.scoreV2(price, ma20, rsi, mktUp, chipCat); // 單一來源在 features.js
}


function calcSupportResistance(price, ma5, ma20, ma60, boll, high52, low52) {
  const resistances = []; const supports = [];
  if (high52 && high52 > price) resistances.push({ price: high52, label: '52\u9031\u9AD8' });
  if (boll && boll.upper > price) resistances.push({ price: boll.upper, label: '\u5E03\u6797\u4E0A\u8ECC' });
  if (ma5 && ma5 > price) resistances.push({ price: ma5, label: 'MA5' });
  if (ma20 && ma20 > price) resistances.push({ price: ma20, label: 'MA20' });
  if (ma60 && ma60 > price) resistances.push({ price: ma60, label: 'MA60' });
  if (ma5 && ma5 < price) supports.push({ price: ma5, label: 'MA5' });
  if (ma20 && ma20 < price) supports.push({ price: ma20, label: 'MA20' });
  if (ma60 && ma60 < price) supports.push({ price: ma60, label: 'MA60' });
  if (boll && boll.middle < price) supports.push({ price: boll.middle, label: '\u5E03\u6797\u4E2D\u8ECC' });
  if (boll && boll.lower < price) supports.push({ price: boll.lower, label: '\u5E03\u6797\u4E0B\u8ECC' });
  if (low52 && low52 < price) supports.push({ price: low52, label: '52\u9031\u4F4E' });
  resistances.sort((a, b) => a.price - b.price); supports.sort((a, b) => b.price - a.price);
  let result = '\u{1F3AF} \u652F\u6490\u58D3\u529B\n';
  resistances.slice(0, 2).reverse().forEach(r => { result += '\u{1F534} \u58D3\u529B ' + r.price.toFixed(2) + ' \uFF08' + r.label + '\uFF09\n'; });
  result += '\u25B6 \u73FE\u50F9 ' + price.toFixed(2) + '\n';
  supports.slice(0, 2).forEach(s => { result += '\u{1F7E2} \u652F\u6490 ' + s.price.toFixed(2) + ' \uFF08' + s.label + '\uFF09\n'; });
  if (resistances.length > 0 && supports.length > 0) {
    result += '\n\u{1F4CC} \u8DDD\u58D3\u529B +' + ((resistances[0].price - price) / price * 100).toFixed(1) + '%  \u8DDD\u652F\u6490 -' + ((price - supports[0].price) / price * 100).toFixed(1) + '%';
  }
  return result;
}

async function askGroq(techData) {
  try {
  const r = await axios.post('https://api.groq.com/openai/v1/chat/completions',
    { model: 'openai/gpt-oss-120b', max_tokens: 500, messages: [
      { role: 'system', content: '\u4F60\u662F\u89AA\u5207\u7684\u80A1\u7968\u8001\u5E2B\uFF0C\u7528\u53E3\u8A9E\u7E41\u9AD4\u4E2D\u6587\u89E3\u8AAA\uFF0C\u8B93\u521D\u5B78\u8005\u4E5F\u80FD\u61C2\u3002' },
      { role: 'user', content: '\u4F60\u662F\u80A1\u7968\u8001\u5E2B\uFF0C\u8ACB\u7528\u53E3\u8A9E\u5316\u7E41\u9AD4\u4E2D\u6587\u89E3\u91CB\u4EE5\u4E0B\u6307\u6A19\uFF0C180\u5B57\u5167\u3002\n\n' + techData + '\n\n\u8ACB\u4F9D\u683C\u5F0F\uFF1A\n\u{1F4B9} \u4ECA\u65E5\u8D70\u52E2\n\u{1F4CA} \u5747\u7DDA\u6392\u5217\n\u{1F525} RSI\u5F37\u5F31\n\u{1F4C9} MACD\u52D5\u80FD\n\u{1F3AF} \u5E03\u6797\u4F4D\u7F6E\n\u{1F9E0} \u7D9C\u5408\u5224\u65B7\uFF08\u504F\u591A/\u504F\u7A7A/\u4E2D\u6027+\u7406\u7531\uFF09' }
    ]},
    { headers: { Authorization: 'Bearer ' + GROQ_KEY, 'Content-Type': 'application/json' }, timeout: 25000 }
  );
  return r.data.choices[0].message.content;
  } catch (e) {
    console.log('askGroq 失敗:', e.response ? JSON.stringify(e.response.data) : e.message);
    return '⚠️ AI解說暫時無法使用（Groq 金鑰失效或額度問題），下方指標與評分不受影響。';
  }
}

async function analyzeStock(code) {
  const clean = code.toUpperCase();
  let yahooSymbol, market, stockName = '';
  if (/^\d{4,6}[A-Z]{0,2}$/.test(clean)) { yahooSymbol = clean + '.TW'; market = '\u53F0\u80A1'; stockName = TW_NAMES[clean] || ''; }
  else if (/^[A-Z]{1,5}$/.test(clean)) { yahooSymbol = clean; market = '\u7F8E\u80A1'; }
  else return null;
  const data = await getYahooData(yahooSymbol);
  if (!data) return null;
  if (!stockName && market === '\u53F0\u80A1') stockName = await getTwseName(clean);
  if (!stockName && data.name) stockName = data.name;
  const closes = data.closes;
  const ma5arr = calcMA(closes, 5); const ma20arr = calcMA(closes, 20); const ma60arr = calcMA(closes, 60);
  const ma5 = ma5arr[ma5arr.length - 1]; const ma20 = ma20arr[ma20arr.length - 1]; const ma60 = ma60arr[ma60arr.length - 1];
  const rsi = calcRSI(closes, 14); const macd = calcMACD(closes); const boll = calcBollinger(closes, 20);
  const volAvg5 = data.volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const volRatio = (data.volume / volAvg5).toFixed(1);
  const arrow = data.change >= 0 ? '\u25B2' : '\u25BC';
  const sign = data.change >= 0 ? '+' : '';
  const title = clean + (stockName ? ' ' + stockName : '');
  let techData = '\u80A1\u7968\uFF1A' + title + '\uFF08' + market + '\uFF09\n\u73FE\u50F9\uFF1A' + data.price + ' ' + data.currency + '\n';
  techData += '\u6F32\u8DCC\uFF1A' + arrow + Math.abs(data.change).toFixed(2) + ' (' + sign + data.changePct + '%)\n';
  techData += '\u4ECA\u65E5\u9AD8\u4F4E\uFF1A' + data.dayHigh + ' / ' + data.dayLow + '\n52\u9031\uFF1A' + data.low52 + ' ~ ' + data.high52 + '\n';
  if (ma5) techData += 'MA5\uFF1A' + ma5 + '\n'; if (ma20) techData += 'MA20\uFF1A' + ma20 + '\n'; if (ma60) techData += 'MA60\uFF1A' + ma60 + '\n';
  if (rsi) techData += 'RSI\uFF1A' + rsi + '\uFF08' + (rsi > 70 ? '\u8D85\u8CB7' : rsi < 30 ? '\u8D85\u8CE3' : '\u6B63\u5E38') + '\uFF09\n';
  if (macd) techData += 'MACD\uFF1A' + macd + '\uFF08' + (macd > 0 ? '\u6B63\u503C\u504F\u591A' : '\u8CA0\u503C\u504F\u7A7A') + '\uFF09\n';
  if (boll) { const pos = data.price > boll.upper ? '\u4E0A\u8ECC\u4EE5\u4E0A' : data.price > boll.middle ? '\u4E2D\u4E0A\u8ECC' : data.price > boll.lower ? '\u4E2D\u4E0B\u8ECC' : '\u4E0B\u8ECC\u4EE5\u4E0B'; techData += '\u5E03\u6797\uFF1A\u4E0A' + boll.upper + ' \u4E2D' + boll.middle + ' \u4E0B' + boll.lower + '\uFF08' + pos + '\uFF09\n'; }
  techData += '\u91CF\u6BD4\uFF1A' + volRatio + 'x\uFF08' + (volRatio > 1.5 ? '\u7206\u91CF' : volRatio < 0.5 ? '\u7E2E\u91CF' : '\u6B63\u5E38') + '\uFF09\n';
  const isTW = /^\d/.test(clean);
  const [analysis, chartUrl, chip, history] = await Promise.all([
    askGroq(techData), getChartUrl(title, data.labels, closes, ma5arr, ma20arr, ma60arr),
    isTW ? getTWChipData(clean) : Promise.resolve(null),
    isTW ? getTWChipHistory(clean) : Promise.resolve(null)
  ]);
  const srText = calcSupportResistance(data.price, ma5, ma20, ma60, boll, data.high52, data.low52);
  const chipText = formatChip(chip, history);
  const chipCat = classifyChipVolume(chip, history, volRatio, data.changePct);
  const signalText = formatChipVolumeSignal(chipCat);
  let mktUp = null; try { mktUp = await features.marketUp(); } catch (e) {}
  const buyScore = calcBuyScore(data.price, ma5, ma20, ma60, rsi, macd, chipCat, mktUp);
  const scoreText = '\u{1F3AF} \u7D9C\u5408\u8CB7\u9032\u8A55\u5206\uFF08' + buyScore.score.toFixed(1) + '\u5206\uFF09\n' + buyScore.emoji + ' ' + buyScore.label + (buyScore.reasons.length ? '\uFF08' + buyScore.reasons.join('\u3001') + '\uFF09' : '') + '\n\u{1F4CA} ' + buyScore.position;
  const sep = '\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n';
  let briefText = '';
  try { briefText = await features.brief(clean); } catch (e) { console.log('日週線結論略過 ' + clean + '：' + e.message); }
  const textMsg = '\u{1F4C8} ' + title + ' \u5206\u6790\u5831\u544A' + sep +
    '\u73FE\u50F9\uFF1A' + data.price + ' ' + data.currency + '\t' + arrow + data.changePct + '%\n' +
    '\u4ECA\u65E5\uFF1A' + data.dayHigh + ' / ' + data.dayLow + '\n' +
    '\u6210\u4EA4\u91CF\uFF1A' + Number(data.volume).toLocaleString() + '\uFF08\u91CF\u6BD4 ' + volRatio + 'x\uFF09\n' +
    '52\u9031\uFF1A' + data.low52 + ' ~ ' + data.high52 + sep + analysis + sep + srText +
    (chipText ? sep + chipText : '') + (signalText ? sep + signalText : '') + sep + scoreText + (briefText ? sep + briefText : '');
  return { textMsg, chartUrl, buyScore, code: clean, name: stockName, price: data.price, changePct: data.changePct };
}

function scheduleMorningReport() {
  function getNextTime() {
    const now = new Date(); const tw = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    const next = new Date(tw); next.setHours(8, 30, 0, 0);
    if (tw >= next) next.setDate(next.getDate() + 1);
    while (next.getDay() === 0 || next.getDay() === 6) next.setDate(next.getDate() + 1);
    return next - tw;
  }
  // 簡單的狀態存取（Supabase 表 bot_state；表不存在時退回記憶體，只在這次開機有效）
  const memState = {};
  async function getState(key) {
    try { const r = await SB.get('/bot_state?key=eq.' + key + '&select=value'); return r.data && r.data[0] ? r.data[0].value : null; }
    catch (e) { return memState[key] || null; }
  }
  async function setState(key, value) {
    memState[key] = value;
    try { await SB.post('/bot_state', { key, value }, { headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } }); }
    catch (e) { console.log('bot_state 寫入失敗（請建立 bot_state 表，否則補推可能重複）：', e.response ? JSON.stringify(e.response.data) : e.message); }
  }
  const todayTW = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  async function sendMorningReport(isCatchUp) {
    const tw = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    if (tw.getDay() === 0 || tw.getDay() === 6) { if (!isCatchUp) setTimeout(sendMorningReport, getNextTime()); return; }
    if ((await getState('morning_last')) === todayTW()) {
      console.log('早報：今天已送過，略過' + (isCatchUp ? '（補推檢查）' : ''));
      if (!isCatchUp) setTimeout(sendMorningReport, getNextTime());
      return;
    }
    console.log('早報開始' + (isCatchUp ? '（開機補推）' : '（排程）'));
    await checkPendingRecommendations();
    const topInst = await getTopInstitutionalStocks(10);
    const users = await getAllUsers();
    for (const uid of users) {
      const stocksFull = await getWatchlistFull(uid); if (stocksFull.length === 0) continue;
      const costMap = {}; for (const s of stocksFull) { if (s.cost_price) costMap[s.stock_code] = s.cost_price; }
      const stocks = stocksFull.map(s => s.stock_code);
      const dashBase = (process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || '').replace(/\/$/, '');
      const compact = !!(process.env.DASH_KEY && dashBase) && process.env.MORNING_FULL !== '1'; // 精簡模式：只推1則（省LINE額度），詳細內容看儀表板
      const dashUrl = compact ? dashBase + '/dashboard?k=' + encodeURIComponent(process.env.DASH_KEY) : '';
      const blocks = [], stockLines = [];
      const emit = async (text, kind) => { if (!compact) return pushText(uid, text); if (kind === 'skip') return; blocks.push(text); };
      await emit('\u{1F305} \u65E9\u5B89\uFF01\u81EA\u9078\u80A1\u65E9\u5831\u4F86\u4E86\uFF5E', 'skip');
      const scored = [];
      const holdings = [];
      for (const code of stocks) {
        try {
          const result = await analyzeStock(code); if (!result) continue;
          if (!compact) {
            await pushText(uid, result.textMsg);
            if (result.chartUrl) await push(uid, [{ type: 'image', originalContentUrl: result.chartUrl, previewImageUrl: result.chartUrl }]);
          } else {
            let ln = (result.buyScore ? result.buyScore.emoji : '\u26AA') + ' ' + result.code + (result.name ? ' ' + result.name : '') + ' ' + Number(result.price).toFixed(2).replace(/\.?0+$/, '') + (result.changePct != null ? '\uFF08' + (result.changePct >= 0 ? '+' : '') + result.changePct + '%\uFF09' : '');
            try {
              const dsk = await features.dashStock(code);
              ln += '\n   ' + dsk.verdict + '\uFF5C\u9031\u7DDA' + dsk.wS + '\u3001\u65E5\u7DDA' + dsk.dS + (dsk.plan && dsk.verdict !== '\u8CE3\u51FA' ? '\uFF5C\u505C\u640D ' + dsk.plan.stop + ' \u76EE\u6A19 ' + dsk.plan.t1 : '');
            } catch (e) { if (result.buyScore) ln += '\n   ' + result.buyScore.label; }
            if (costMap[code]) ln += '\n   \u6210\u672C ' + costMap[code] + '\uFF08' + (((result.price - costMap[code]) / costMap[code] * 100) >= 0 ? '+' : '') + ((result.price - costMap[code]) / costMap[code] * 100).toFixed(1) + '%\uFF09';
            stockLines.push(ln);
          }
          if (result.buyScore) {
            scored.push({ code: result.code, name: result.name, score: result.buyScore.score, label: result.buyScore.label, emoji: result.buyScore.emoji, price: result.price });
            if (costMap[code]) {
              const pnlPct = ((result.price - costMap[code]) / costMap[code] * 100);
              holdings.push({ code: result.code, name: result.name, score: result.buyScore.score, label: result.buyScore.label, emoji: result.buyScore.emoji, position: result.buyScore.position, cost: costMap[code], price: result.price, pnlPct });
            }
          }
          await new Promise(r => setTimeout(r, 2000));
        } catch (e) { console.log('\u65E9\u5831\u5206\u6790\u5931\u6557 ' + code + ':', e.response ? JSON.stringify(e.response.data) : e.message); }
      }
      if (holdings.length > 0 && !compact) {
        const list = holdings.map(h => h.emoji + ' ' + h.code + (h.name ? ' ' + h.name : '') + '\n   \u6210\u672C ' + h.cost + ' \u2192 \u73FE\u50F9 ' + h.price + '\uFF08' + (h.pnlPct >= 0 ? '+' : '') + h.pnlPct.toFixed(1) + '%\uFF09\n   ' + h.label + ' | ' + h.position).join('\n\n');
        await emit('\u{1F4CD} \u6301\u80A1\u9AD4\u6AA2\uFF1A\n\n' + list);
      }
      const strong = scored.filter(s => s.score >= 3).sort((a, b) => b.score - a.score);
      const weak = scored.filter(s => s.score <= -3).sort((a, b) => a.score - b.score);
      for (const s of strong) { if (!(await hasRecommendationToday(uid, s.code, 'buy'))) await insertRecommendation(uid, s.code, s.name, 'buy', s.score, s.price); }
      for (const s of weak) { if (!(await hasRecommendationToday(uid, s.code, 'sell'))) await insertRecommendation(uid, s.code, s.name, 'sell', s.score, s.price); }
      if (strong.length > 0) {
        const list = strong.map(s => s.emoji + ' ' + s.code + (s.name ? ' ' + s.name : '') + '\uFF08' + s.score.toFixed(1) + '\u5206\uFF09' + s.label).join('\n');
        await emit('\u{1F3AF} \u4ECA\u65E5\u91CD\u9EDE\u95DC\u6CE8\uFF08\u5F37\u529B\u8CB7\u9032\u8A0A\u865F\uFF09\uFF1A\n\n' + list);
      }
      if (weak.length > 0) {
        const list = weak.map(s => s.emoji + ' ' + s.code + (s.name ? ' ' + s.name : '') + '\uFF08' + s.score.toFixed(1) + '\u5206\uFF09' + s.label).join('\n');
        await emit('\u26A0\uFE0F \u4ECA\u65E5\u5EFA\u8B70\u8CE3\u51FA\uFF1A\n\n' + list);
      }
      if (topInst.length > 0) {
        await emit('\u{1F50D} \u6B63\u5728\u6383\u63CF\u5916\u8CC7/\u6295\u4FE1\u8CB7\u8D85\u524D10\u540D...', 'skip');
        const instScored = [];
        for (const s of topInst) {
          try {
            const result = await analyzeStock(s.code); if (!result || !result.buyScore) continue;
            instScored.push({ code: result.code, name: result.name, score: result.buyScore.score, label: result.buyScore.label, emoji: result.buyScore.emoji, price: result.price });
            await new Promise(r => setTimeout(r, 2000));
          } catch (e) { console.log('\u6CD5\u4EBA\u71B1\u9580\u80A1\u5206\u6790\u5931\u6557 ' + s.code + ':', e.message); }
        }
        const instStrong = instScored.filter(s => s.score >= 3).sort((a, b) => b.score - a.score);
        for (const s of instStrong) { if (!(await hasRecommendationToday(uid, s.code, 'buy'))) await insertRecommendation(uid, s.code, s.name, 'buy', s.score, s.price); }
        if (instStrong.length > 0) {
          const list = instStrong.map(s => s.emoji + ' ' + s.code + (s.name ? ' ' + s.name : '') + '\uFF08' + s.score.toFixed(1) + '\u5206\uFF09' + s.label).join('\n');
          await emit('\u{1F4B0} \u6CD5\u4EBA\u71B1\u9580\u80A1\uFF08\u5916\u8CC7/\u6295\u4FE1\u8CB7\u8D85\u524D10\u540D\u4E2D\u7684\u5F37\u8A0A\u865F\uFF09\uFF1A\n\n' + list);
        } else {
          await emit('\u{1F50D} \u5916\u8CC7/\u6295\u4FE1\u8CB7\u8D85\u524D10\u540D\u4E2D\uFF0C\u4ECA\u65E5\u6C92\u6709\u5F37\u529B\u8CB7\u9032\u8A0A\u865F');
        }
      }
      await emit('\u2705 \u65E9\u5831\u5B8C\u6210\uFF01\u7948\u4EA4\u6613\u9806\u5229 \u{1F4CA}', 'skip');
      if (compact) {
        const d = new Date(Date.now() + 8 * 3600000);
        const head = '\u{1F305} \u65E9\u5B89\uFF01\u81EA\u9078\u80A1\u65E9\u5831 ' + (d.getUTCMonth() + 1) + '/' + d.getUTCDate();
        const body = [head, '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500', stockLines.join('\n')].concat(blocks).filter(Boolean).join('\n\n');
        const link = '\n\n\u{1F4CA} \u5B8C\u6574\u5716\u8868\u8207\u5206\u6790\uFF08\u5100\u8868\u677F\uFF09\n' + dashUrl;
        const room = 4900 - link.length;
        await pushText(uid, (body.length > room ? body.slice(0, room - 8) + '\n\u2026\uFF08\u7565\uFF09' : body) + link);
      }
    }
    await setState('morning_last', todayTW());
    console.log('早報完成');
    if (!isCatchUp) setTimeout(sendMorningReport, getNextTime());
  }
  setTimeout(sendMorningReport, getNextTime());
  console.log('早報排程：下次約 ' + Math.round(getNextTime() / 60000) + ' 分鐘後（台北 08:30）');
  // 開機補推：機器若在 08:30 睡著，醒來時已過 08:30、中午前、今天還沒送過 → 補送一次
  setTimeout(async () => {
    try {
      const t = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
      const mins = t.getHours() * 60 + t.getMinutes();
      if (process.env.MORNING_CATCHUP === '0') return;
      if (t.getDay() >= 1 && t.getDay() <= 5 && mins >= 8 * 60 + 31 && mins <= 12 * 60) await sendMorningReport(true);
    } catch (e) { console.log('補推早報失敗:', e.message); }
  }, 25000);
}
function scheduleAlertCheck() {
  async function checkAlerts() {
    const alerts = await getAllActiveAlerts();
    for (const alert of alerts) {
      try {
        const price = await getSimplePrice(alert.stock_code); if (!price) continue;
        const target = parseFloat(alert.target_price);
        const triggered = alert.alert_type === 'above' ? price >= target : price <= target;
        if (triggered) {
          const name = TW_NAMES[alert.stock_code] || twseNameCache[alert.stock_code] || alert.stock_code;
          const dir = alert.alert_type === 'above' ? '\u7A81\u7834' : '\u8DCC\u7834';
          await pushText(alert.user_id, '\u{1F6A8} \u80A1\u50F9\u8B66\u793A\uFF01\n\n' + alert.stock_code + ' ' + name + '\n\u73FE\u50F9\uFF1A' + price + '\n' + dir + '\u76EE\u6A19\uFF1A' + target);
          await markAlertTriggered(alert.id);
        }
      } catch (e) { console.log('checkAlerts \u5931\u6557 ' + alert.stock_code + ':', e.message); }
    }
  }
  setInterval(checkAlerts, 5 * 60 * 1000);
  checkAlerts();
}

const createFeatures = require('./features');
const features = createFeatures({
  yahooFetchWithRetry, TW_NAMES, getTwseName, getNameCache: () => twseNameCache, GROQ_KEY, LINE_TOKEN,
  getTopInstitutionalStocks, getWatchlist, replyOrPush, push
});

app.post('/webhook', async (req, res) => {
  res.status(200).send('OK');
  const events = req.body && req.body.events ? req.body.events : [];
  for (const e of events) {
    if (e.type !== 'message' || e.message.type !== 'text') continue;
    const uid = e.source.userId; const txt = e.message.text.trim();

    if (['儀表板','dashboard','網頁'].includes(txt.toLowerCase())) {
      const base = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || '';
      if (!process.env.DASH_KEY) await replyTextOrPush(e.replyToken, uid, '儀表板尚未啟用：請到 Render 的 Environment 新增 DASH_KEY（自訂一組密碼）後重新部署。');
      else if (!base) await replyTextOrPush(e.replyToken, uid, '找不到網站網址：請到 Render 的 Environment 新增 PUBLIC_URL（例如 https://你的服務.onrender.com）。');
      else await replyTextOrPush(e.replyToken, uid, '\u{1F4CA} 儀表板（手機版）\n' + base.replace(/\/$/, '') + '/dashboard?k=' + encodeURIComponent(process.env.DASH_KEY) + '\n\n小提醒：連結含你的密碼，請勿轉貼給別人。');
      continue;
    }
    if (['說明','help','?','？'].includes(txt.toLowerCase())) {
      await replyTextOrPush(e.replyToken, uid, '\u{1F916} \u80A1\u7968AI\u6A5F\u5668\u4EBA\n\n\u{1F4CA} \u67E5\u8A62\uFF1A\u8F38\u5165\u4EE3\u78BC\uFF082330\u3001AAPL\uFF09\n\n\u2B50 \u81EA\u9078\u80A1\uFF1A\n+2330 \u52A0\u5165 / +2330 620 \u52A0\u5165\u4E26\u8A18\u9304\u6210\u672C\u50F9\uFF08\u81EA\u52D5\u8A2D\u5B9A\u505C\u5229/\u505C\u640D\uFF09\n-2330 \u79FB\u9664\n\u6211\u7684\u80A1\u7968 \u67E5\u770B\u6E05\u55AE\u8207\u640D\u76CA\n\u65E9\u5831 \u7ACB\u5373\u5206\u6790\u5168\u90E8\n\u8986\u76E4 \u67E5\u770B\u8A0A\u865F\u6E96\u78BA\u5EA6\n\u6CD5\u4EBA\u71B1\u9580 \u5916\u8CC7/\u6295\u4FE1\u8CB7\u8D85\u524D10\u540D\n\n\u{1F6A8} \u8B66\u793A\uFF1A\n2330>2500 \u7A81\u7834\u8B66\u793A\n2330<2400 \u8DCC\u7834\u8B66\u793A\n\u6211\u7684\u8B66\u793A \u67E5\u770B\u6E05\u55AE\n\u5220\u9664\u8B66\u793A 1 \u5220\u9664\u7B2C1\u500B\n\n\u6BCF\u5929 08:30 \u81EA\u52D5\u65E9\u5831' + features.helpAddon);
      continue;
    }

    const alertMatch = txt.match(/^([A-Z0-9]{4,8})\s*([><])\s*([\d.]+)$/i);
    if (alertMatch) {
      const code = alertMatch[1].toUpperCase(); const type = alertMatch[2] === '>' ? 'above' : 'below'; const price = parseFloat(alertMatch[3]);
      const name = TW_NAMES[code] || twseNameCache[code] || code; const dir = type === 'above' ? '\u7A81\u7834' : '\u8DCC\u7834';
      const r = await addAlert(uid, code, type, price);
      if (r === 'ok') await replyTextOrPush(e.replyToken, uid, '\u2705 \u8B66\u793A\u5DF2\u8A2D\u5B9A\uFF01\n' + code + ' ' + name + '\n\u7576\u80A1\u50F9' + dir + ' ' + price + ' \u6642\u81EA\u52D5\u901A\u77E5\u{1F514}');
      else await replyTextOrPush(e.replyToken, uid, '\u274C \u8B66\u793A\u8A2D\u5B9A\u5931\u6557');
      continue;
    }

    if (['\u6211\u7684\u8B66\u793A','\u8B66\u793A\u6E05\u55AE','\u8B66\u793A'].includes(txt)) {
      const alerts = await getAlerts(uid);
      if (alerts.length === 0) { await replyTextOrPush(e.replyToken, uid, '\u76EE\u524D\u6C92\u6709\u8B66\u793A\n\u8F38\u5165\u683C\u5F0F\uFF1A2330>2500 \u6216 2330<2400'); }
      else {
        const list = alerts.map((a, i) => (i + 1) + '. ' + a.stock_code + ' ' + (a.alert_type === 'above' ? '>' : '<') + ' ' + a.target_price).join('\n');
        await replyTextOrPush(e.replyToken, uid, '\u{1F514} \u8B66\u793A\u6E05\u55AE\uFF1A\n\n' + list + '\n\n\u8F38\u5165\u300C\u5220\u9664\u8B66\u793A 1\u300D\u5220\u9664');
      }
      continue;
    }

    const delMatch = txt.match(/^\u5220\u9664\u8B66\u793A\s*(\d+)$/);
    if (delMatch) {
      const idx = parseInt(delMatch[1]) - 1; const alerts = await getAlerts(uid);
      if (idx >= 0 && idx < alerts.length) { await deleteAlert(alerts[idx].id); await replyTextOrPush(e.replyToken, uid, '\u2705 \u5DF2\u5220\u9664\u8B66\u793A'); }
      else await replyTextOrPush(e.replyToken, uid, '\u26A0\uFE0F \u8B66\u793A\u7DE8\u865F\u4E0D\u5B58\u5728');
      continue;
    }

    if (txt.startsWith('+')) {
      const parts = txt.slice(1).trim().split(/\s+/);
      const code = (parts[0] || '').toUpperCase();
      const costPrice = parts[1] ? parseFloat(parts[1]) : null;
      if ((/^\d{4,6}[A-Z]{0,2}$/.test(code) || /^[A-Z]{1,5}$/.test(code)) && (!parts[1] || (costPrice && !isNaN(costPrice)))) {
        const r = await addToWatchlist(uid, code, costPrice); const twName = TW_NAMES[code] || twseNameCache[code]; const name = twName ? code + ' ' + twName : code;
        if (r === 'ok') {
          let msg = '\u2705 \u5DF2\u52A0\u5165\u81EA\u9078\u80A1\uFF1A' + name;
          if (costPrice) {
            const takeProfit = Math.round(costPrice * 1.15 * 100) / 100;
            const stopLoss = Math.round(costPrice * 0.92 * 100) / 100;
            await addAlert(uid, code, 'above', takeProfit);
            await addAlert(uid, code, 'below', stopLoss);
            msg += '\n\u6210\u672C\u50F9\uFF1A' + costPrice + '\n\u81EA\u52D5\u8A2D\u5B9A\u505C\u5229 ' + takeProfit + '\uFF08+15%\uFF09 / \u505C\u640D ' + stopLoss + '\uFF08-8%\uFF09';
          }
          await replyTextOrPush(e.replyToken, uid, msg);
        }
        else if (r === 'exists') await replyTextOrPush(e.replyToken, uid, '\u26A0\uFE0F ' + name + ' \u5DF2\u5728\u6E05\u55AE\u4E2D');
        else if (r === 'full') await replyTextOrPush(e.replyToken, uid, '\u26A0\uFE0F \u5DF2\u9054\u4E0A\u965010\u652F');
        else await replyTextOrPush(e.replyToken, uid, '\u274C \u52A0\u5165\u5931\u6557');
      } else await replyTextOrPush(e.replyToken, uid, '\u26A0\uFE0F \u683C\u5F0F\u4E0D\u6B63\u78BA\uFF0C\u8ACB\u8F38\u5165 +\u4EE3\u78BC \u6216 +\u4EE3\u78BC \u6210\u672C\u50F9\uFF08\u4F8B\uFF1A+2330 620\uFF09');
      continue;
    }

    if (txt.startsWith('-')) {
      const code = txt.slice(1).trim().toUpperCase(); const r = await removeFromWatchlist(uid, code);
      const twName2 = TW_NAMES[code] || twseNameCache[code]; const name = twName2 ? code + ' ' + twName2 : code;
      if (r === 'ok') await replyTextOrPush(e.replyToken, uid, '\u2705 \u5DF2\u79FB\u9664\uFF1A' + name); else await replyTextOrPush(e.replyToken, uid, '\u274C \u79FB\u9664\u5931\u6557');
      continue;
    }

    if (['\u6211\u7684\u80A1\u7968','\u81EA\u9078\u80A1','\u6E05\u55AE'].includes(txt)) {
      const stocks = await getWatchlistFull(uid);
      if (stocks.length === 0) await replyTextOrPush(e.replyToken, uid, '\u{1F4CB} \u6E05\u55AE\u662F\u7A7A\u7684\n\u8F38\u5165 +\u4EE3\u78BC \u65B0\u589E');
      else {
        const lines = [];
        for (let i = 0; i < stocks.length; i++) {
          const c = stocks[i].stock_code; const cost = stocks[i].cost_price;
          const nm = (TW_NAMES[c] || twseNameCache[c]) ? ' ' + (TW_NAMES[c] || twseNameCache[c]) : '';
          let line = (i + 1) + '. ' + c + nm;
          if (cost) {
            const yahooSymbol = /^\d{4,6}[A-Z]{0,2}$/.test(c) ? c + '.TW' : c;
            const data = await getYahooData(yahooSymbol);
            if (data) {
              const pnlPct = ((data.price - cost) / cost * 100).toFixed(1);
              line += '\n   \u6210\u672C ' + cost + ' \u2192 \u73FE\u50F9 ' + data.price + '\uFF08' + (pnlPct >= 0 ? '+' : '') + pnlPct + '%\uFF09';
            }
          }
          lines.push(line);
        }
        await replyTextOrPush(e.replyToken, uid, '\u{1F4CB} \u81EA\u9078\u80A1\uFF08' + stocks.length + '/10\uFF09\uFF1A\n\n' + lines.join('\n') + '\n\n\u8F38\u5165\u300C\u65E9\u5831\u300D\u7ACB\u5373\u5206\u6790');
      }
      continue;
    }

    if (txt === '\u6CD5\u4EBA\u71B1\u9580') {
      await replyTextOrPush(e.replyToken, uid, '\u{1F50D} \u6B63\u5728\u6383\u63CF\u5916\u8CC7/\u6295\u4FE1\u8CB7\u8D85\u524D10\u540D...');
      (async () => {
        try {
        const topInst = await getTopInstitutionalStocks(10);
        if (topInst.length === 0) { await pushText(uid, '\u274C \u6383\u63CF\u5931\u6557\uFF0C\u8ACB\u7A0D\u5F8C\u518D\u8A66'); return; }
        const instScored = [];
        for (const s of topInst) {
          try {
            const result = await analyzeStock(s.code); if (!result || !result.buyScore) continue;
            instScored.push({ code: result.code, name: result.name, score: result.buyScore.score, label: result.buyScore.label, emoji: result.buyScore.emoji, price: result.price });
            await new Promise(r => setTimeout(r, 2000));
          } catch (e) { console.log('\u6CD5\u4EBA\u71B1\u9580\u80A1\u5206\u6790\u5931\u6557 ' + s.code + ':', e.message); }
        }
        instScored.sort((a, b) => b.score - a.score);
        const list = instScored.map(s => s.emoji + ' ' + s.code + (s.name ? ' ' + s.name : '') + '\uFF08' + s.score.toFixed(1) + '\u5206\uFF09' + s.label).join('\n');
        const strong = instScored.filter(s => s.score >= 3);
        for (const s of strong) { if (!(await hasRecommendationToday(uid, s.code, 'buy'))) await insertRecommendation(uid, s.code, s.name, 'buy', s.score, s.price); }
        await pushText(uid, '\u{1F4B0} \u5916\u8CC7/\u6295\u4FE1\u8CB7\u8D85\u524D10\u540D\uFF08\u53BB\u91CD\u5F8C\u5171 ' + instScored.length + ' \u652F\uFF09\uFF1A\n\n' + list);
        } catch (e) { console.log('\u6CD5\u4EBA\u71B1\u9580\u6574\u9AD4\u5931\u6557:', e.message); await pushText(uid, '\u274C \u6383\u63CF\u5931\u6557\uFF0C\u8ACB\u7A0D\u5F8C\u518D\u8A66'); }
      })();
      continue;
    }

    if (txt === '\u8986\u76E4') {
      const stats = await getRecommendationStats(uid);
      if (stats.length === 0) { await replyTextOrPush(e.replyToken, uid, '\u76EE\u524D\u9084\u6C92\u6709\u5DF2\u5B8C\u6210\u8FFD\u8E64\u7684\u8A0A\u865F\uFF0C\u8A0A\u865F\u767C\u51FA\u5F8C\u9700\u8981\u7B49 7 \u5929\u624D\u6703\u6709\u7D50\u679C'); continue; }
      const correct = stats.filter(s => s.is_correct).length;
      const winRate = (correct / stats.length * 100).toFixed(1);
      const avgPct = (stats.reduce((sum, s) => sum + parseFloat(s.result_pct || 0), 0) / stats.length).toFixed(2);
      const buyStats = stats.filter(s => s.signal_type === 'buy');
      const sellStats = stats.filter(s => s.signal_type === 'sell');
      const buyWin = buyStats.length ? (buyStats.filter(s => s.is_correct).length / buyStats.length * 100).toFixed(1) : '-';
      const sellWin = sellStats.length ? (sellStats.filter(s => s.is_correct).length / sellStats.length * 100).toFixed(1) : '-';
      const recent = stats.slice(0, 5).map(s => (s.is_correct ? '\u2705' : '\u274C') + ' ' + s.stock_code + (s.stock_name ? s.stock_name : '') + '\uFF08' + (s.signal_type === 'buy' ? '\u8CB7' : '\u8CE3') + '\uFF09 ' + (parseFloat(s.result_pct) >= 0 ? '+' : '') + parseFloat(s.result_pct).toFixed(2) + '%').join('\n');
      const msg = '\u{1F4CA} \u8A0A\u865F\u8986\u76E4\u5831\u544A\uFF08\u8FD1 ' + stats.length + ' \u7B46\uFF09' +
        '\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n' +
        '\u7E3D\u9AD4\u52DD\u7387\uFF1A' + winRate + '%\n' +
        '\u5E73\u5747\u5831\u916C\uFF1A' + (avgPct >= 0 ? '+' : '') + avgPct + '%\n' +
        '\u8CB7\u9032\u8A0A\u865F\u52DD\u7387\uFF1A' + buyWin + '%\uFF08' + buyStats.length + ' \u7B46\uFF09\n' +
        '\u8CE3\u51FA\u8A0A\u865F\u52DD\u7387\uFF1A' + sellWin + '%\uFF08' + sellStats.length + ' \u7B46\uFF09\n' +
        '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\u6700\u8FD1\u8A18\u9304\uFF1A\n' + recent;
      await replyTextOrPush(e.replyToken, uid, msg);
      continue;
    }

    if (['\u65E9\u5831','\u5206\u6790\u5168\u90E8'].includes(txt)) {
      const stocks = await getWatchlist(uid);
      if (stocks.length === 0) { await pushText(uid, '\u81EA\u9078\u80A1\u662F\u7A7A\u7684'); continue; }
      await pushText(uid, '\u{1F50D} \u958B\u59CB\u5206\u6790 ' + stocks.length + ' \u652F...');
      const scored = [];
      for (const code of stocks) {
        try {
          const result = await analyzeStock(code); if (!result) continue;
          await pushText(uid, result.textMsg);
          if (result.chartUrl) await push(uid, [{ type: 'image', originalContentUrl: result.chartUrl, previewImageUrl: result.chartUrl }]);
          if (result.buyScore) scored.push({ code: result.code, name: result.name, score: result.buyScore.score, label: result.buyScore.label, emoji: result.buyScore.emoji, price: result.price });
          await new Promise(r => setTimeout(r, 1500));
        } catch (e) { console.log('\u5206\u6790\u5931\u6557 ' + code + ':', e.response ? JSON.stringify(e.response.data) : e.message); }
      }
      const strong = scored.filter(s => s.score >= 3).sort((a, b) => b.score - a.score);
      const weak = scored.filter(s => s.score <= -3).sort((a, b) => a.score - b.score);
      for (const s of strong) { if (!(await hasRecommendationToday(uid, s.code, 'buy'))) await insertRecommendation(uid, s.code, s.name, 'buy', s.score, s.price); }
      for (const s of weak) { if (!(await hasRecommendationToday(uid, s.code, 'sell'))) await insertRecommendation(uid, s.code, s.name, 'sell', s.score, s.price); }
      if (strong.length > 0) {
        const list = strong.map(s => s.emoji + ' ' + s.code + (s.name ? ' ' + s.name : '') + '\uFF08' + s.score.toFixed(1) + '\u5206\uFF09' + s.label).join('\n');
        await pushText(uid, '\u{1F3AF} \u91CD\u9EDE\u95DC\u6CE8\uFF08\u5F37\u529B\u8CB7\u9032\u8A0A\u865F\uFF09\uFF1A\n\n' + list);
      }
      if (weak.length > 0) {
        const list = weak.map(s => s.emoji + ' ' + s.code + (s.name ? ' ' + s.name : '') + '\uFF08' + s.score.toFixed(1) + '\u5206\uFF09' + s.label).join('\n');
        await pushText(uid, '\u26A0\uFE0F \u5EFA\u8B70\u8CE3\u51FA\uFF1A\n\n' + list);
      }
      await pushText(uid, '\u2705 \u5168\u90E8\u5B8C\u6210\uFF01');
      continue;
    }

    if (await features.handle(txt, { uid, replyToken: e.replyToken })) continue;

    const clean = txt.toUpperCase();
    if (/^\d{4,6}[A-Z]{0,2}$/.test(clean) || /^[A-Z]{1,5}$/.test(clean)) {
      try {
        const result = await analyzeStock(clean);
        if (!result) { await replyTextOrPush(e.replyToken, uid, '\u26A0\uFE0F \u627E\u4E0D\u5230 ' + clean + ' \u7684\u8CC7\u6599'); continue; }
        const msgs = [{ type: 'text', text: result.textMsg }];
        if (result.chartUrl) msgs.push({ type: 'image', originalContentUrl: result.chartUrl, previewImageUrl: result.chartUrl });
        await replyOrPush(e.replyToken, uid, msgs);
      } catch (err) { await replyTextOrPush(e.replyToken, uid, '\u274C \u5206\u6790\u5931\u6557\uFF0C\u8ACB\u7A0D\u5F8C\u518D\u8A66'); }
      continue;
    }

    await replyTextOrPush(e.replyToken, uid, '\u8F38\u5165\u300C\u8AAA\u660E\u300D\u67E5\u770B\u4F7F\u7528\u65B9\u5F0F');
  }
});

app.get('/', (req, res) => res.send('OK'));
// ───────────────────────── 儀表板（網頁版）─────────────────────────
const crypto = require('crypto');
const dashCache = new Map(); // key -> { at, data }
const dashInflight = new Map();
const DASH_STALE_MAX = 24 * 3600 * 1000;
function dashRefresh(key, fn) {
  if (dashInflight.has(key)) return dashInflight.get(key);
  const p = (async () => {
    const data = await fn();
    const at = Date.now();
    if (data && typeof data === 'object') data._at = at;
    dashCache.set(key, { at, data });
    if (dashCache.size > 300) dashCache.delete(dashCache.keys().next().value);
    return data;
  })().finally(() => dashInflight.delete(key));
  dashInflight.set(key, p);
  return p;
}
// 快取過期 → 先回舊資料、背景更新（stale-while-revalidate）；強制更新或完全沒有快取才等
async function dashCached(key, ttlMs, fn, force) {
  const hit = dashCache.get(key);
  if (!force && hit) {
    const age = Date.now() - hit.at;
    if (age < ttlMs) return hit.data;
    if (age < DASH_STALE_MAX) { dashRefresh(key, fn).catch(e => console.log('背景更新失敗', key, e.message)); return hit.data; }
  }
  return dashRefresh(key, fn);
}
const DASH_TTL = 10 * 60 * 1000;
async function buildDashStock(code) {
  const d = await features.dashStock(code);
  if (/^\d/.test(code)) {
    const [chip, hist] = await Promise.all([getTWChipData(code), getTWChipHistory(code)]);
    if (chip) d.chip = { foreign: Math.round(chip.foreign / 1000), invest: Math.round(chip.invest / 1000), dealer: Math.round(chip.dealer / 1000), total: Math.round(chip.total / 1000), fStreak: hist ? hist.foreignStreak : 0, iStreak: hist ? hist.investStreak : 0 };
  }
  return d;
}
const dashStockCached = (code, force) => dashCached('s|' + code, DASH_TTL, () => buildDashStock(code), force);
function dashAuth(req, res, next) {
  const want = process.env.DASH_KEY || '';
  if (!want) return res.status(503).json({ error: '尚未設定 DASH_KEY（到 Render 的 Environment 新增）' });
  const got = String(req.query.k || req.headers['x-dash-key'] || '');
  const a = Buffer.from(got), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: '密碼錯誤' });
  next();
}
async function dashUid() {
  if (process.env.DASH_UID) return process.env.DASH_UID;
  const users = await getAllUsers();
  return users[0] || null;
}
const dashWrap = fn => async (req, res) => {
  try { res.set('Cache-Control', 'no-store'); res.json(await fn(req)); }
  catch (e) { console.log('dashboard API 錯誤:', e.message); res.status(500).json({ error: e.message || '伺服器錯誤' }); }
};
app.get('/dashboard', (req, res) => res.sendFile(__dirname + '/dashboard.html'));
app.get('/api/dash/list', dashAuth, dashWrap(async () => {
  const uid = await dashUid();
  if (!uid) return { stocks: [], note: '還沒有自選股，直接在網頁按「＋新增」或在 LINE 傳 +2330' };
  const wl = await getWatchlistFull(uid);
  return { stocks: wl.map(w => ({ code: w.stock_code, cost: w.cost_price || null, shares: w.shares || null })), sharesCol: watchlistHasShares };
}));
app.get('/api/dash/stock', dashAuth, dashWrap(async (req) => {
  const code = String(req.query.code || '').toUpperCase();
  if (!/^[A-Z0-9^]{1,8}$/.test(code)) throw new Error('代號格式不正確');
  return dashStockCached(code, req.query.refresh === '1');
}));
app.get('/api/dash/kline', dashAuth, dashWrap(async (req) => {
  const code = String(req.query.code || '').trim().slice(0, 20);
  if (!code) throw new Error('請輸入代號');
  const tf = req.query.tf === 'W' ? 'W' : 'D';
  return dashCached('k|' + code + '|' + tf, DASH_TTL, () => features.klineData(code, tf), req.query.refresh === '1');
}));
// ── 回測／組合圖表資料 ──
app.get('/api/dash/bt', dashAuth, dashWrap(async (req) => {
  const q = String(req.query.q || '').trim().slice(0, 100);
  if (!q) throw new Error('請輸入代號');
  return dashCached('bt|' + q, 30 * 60 * 1000, () => features.backtestData(q), req.query.refresh === '1');
}));
app.get('/api/dash/pf', dashAuth, dashWrap(async (req) => {
  const q = String(req.query.q || '').trim().slice(0, 300);
  if (!q) throw new Error('請輸入內容');
  const uid = await dashUid();
  return dashCached('pf|' + uid + '|' + q, 10 * 60 * 1000, () => features.portfolioData(q, uid), req.query.refresh === '1');
}));
// ── 覆盤（過去訊號準確度）──
// 評分 v2 上線時間（2026-11-05 11:20 台灣時間）；之前舊評分的訊號不納入覆盤（資料庫的紀錄還在，沒有刪除）
const V2_SINCE = '2026-11-05T03:20:00Z';
app.get('/api/dash/review', dashAuth, dashWrap(async () => {
  const uid = await dashUid(); if (!uid) return { rows: [], stats: null };
  let rows = [];
  try { const r = await SB.get('/recommendations?user_id=eq.' + uid + '&created_at=gte.' + V2_SINCE + '&select=*&order=created_at.desc&limit=120'); rows = r.data; } catch (e) { return { rows: [], stats: null, note: '讀取失敗（recommendations 資料表）' }; }
  const done = rows.filter(x => x.checked && x.result_pct != null);
  const pend = rows.filter(x => !x.checked);
  const ok = done.filter(x => x.is_correct);
  const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
  const bucket = {};
  done.forEach(x => { const k = Math.floor(Number(x.score) || 0); const b = bucket[k] = bucket[k] || { n: 0, ok: 0, pcts: [] }; b.n++; if (x.is_correct) b.ok++; b.pcts.push(Number(x.result_pct)); });
  const byType = {};
  done.forEach(x => { const k = x.signal_type || '?'; const b = byType[k] = byType[k] || { n: 0, ok: 0, pcts: [] }; b.n++; if (x.is_correct) b.ok++; b.pcts.push(Number(x.result_pct)); });
  const fin = b => ({ n: b.n, ok: b.ok, rate: b.n ? b.ok / b.n : null, avg: avg(b.pcts) });
  const now = Date.now();
  return {
    stats: { total: rows.length, done: done.length, pending: pend.length, ok: ok.length, rate: done.length ? ok.length / done.length : null, avgPct: avg(done.map(x => Number(x.result_pct))),
      byScore: Object.keys(bucket).filter(k => Number(k) >= 3).sort((a, b) => b - a).map(k => Object.assign({ score: Number(k) }, fin(bucket[k]))),
      byType: Object.keys(byType).map(k => Object.assign({ type: k }, fin(byType[k]))) },
    rows: rows.slice(0, 120).map(x => {
      const c = dashCache.get('s|' + x.stock_code); const now_p = c && c.data ? c.data.price : null;
      return { code: x.stock_code, name: x.stock_name || '', type: x.signal_type, score: Number(x.score), p0: Number(x.price_at_signal), at: x.created_at, checked: !!x.checked, p1: x.result_price != null ? Number(x.result_price) : null, pct: x.result_pct != null ? Number(x.result_pct) : null, ok: x.is_correct, days: Math.floor((now - new Date(x.created_at).getTime()) / 86400000), now: now_p };
    })
  };
}));
// ── 法人熱門（外資／投信買賣超榜＋連買連賣天數）──
async function instRanks() {
  const days = [];
  const base = new Date(Date.now() + 8 * 3600000);
  for (let back = 0; back < 20 && days.length < 10; back++) {
    const d = new Date(base.getTime() - back * 86400000);
    const dow = d.getUTCDay(); if (dow === 0 || dow === 6) continue;
    const ds = d.toISOString().slice(0, 10).replace(/-/g, '');
    const had = t86Cache.has(ds);
    const t = await getT86(ds);
    if (!t) continue;
    const m = new Map();
    t.rows.forEach(r => m.set(String(r[0]).trim(), { f: t86Num(r[4]) + t86Num(r[7]), i: t86Num(r[10]), t: t86Num(r[18]), name: String(r[1]).trim() }));
    days.push({ date: ds, m });
    if (!had) await new Promise(r => setTimeout(r, 250));
  }
  if (!days.length) throw new Error('證交所三大法人資料暫時取不到');
  const streak = (code, key) => {
    let n = 0;
    for (const d of days) {
      const row = d.m.get(code); const v = row ? row[key] : 0; const sg = v > 0 ? 1 : v < 0 ? -1 : 0;
      if (sg === 0) break;
      if (n === 0) n = sg; else if ((n > 0) === (sg > 0)) n += sg; else break;
    }
    return n;
  };
  const latest = days[0], N = 10;
  const rows = [...latest.m.entries()].filter(([c]) => /^\d{4,6}[A-Z]?$/.test(c)).map(([c, r]) => ({ code: c, name: r.name, foreign: Math.round(r.f / 1000), invest: Math.round(r.i / 1000), total: Math.round(r.t / 1000) }));
  const pick = (key, dir) => rows.slice().sort((a, b) => dir * (b[key] - a[key])).slice(0, N).filter(x => dir > 0 ? x[key] > 0 : x[key] < 0).map(x => {
    const c = dashCache.get('s|' + x.code); const d = c && c.data;
    return Object.assign({}, x, { fStreak: streak(x.code, 'f'), iStreak: streak(x.code, 'i'), price: d ? d.price : null, chg: d ? d.chg : null });
  });
  const ds = latest.date; 
  return { date: ds.slice(0, 4) + '-' + ds.slice(4, 6) + '-' + ds.slice(6, 8), nDays: days.length, foreignBuy: pick('foreign', 1), foreignSell: pick('foreign', -1), investBuy: pick('invest', 1), investSell: pick('invest', -1) };
}

// ── 評分歷史檢驗（背景執行；結果存在 Supabase bot_state，每週日晚上自動更新）──
let studyJob = { state: 'idle', done: 0, total: 0, data: null, err: null, at: 0, loaded: false };
async function studyLoad() {
  if (studyJob.loaded) return; studyJob.loaded = true;
  try { const r = await SB.get('/bot_state?key=eq.score_study&select=value'); const v = r.data && r.data[0] && r.data[0].value; if (v) { const d = JSON.parse(v); if (d && d.combos) { studyJob.data = d; studyJob.at = d.at || 0; studyJob.state = 'done'; } } }
  catch (e) { console.log('讀取評分檢驗存檔失敗：', e.message); }
}
function studyStart(why) {
  if (studyJob.state === 'running') return;
  console.log('評分檢驗開始（' + why + '）');
  studyJob.state = 'running'; studyJob.done = 0; studyJob.total = 0; studyJob.err = null;
  features.scoreStudy((d, t) => { studyJob.done = d; studyJob.total = t; })
    .then(async r => {
      studyJob.data = r; studyJob.at = r.at; studyJob.state = 'done';
      try { await SB.post('/bot_state', { key: 'score_study', value: JSON.stringify(r) }, { headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } }); }
      catch (e) { console.log('評分檢驗存檔失敗（請確認 bot_state 表存在）：', e.response ? JSON.stringify(e.response.data) : e.message); }
    })
    .catch(e => { studyJob.err = e.message; studyJob.state = studyJob.data ? 'done' : 'error'; console.log('評分檢驗失敗：', e.message); });
}
app.get('/api/dash/study', dashAuth, dashWrap(async (req) => {
  await studyLoad();
  if (req.query.start === '1') studyStart('手動');
  return { state: studyJob.state, done: studyJob.done, total: studyJob.total, err: studyJob.err, data: studyJob.data };
}));
// 週日 22:00 自動更新；開機 3 分鐘後若存檔超過 8 天（或沒有）也補跑
setTimeout(async () => { await studyLoad(); if (!studyJob.data || Date.now() - studyJob.at > 8 * 86400000) studyStart('開機補跑'); }, 3 * 60 * 1000);
setInterval(() => {
  const t = new Date(Date.now() + 8 * 3600 * 1000);
  if (t.getUTCDay() === 0 && t.getUTCHours() === 22 && t.getUTCMinutes() < 5) studyStart('週日排程');
}, 60 * 1000);

app.get('/api/dash/inst', dashAuth, dashWrap(async (req) => dashCached('inst', 30 * 60 * 1000, instRanks, req.query.refresh === '1')));
app.get('/api/dash/market', dashAuth, dashWrap(async (req) => dashCached('m|idx', DASH_TTL, () => features.dashStock('加權'), req.query.refresh === '1')));
app.get('/api/dash/scan', dashAuth, dashWrap(async (req) => {
  const uid = await dashUid();
  return dashCached('scan|' + uid, 20 * 60 * 1000, () => features.scanData(uid), req.query.refresh === '1');
}));
// ── 自選股管理 ──
const numQ = v => { const n = parseFloat(String(v == null ? '' : v).replace(/,/g, '')); return isFinite(n) && n > 0 ? n : null; };
app.get('/api/dash/watch/add', dashAuth, dashWrap(async (req) => {
  const uid = await dashUid(); if (!uid) throw new Error('找不到使用者，先在 LINE 傳一次訊息給機器人');
  const code = String(req.query.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{1,8}$/.test(code)) throw new Error('代號格式不正確');
  const cost = numQ(req.query.cost), shares = numQ(req.query.shares);
  const d = await dashStockCached(code, true).catch(() => null);
  if (!d) throw new Error('查不到 ' + code + ' 的資料');
  const r = await addToWatchlist(uid, code, cost, shares ? Math.round(shares) : null);
  if (r === 'exists') throw new Error(code + ' 已在自選股');
  if (r === 'full') throw new Error('自選股最多 10 檔');
  if (r === 'error') throw new Error('寫入失敗，稍後再試');
  return { ok: true, name: d.name, note: r === 'ok_noshares' ? '股數沒存到：Supabase 還沒新增 shares 欄位' : '' };
}));
app.get('/api/dash/watch/update', dashAuth, dashWrap(async (req) => {
  const uid = await dashUid(); if (!uid) throw new Error('找不到使用者');
  const code = String(req.query.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{1,8}$/.test(code)) throw new Error('代號格式不正確');
  const shares = numQ(req.query.shares);
  const r = await updateWatchlistItem(uid, code, numQ(req.query.cost), shares ? Math.round(shares) : null);
  if (r === 'error') throw new Error('更新失敗');
  return { ok: true, note: r === 'ok_noshares' ? '股數沒存到：Supabase 還沒新增 shares 欄位' : '' };
}));
app.get('/api/dash/watch/remove', dashAuth, dashWrap(async (req) => {
  const uid = await dashUid(); if (!uid) throw new Error('找不到使用者');
  const code = String(req.query.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{1,8}$/.test(code)) throw new Error('代號格式不正確');
  const r = await removeFromWatchlist(uid, code);
  if (r === 'error') throw new Error('刪除失敗');
  return { ok: true };
}));
// ── 警示管理 ──
async function alertGroups(uid) {
  const [list, wl] = await Promise.all([getAlerts(uid), getWatchlist(uid)]);
  const inWl = new Set(wl), seen = new Set(), orphan = [], dup = [];
  list.forEach(a => {
    const k = a.stock_code + '|' + a.alert_type + '|' + Number(a.target_price);
    if (!inWl.has(a.stock_code)) orphan.push(a.id); else if (seen.has(k)) dup.push(a.id); else seen.add(k);
  });
  return { list, inWl, orphan, dup };
}
app.get('/api/dash/alerts', dashAuth, dashWrap(async () => {
  const uid = await dashUid(); if (!uid) return { alerts: [] };
  const g = await alertGroups(uid);
  const bad = new Set(g.orphan.concat(g.dup));
  const fired = (await getFiredAlerts(uid)).map(a => ({ id: a.id, code: a.stock_code, type: a.alert_type, target: Number(a.target_price), at: a.triggered_at || null }));
  return { cleanable: bad.size, fired, alerts: g.list.map(a => {
    const c = dashCache.get('s|' + a.stock_code);
    const price = c && c.data ? c.data.price : null;
    return { id: a.id, code: a.stock_code, type: a.alert_type, target: Number(a.target_price), price, name: c && c.data ? c.data.name : '', orphan: !g.inWl.has(a.stock_code), dup: g.dup.includes(a.id) };
  }) };
}));
app.get('/api/dash/alerts/rearm', dashAuth, dashWrap(async (req) => {
  const uid = await dashUid(); if (!uid) throw new Error('找不到使用者');
  const id = String(req.query.id || '');
  if (!/^[\w-]{1,64}$/.test(id)) throw new Error('id 不正確');
  try { await SB.patch('/alerts?id=eq.' + id + '&user_id=eq.' + uid, { triggered: false }); } catch (e) { throw new Error('重新啟用失敗'); }
  return { ok: true };
}));
app.get('/api/dash/alerts/clearfired', dashAuth, dashWrap(async () => {
  const uid = await dashUid(); if (!uid) throw new Error('找不到使用者');
  try { await SB.delete('/alerts?user_id=eq.' + uid + '&triggered=eq.true'); } catch (e) { throw new Error('清空失敗'); }
  return { ok: true };
}));
app.get('/api/dash/alerts/clean', dashAuth, dashWrap(async () => {
  const uid = await dashUid(); if (!uid) throw new Error('找不到使用者');
  const g = await alertGroups(uid);
  const ids = g.orphan.concat(g.dup);
  for (const id of ids) { try { await SB.delete('/alerts?id=eq.' + id + '&user_id=eq.' + uid); } catch (e) {} }
  return { ok: true, removed: ids.length };
}));
app.get('/api/dash/alerts/add', dashAuth, dashWrap(async (req) => {
  const uid = await dashUid(); if (!uid) throw new Error('找不到使用者');
  const code = String(req.query.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{1,8}$/.test(code)) throw new Error('代號格式不正確');
  const type = req.query.type === 'below' ? 'below' : 'above';
  const price = numQ(req.query.price); if (!price) throw new Error('價格不正確');
  const r = await addAlert(uid, code, type, price);
  if (r !== 'ok') throw new Error('新增失敗');
  return { ok: true };
}));
app.get('/api/dash/alerts/del', dashAuth, dashWrap(async (req) => {
  const uid = await dashUid(); if (!uid) throw new Error('找不到使用者');
  const id = String(req.query.id || '');
  if (!/^[\w-]{1,64}$/.test(id)) throw new Error('id 不正確');
  try { await SB.delete('/alerts?id=eq.' + id + '&user_id=eq.' + uid); } catch (e) { throw new Error('刪除失敗'); }
  return { ok: true };
}));
const dashBusy = new Set();
app.get('/api/dash/run', dashAuth, dashWrap(async (req) => {
  const cmd = String(req.query.cmd || ''), q = String(req.query.q || '').trim().slice(0, 200);
  if (!features.cmds[cmd]) throw new Error('未知的功能');
  if (!q) throw new Error('請輸入內容');
  if (dashBusy.has(cmd)) throw new Error('上一個同類查詢還在跑，等幾秒再試');
  dashBusy.add(cmd);
  try {
    const uid = await dashUid();
    const out = await features.cmds[cmd](q, uid);
    const parts = (Array.isArray(out) ? out : [String(out)]).map(String);
    return { text: parts.join('\n\n'), parts };
  } finally { dashBusy.delete(cmd); }
}));


// ── 持股市值歷史（每個交易日收盤後記一筆）──
const taipeiDay = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
async function snapshotPortfolio(uid) {
  const wl = (await getWatchlistFull(uid)).filter(w => w.shares && /^\d/.test(w.stock_code));
  if (!wl.length) return { skipped: '沒有填股數的台股' };
  let mv = 0, cost = 0, costMv = 0;
  for (const w of wl) {
    const d = await dashStockCached(w.stock_code, false);
    if (!d || !d.price) return { skipped: w.stock_code + ' 沒有價格' };
    const v = d.price * w.shares; mv += v;
    if (w.cost_price) { cost += w.cost_price * w.shares; costMv += v; }
  }
  const row = { user_id: uid, day: taipeiDay(), mv: Math.round(mv), cost: Math.round(cost), cost_mv: Math.round(costMv) };
  await SB.post('/portfolio_history?on_conflict=user_id,day', row, { headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
  return { ok: true, row };
}
app.get('/api/dash/history', dashAuth, dashWrap(async () => {
  const uid = await dashUid(); if (!uid) return { rows: [] };
  try {
    const r = await SB.get('/portfolio_history?user_id=eq.' + uid + '&select=day,mv,cost,cost_mv&order=day.asc&limit=400');
    return { rows: r.data };
  } catch (e) { return { rows: [], note: '還沒建立 portfolio_history 資料表（見 SQL）' }; }
}));
app.get('/api/dash/history/snap', dashAuth, dashWrap(async () => {
  const uid = await dashUid(); if (!uid) throw new Error('找不到使用者');
  try { const r = await snapshotPortfolio(uid); if (r.skipped) throw new Error(r.skipped); return r; }
  catch (e) { throw new Error(e.response ? '寫入失敗，請確認已建立 portfolio_history 資料表' : e.message); }
}));
// ── PWA（主畫面圖示）──
app.get('/manifest.json', (req, res) => res.json({
  name: '股票AI儀表板', short_name: '股票AI', start_url: '/dashboard', display: 'standalone',
  background_color: '#0f172a', theme_color: '#0f172a',
  icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }]
}));
app.get('/icon-:n.png', (req, res) => {
  if (!['180', '192', '512'].includes(req.params.n)) return res.sendStatus(404);
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(__dirname + '/assets/icon-' + req.params.n + '.png', e => { if (e && !res.headersSent) res.sendStatus(404); });
});

// ── 預先計算（開網頁就是熱的）──
let warming = false;
async function warmAll(tag) {
  if (warming) return; warming = true;
  const t0 = Date.now();
  try {
    const users = await getAllUsers();
    const codes = new Set();
    for (const u of users) for (const c of await getWatchlist(u)) codes.add(c);
    let ok = 0, bad = 0;
    for (const c of codes) { try { await dashStockCached(c, true); ok++; } catch (e) { bad++; } }
    try { await dashCached('m|idx', DASH_TTL, () => features.dashStock('加權'), true); } catch (e) {}
    const uid = await dashUid();
    if (uid) { try { await dashCached('scan|' + uid, 20 * 60 * 1000, () => features.scanData(uid), true); } catch (e) {} }
    const tp = new Date(Date.now() + 8 * 3600 * 1000), wd = tp.getUTCDay();
    if (wd > 0 && wd < 6 && tp.getUTCHours() * 60 + tp.getUTCMinutes() >= 13 * 60 + 35) {
      try { const u = await dashUid(); if (u) { const r = await snapshotPortfolio(u); console.log('持股快照', r.ok ? r.row.day + ' ' + r.row.mv : r.skipped); } } catch (e) { console.log('持股快照失敗', e.response ? JSON.stringify(e.response.data) : e.message); }
    }
    console.log('預熱完成[' + tag + '] 個股 ' + ok + '/' + (ok + bad) + ' 耗時 ' + Math.round((Date.now() - t0) / 1000) + 's');
  } catch (e) { console.log('預熱失敗', e.message); }
  finally { warming = false; }
}
function scheduleWarm() {
  setTimeout(() => warmAll('boot'), 40 * 1000);
  const done = new Set();
  setInterval(() => {
    const t = new Date(Date.now() + 8 * 3600 * 1000);
    const wd = t.getUTCDay(); if (wd === 0 || wd === 6) return;
    const hm = t.getUTCHours() * 60 + t.getUTCMinutes();
    const day = t.toISOString().slice(0, 10);
    const slots = [8 * 60 + 20, 14 * 60 + 30, 18 * 60, 21 * 60 + 30];
    for (let m = 9 * 60; m <= 13 * 60 + 30; m += 30) slots.push(m);
    const hit = slots.find(m => hm >= m && hm < m + 5);
    if (hit == null) return;
    const key = day + '|' + hit;
    if (done.has(key)) return;
    done.add(key); if (done.size > 50) done.delete(done.values().next().value);
    warmAll('排程' + hit);
  }, 60 * 1000);
}

async function setupRichMenu() {
  try {
    const T = LINE_TOKEN;
    if (!T) return;
    const existing = await axios.get('https://api.line.me/v2/bot/richmenu/list', { headers: { Authorization: 'Bearer ' + T } });
    for (const m of (existing.data.richmenus || [])) {
      await axios.delete('https://api.line.me/v2/bot/richmenu/' + m.richMenuId, { headers: { Authorization: 'Bearer ' + T } }).catch(() => {});
    }
    const msg = (c, r, text) => ({ bounds: { x: c * 625, y: r * 562, width: 625, height: 562 }, action: { type: 'message', text } });
    // 需要帶參數的指令：點了會自動打開鍵盤並預填文字（例如「技術 」），使用者只要補上代號
    const fill = (c, r, text) => ({ bounds: { x: c * 625, y: r * 562, width: 625, height: 562 }, action: { type: 'postback', data: 'fill:' + text.trim(), inputOption: 'openKeyboard', fillInText: text } });
    const menu = {
      size: { width: 2500, height: 1686 }, selected: true, name: 'Stock AI v2', chatBarText: '功能選單',
      areas: [
        msg(0, 0, '我的股票'), msg(1, 0, '早報'), msg(2, 0, '機會'), msg(3, 0, '法人熱門'),
        fill(0, 1, '技術 '), fill(1, 1, '消息 '), fill(2, 1, '回測 '), fill(3, 1, '組合 '),
        msg(0, 2, '我的警示'), msg(1, 2, '覆盤'), msg(2, 2, '說明'),
        // 右下角：儀表板。有網址與密碼就直接開網頁（連結帶密碼，LINE 內建瀏覽器不用再輸入）；缺其中一個就改傳「儀表板」指令請機器人回連結
        (() => {
          const base = (process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || '').replace(/\/$/, '');
          const bounds = { x: 1875, y: 1124, width: 625, height: 562 };
          return base && process.env.DASH_KEY
            ? { bounds, action: { type: 'uri', uri: base + '/dashboard?k=' + encodeURIComponent(process.env.DASH_KEY) } }
            : { bounds, action: { type: 'message', text: '儀表板' } };
        })()
      ]
    };
    const r1 = await axios.post('https://api.line.me/v2/bot/richmenu', menu, { headers: { Authorization: 'Bearer ' + T, 'Content-Type': 'application/json' } });
    const menuId = r1.data.richMenuId;
    console.log('Rich menu created:', menuId);
    // Generate simple colored PNG using sharp (no text/fonts needed)
    
const fs = require('fs');
const buf = fs.readFileSync(__dirname + '/assets/richmenu_v2.png');
    await axios.post('https://api-data.line.me/v2/bot/richmenu/' + menuId + '/content', buf, { headers: { Authorization: 'Bearer ' + T, 'Content-Type': 'image/png', 'Content-Length': buf.length } });
    console.log('Image uploaded');
    await axios.post('https://api.line.me/v2/bot/user/all/richmenu/' + menuId, {}, { headers: { Authorization: 'Bearer ' + T } });
    console.log('Rich menu set as default');
  } catch (e) {
    console.log('Rich menu error:', e.message);
    if (e.response) {
      console.log('Status:', e.response.status);
      console.log('Data:', JSON.stringify(e.response.data));
    }
    if (e.stack) console.log('Stack:', e.stack.split('\n')[0]);
  }
}

app.listen(process.env.PORT || 3000, () => {
  console.log('\u555F\u52D5\u6210\u529F');
  scheduleMorningReport();
  scheduleAlertCheck();
  scheduleWarm();
  setupRichMenu();
});
