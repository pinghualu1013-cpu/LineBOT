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
async function addToWatchlist(userId, code) {
  try {
    const existing = await getWatchlist(userId);
    if (existing.includes(code)) return 'exists';
    if (existing.length >= 10) return 'full';
    await SB.post('/watchlist', { user_id: userId, stock_code: code });
    return 'ok';
  } catch (e) { return 'error'; }
}
async function removeFromWatchlist(userId, code) {
  try {
    await SB.delete('/watchlist?user_id=eq.' + userId + '&stock_code=eq.' + code);
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
  try {
    await axios.patch(SUPABASE_URL + '/rest/v1/alerts?id=eq.' + id,
      { triggered: true },
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json' } }
    );
  } catch (e) {}
}

async function push(userId, messages) {
  try {
    await axios.post('https://api.line.me/v2/bot/message/push',
      { to: userId, messages },
      { headers: { Authorization: 'Bearer ' + LINE_TOKEN, 'Content-Type': 'application/json' } }
    );
  } catch (e) { console.log('push error:', e.message); }
}
async function pushText(userId, text) { await push(userId, [{ type: 'text', text }]); }

async function getYahooData(symbol) {
  try {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + symbol + '?interval=1d&range=3mo';
    const r = await axios.get(url, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const result = r.data.chart.result[0];
    const meta = result.meta;
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
      labels, closes: closes.map(c => c ? parseFloat(c.toFixed(2)) : null), volumes: volumes.map(v => v || 0)
    };
  } catch (e) {
    if (symbol.endsWith('.TW')) { try { return await getYahooData(symbol.replace('.TW', '.TWO')); } catch (e2) {} }
    return null;
  }
}

async function getSimplePrice(code) {
  const symbol = /^\d/.test(code) ? code + '.TW' : code;
  try {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + symbol + '?interval=1d&range=1d';
    const r = await axios.get(url, { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    return r.data.chart.result[0].meta.regularMarketPrice;
  } catch (e) { return null; }
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

async function getTWChipData(code) {
  try {
    const url = 'https://www.twse.com.tw/rwd/zh/fund/T86?response=json&selectType=ALLBUT0999';
    const r = await axios.get(url, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.data || !r.data.data) return null;
    const row = r.data.data.find(item => item[0] === code);
    if (!row) return null;
    const parseNum = s => parseInt((s || '0').replace(/,/g, '')) || 0;
    return { foreign: parseNum(row[4]), invest: parseNum(row[7]), dealer: parseNum(row[10]), total: parseNum(row[11]) };
  } catch (e) { return null; }
}

async function getTWChipHistory(code) {
  try {
    const url = 'https://www.twse.com.tw/rwd/zh/fund/TWT38U?response=json&stockNo=' + code;
    const r = await axios.get(url, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.data || !r.data.data || r.data.data.length === 0) return null;
    const parseNum = s => parseInt((s || '0').replace(/,/g, '')) || 0;
    const rows = r.data.data.slice(-10).map(row => ({ foreign: parseNum(row[3]), invest: parseNum(row[6]) }));
    let foreignStreak = 0, investStreak = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (foreignStreak === 0) { foreignStreak = rows[i].foreign >= 0 ? 1 : -1; }
      else { const same = (foreignStreak > 0 && rows[i].foreign >= 0) || (foreignStreak < 0 && rows[i].foreign < 0); if (same) foreignStreak += foreignStreak > 0 ? 1 : -1; else break; }
    }
    for (let i = rows.length - 1; i >= 0; i--) {
      if (investStreak === 0) { investStreak = rows[i].invest >= 0 ? 1 : -1; }
      else { const same = (investStreak > 0 && rows[i].invest >= 0) || (investStreak < 0 && rows[i].invest < 0); if (same) investStreak += investStreak > 0 ? 1 : -1; else break; }
    }
    return { foreignStreak, investStreak };
  } catch (e) { return null; }
}

function formatChip(chip, history) {
  if (!chip) return null;
  const fmt = n => { const sign = n >= 0 ? '+' : ''; return sign + n.toLocaleString() + ' \u5F35 ' + (n >= 0 ? '\u25B2' : '\u25BC'); };
  const streak = (n) => {
    if (!history || n === 0) return '';
    const days = Math.abs(n); const dir = n > 0 ? '\u9023\u8CB7' : '\u9023\u8CE3';
    return '  \u300E' + dir + days + '\u5929\u300F';
  };
  return '\u{1F3E6} \u7C4C\u78BC\u9762\uFF08\u4E09\u5927\u6CD5\u4EBA\uFF09\n\u5916\u8CC7\uFF1A' + fmt(chip.foreign) + streak(history ? history.foreignStreak : 0) + '\n\u6295\u4FE1\uFF1A' + fmt(chip.invest) + streak(history ? history.investStreak : 0) + '\n\u81EA\u71DF\uFF1A' + fmt(chip.dealer) + '\n\u5408\u8A08\uFF1A' + fmt(chip.total);
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
  const r = await axios.post('https://api.groq.com/openai/v1/chat/completions',
    { model: 'llama-3.3-70b-versatile', max_tokens: 500, messages: [
      { role: 'system', content: '\u4F60\u662F\u89AA\u5207\u7684\u80A1\u7968\u8001\u5E2B\uFF0C\u7528\u53E3\u8A9E\u7E41\u9AD4\u4E2D\u6587\u89E3\u8AAA\uFF0C\u8B93\u521D\u5B78\u8005\u4E5F\u80FD\u61C2\u3002' },
      { role: 'user', content: '\u4F60\u662F\u80A1\u7968\u8001\u5E2B\uFF0C\u8ACB\u7528\u53E3\u8A9E\u5316\u7E41\u9AD4\u4E2D\u6587\u89E3\u91CB\u4EE5\u4E0B\u6307\u6A19\uFF0C180\u5B57\u5167\u3002\n\n' + techData + '\n\n\u8ACB\u4F9D\u683C\u5F0F\uFF1A\n\u{1F4B9} \u4ECA\u65E5\u8D70\u52E2\n\u{1F4CA} \u5747\u7DDA\u6392\u5217\n\u{1F525} RSI\u5F37\u5F31\n\u{1F4C9} MACD\u52D5\u80FD\n\u{1F3AF} \u5E03\u6797\u4F4D\u7F6E\n\u{1F9E0} \u7D9C\u5408\u5224\u65B7\uFF08\u504F\u591A/\u504F\u7A7A/\u4E2D\u6027+\u7406\u7531\uFF09' }
    ]},
    { headers: { Authorization: 'Bearer ' + GROQ_KEY, 'Content-Type': 'application/json' }, timeout: 25000 }
  );
  return r.data.choices[0].message.content;
}

async function analyzeStock(code) {
  const clean = code.toUpperCase();
  let yahooSymbol, market, stockName = '';
  if (/^\d{4,6}[A-Z]{0,2}$/.test(clean)) { yahooSymbol = clean + '.TW'; market = '\u53F0\u80A1'; stockName = TW_NAMES[clean] || ''; }
  else if (/^[A-Z]{1,5}$/.test(clean)) { yahooSymbol = clean; market = '\u7F8E\u80A1'; }
  else return null;
  const data = await getYahooData(yahooSymbol);
  if (!data) return null;
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
  const sep = '\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n';
  const textMsg = '\u{1F4C8} ' + title + ' \u5206\u6790\u5831\u544A' + sep +
    '\u73FE\u50F9\uFF1A' + data.price + ' ' + data.currency + '\t' + arrow + data.changePct + '%\n' +
    '\u4ECA\u65E5\uFF1A' + data.dayHigh + ' / ' + data.dayLow + '\n' +
    '\u6210\u4EA4\u91CF\uFF1A' + Number(data.volume).toLocaleString() + '\uFF08\u91CF\u6BD4 ' + volRatio + 'x\uFF09\n' +
    '52\u9031\uFF1A' + data.low52 + ' ~ ' + data.high52 + sep + analysis + sep + srText +
    (chipText ? sep + chipText : '');
  return { textMsg, chartUrl };
}

function scheduleMorningReport() {
  function getNextTime() {
    const now = new Date(); const tw = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    const next = new Date(tw); next.setHours(8, 30, 0, 0);
    if (tw >= next) next.setDate(next.getDate() + 1); return next - tw;
  }
  async function sendMorningReport() {
    const users = await getAllUsers();
    for (const uid of users) {
      const stocks = await getWatchlist(uid); if (stocks.length === 0) continue;
      await pushText(uid, '\u{1F305} \u65E9\u5B89\uFF01\u81EA\u9078\u80A1\u65E9\u5831\u4F86\u4E86\uFF5E');
      for (const code of stocks) {
        try {
          const result = await analyzeStock(code); if (!result) continue;
          await pushText(uid, result.textMsg);
          if (result.chartUrl) await push(uid, [{ type: 'image', originalContentUrl: result.chartUrl, previewImageUrl: result.chartUrl }]);
          await new Promise(r => setTimeout(r, 1000));
        } catch (e) {}
      }
      await pushText(uid, '\u2705 \u65E9\u5831\u5B8C\u6210\uFF01\u7948\u4EA4\u6613\u9806\u5229 \u{1F4CA}');
    }
    setTimeout(sendMorningReport, getNextTime());
  }
  setTimeout(sendMorningReport, getNextTime());
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
          const name = TW_NAMES[alert.stock_code] || alert.stock_code;
          const dir = alert.alert_type === 'above' ? '\u7A81\u7834' : '\u8DCC\u7834';
          await pushText(alert.user_id, '\u{1F6A8} \u80A1\u50F9\u8B66\u793A\uFF01\n\n' + alert.stock_code + ' ' + name + '\n\u73FE\u50F9\uFF1A' + price + '\n' + dir + '\u76EE\u6A19\uFF1A' + target);
          await markAlertTriggered(alert.id);
        }
      } catch (e) {}
    }
  }
  setInterval(checkAlerts, 5 * 60 * 1000);
  checkAlerts();
}

app.post('/webhook', async (req, res) => {
  res.status(200).send('OK');
  const events = req.body && req.body.events ? req.body.events : [];
  for (const e of events) {
    if (e.type !== 'message' || e.message.type !== 'text') continue;
    const uid = e.source.userId; const txt = e.message.text.trim();

    if (['說明','help','?','？'].includes(txt.toLowerCase())) {
      await pushText(uid, '\u{1F916} \u80A1\u7968AI\u6A5F\u5668\u4EBA\n\n\u{1F4CA} \u67E5\u8A62\uFF1A\u8F38\u5165\u4EE3\u78BC\uFF082330\u3001AAPL\uFF09\n\n\u2B50 \u81EA\u9078\u80A1\uFF1A\n+2330 \u52A0\u5165 / -2330 \u79FB\u9664\n\u6211\u7684\u80A1\u7968 \u67E5\u770B\u6E05\u55AE\n\u65E9\u5831 \u7ACB\u5373\u5206\u6790\u5168\u90E8\n\n\u{1F6A8} \u8B66\u793A\uFF1A\n2330>2500 \u7A81\u7834\u8B66\u793A\n2330<2400 \u8DCC\u7834\u8B66\u793A\n\u6211\u7684\u8B66\u793A \u67E5\u770B\u6E05\u55AE\n\u5220\u9664\u8B66\u793A 1 \u5220\u9664\u7B2C1\u500B\n\n\u6BCF\u5929 08:30 \u81EA\u52D5\u65E9\u5831');
      continue;
    }

    const alertMatch = txt.match(/^([A-Z0-9]{4,8})\s*([><])\s*([\d.]+)$/i);
    if (alertMatch) {
      const code = alertMatch[1].toUpperCase(); const type = alertMatch[2] === '>' ? 'above' : 'below'; const price = parseFloat(alertMatch[3]);
      const name = TW_NAMES[code] || code; const dir = type === 'above' ? '\u7A81\u7834' : '\u8DCC\u7834';
      const r = await addAlert(uid, code, type, price);
      if (r === 'ok') await pushText(uid, '\u2705 \u8B66\u793A\u5DF2\u8A2D\u5B9A\uFF01\n' + code + ' ' + name + '\n\u7576\u80A1\u50F9' + dir + ' ' + price + ' \u6642\u81EA\u52D5\u901A\u77E5\u{1F514}');
      else await pushText(uid, '\u274C \u8B66\u793A\u8A2D\u5B9A\u5931\u6557');
      continue;
    }

    if (['\u6211\u7684\u8B66\u793A','\u8B66\u793A\u6E05\u55AE','\u8B66\u793A'].includes(txt)) {
      const alerts = await getAlerts(uid);
      if (alerts.length === 0) { await pushText(uid, '\u76EE\u524D\u6C92\u6709\u8B66\u793A\n\u8F38\u5165\u683C\u5F0F\uFF1A2330>2500 \u6216 2330<2400'); }
      else {
        const list = alerts.map((a, i) => (i + 1) + '. ' + a.stock_code + ' ' + (a.alert_type === 'above' ? '>' : '<') + ' ' + a.target_price).join('\n');
        await pushText(uid, '\u{1F514} \u8B66\u793A\u6E05\u55AE\uFF1A\n\n' + list + '\n\n\u8F38\u5165\u300C\u5220\u9664\u8B66\u793A 1\u300D\u5220\u9664');
      }
      continue;
    }

    const delMatch = txt.match(/^\u5220\u9664\u8B66\u793A\s*(\d+)$/);
    if (delMatch) {
      const idx = parseInt(delMatch[1]) - 1; const alerts = await getAlerts(uid);
      if (idx >= 0 && idx < alerts.length) { await deleteAlert(alerts[idx].id); await pushText(uid, '\u2705 \u5DF2\u5220\u9664\u8B66\u793A'); }
      else await pushText(uid, '\u26A0\uFE0F \u8B66\u793A\u7DE8\u865F\u4E0D\u5B58\u5728');
      continue;
    }

    if (txt.startsWith('+')) {
      const code = txt.slice(1).trim().toUpperCase();
      if (/^\d{4,6}[A-Z]{0,2}$/.test(code) || /^[A-Z]{1,5}$/.test(code)) {
        const r = await addToWatchlist(uid, code); const name = TW_NAMES[code] ? code + ' ' + TW_NAMES[code] : code;
        if (r === 'ok') await pushText(uid, '\u2705 \u5DF2\u52A0\u5165\u81EA\u9078\u80A1\uFF1A' + name);
        else if (r === 'exists') await pushText(uid, '\u26A0\uFE0F ' + name + ' \u5DF2\u5728\u6E05\u55AE\u4E2D');
        else if (r === 'full') await pushText(uid, '\u26A0\uFE0F \u5DF2\u9054\u4E0A\u965010\u652F');
        else await pushText(uid, '\u274C \u52A0\u5165\u5931\u6557');
      } else await pushText(uid, '\u26A0\uFE0F \u4EE3\u78BC\u683C\u5F0F\u4E0D\u6B63\u78BA');
      continue;
    }

    if (txt.startsWith('-')) {
      const code = txt.slice(1).trim().toUpperCase(); const r = await removeFromWatchlist(uid, code);
      const name = TW_NAMES[code] ? code + ' ' + TW_NAMES[code] : code;
      if (r === 'ok') await pushText(uid, '\u2705 \u5DF2\u79FB\u9664\uFF1A' + name); else await pushText(uid, '\u274C \u79FB\u9664\u5931\u6557');
      continue;
    }

    if (['\u6211\u7684\u80A1\u7968','\u81EA\u9078\u80A1','\u6E05\u55AE'].includes(txt)) {
      const stocks = await getWatchlist(uid);
      if (stocks.length === 0) await pushText(uid, '\u{1F4CB} \u6E05\u55AE\u662F\u7A7A\u7684\n\u8F38\u5165 +\u4EE3\u78BC \u65B0\u589E');
      else { const list = stocks.map((c, i) => (i + 1) + '. ' + c + (TW_NAMES[c] ? ' ' + TW_NAMES[c] : '')).join('\n'); await pushText(uid, '\u{1F4CB} \u81EA\u9078\u80A1\uFF08' + stocks.length + '/10\uFF09\uFF1A\n\n' + list + '\n\n\u8F38\u5165\u300C\u65E9\u5831\u300D\u7ACB\u5373\u5206\u6790'); }
      continue;
    }

    if (['\u65E9\u5831','\u5206\u6790\u5168\u90E8'].includes(txt)) {
      const stocks = await getWatchlist(uid);
      if (stocks.length === 0) { await pushText(uid, '\u81EA\u9078\u80A1\u662F\u7A7A\u7684'); continue; }
      await pushText(uid, '\u{1F50D} \u958B\u59CB\u5206\u6790 ' + stocks.length + ' \u652F...');
      for (const code of stocks) {
        try {
          const result = await analyzeStock(code); if (!result) continue;
          await pushText(uid, result.textMsg);
          if (result.chartUrl) await push(uid, [{ type: 'image', originalContentUrl: result.chartUrl, previewImageUrl: result.chartUrl }]);
          await new Promise(r => setTimeout(r, 1500));
        } catch (e) {}
      }
      await pushText(uid, '\u2705 \u5168\u90E8\u5B8C\u6210\uFF01');
      continue;
    }

    const clean = txt.toUpperCase();
    if (/^\d{4,6}[A-Z]{0,2}$/.test(clean) || /^[A-Z]{1,5}$/.test(clean)) {
      const stockName = TW_NAMES[clean] || '';
      await pushText(uid, '\u{1F50D} \u6B63\u5728\u5206\u6790 ' + clean + (stockName ? ' ' + stockName : '') + '...');
      try {
        const result = await analyzeStock(clean);
        if (!result) { await pushText(uid, '\u26A0\uFE0F \u627E\u4E0D\u5230 ' + clean + ' \u7684\u8CC7\u6599'); continue; }
        await pushText(uid, result.textMsg);
        if (result.chartUrl) await push(uid, [{ type: 'image', originalContentUrl: result.chartUrl, previewImageUrl: result.chartUrl }]);
      } catch (err) { await pushText(uid, '\u274C \u5206\u6790\u5931\u6557\uFF0C\u8ACB\u7A0D\u5F8C\u518D\u8A66'); }
      continue;
    }

    await pushText(uid, '\u8F38\u5165\u300C\u8AAA\u660E\u300D\u67E5\u770B\u4F7F\u7528\u65B9\u5F0F');
  }
});

app.get('/', (req, res) => res.send('OK'));
async function setupRichMenu() {
  try {
    const T = LINE_TOKEN;
    if (!T) return;
    const existing = await axios.get('https://api.line.me/v2/bot/richmenu/list', { headers: { Authorization: 'Bearer ' + T } });
    for (const m of (existing.data.richmenus || [])) {
      await axios.delete('https://api-data.line.me/v2/bot/richmenu/' + m.richMenuId, { headers: { Authorization: 'Bearer ' + T } }).catch(() => {});
    }
    const menu = {
      size: { width: 2500, height: 843 }, selected: true, name: 'Stock AI', chatBarText: '功能選單',
      areas: [
        { bounds: { x: 0, y: 0, width: 833, height: 421 }, action: { type: 'message', text: '說明' } },
        { bounds: { x: 833, y: 0, width: 833, height: 421 }, action: { type: 'message', text: '我的股票' } },
        { bounds: { x: 1666, y: 0, width: 834, height: 421 }, action: { type: 'message', text: '早報' } },
        { bounds: { x: 0, y: 421, width: 833, height: 422 }, action: { type: 'message', text: '我的警示' } },
        { bounds: { x: 833, y: 421, width: 833, height: 422 }, action: { type: 'message', text: '分析全部' } },
        { bounds: { x: 1666, y: 421, width: 834, height: 422 }, action: { type: 'uri', uri: 'https://www.twse.com.tw/zh/index.html' } }
      ]
    };
    const r1 = await axios.post('https://api.line.me/v2/bot/richmenu', menu, { headers: { Authorization: 'Bearer ' + T, 'Content-Type': 'application/json' } });
    const menuId = r1.data.richMenuId;
    console.log('Rich menu created:', menuId);
    // Generate simple colored PNG using sharp (no text/fonts needed)
    const sharp = require('sharp');
    // Create a 2500x843 green image with white dividing lines using raw pixel manipulation
    const width = 2500, height = 843;
    const buf = await sharp({
      create: {
        width: width,
        height: height,
        channels: 3,
        background: { r: 6, g: 199, b: 85 }
      }
    })
    .composite([
      // Vertical line at x=833
      { input: await sharp({ create: { width: 3, height: height, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer(), left: 833, top: 0, blend: 'over' },
      // Vertical line at x=1666
      { input: await sharp({ create: { width: 3, height: height, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer(), left: 1666, top: 0, blend: 'over' },
      // Horizontal line at y=421
      { input: await sharp({ create: { width: width, height: 3, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer(), left: 0, top: 421, blend: 'over' }
    ])
    .png().toBuffer();
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
  setupRichMenu();
});
