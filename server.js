const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const GROQ_KEY = process.env.GROQ_API_KEY;

const TW_NAMES = {
  '0050': '元大台灣50', '0056': '元大高股息', '00878': '國泰永續高股息',
  '00881': '國泰台灣ESG永續', '00900': '富邦特選高股息30', '00919': '群益台灣精選高息',
  '00929': '復華台灣科技優息', '00940': '元大台灣價值高息', '00631L': '元大台灣50正2',
  '00632R': '元大台灣50反1', '1101': '台泥', '1216': '統一', '1301': '台塑',
  '1303': '南亞', '1326': '台化', '2002': '中鋼', '2207': '和泰車',
  '2301': '光寶科', '2303': '聯電', '2308': '台達電', '2317': '鴻海',
  '2327': '國巨', '2330': '台積電', '2357': '華碩', '2376': '技嘉',
  '2377': '微星', '2379': '瑞昱', '2382': '廣達', '2395': '研華',
  '2408': '南亞科', '2409': '友達', '2412': '中華電', '2454': '聯發科',
  '2474': '可成', '2498': '宏達電', '2603': '長榮', '2609': '陽明',
  '2610': '華航', '2615': '萬海', '2618': '長榮航', '2727': '王品',
  '2881': '富邦金', '2882': '國泰金', '2883': '開發金', '2884': '玉山金',
  '2885': '元大金', '2886': '兆豐金', '2887': '台新金', '2890': '永豐金',
  '2891': '中信金', '2892': '第一金', '2912': '統一超', '3008': '大立光',
  '3034': '聯詠', '3045': '台灣大', '4904': '遠傳', '4938': '和碩',
  '5871': '中租-KY', '5880': '合庫金', '6505': '台塑化', '6669': '緯穎',
  '6770': '力積電', '8299': '群聯'
};

async function push(userId, messages) {
  try {
    await axios.post('https://api.line.me/v2/bot/message/push',
      { to: userId, messages },
      { headers: { Authorization: 'Bearer ' + LINE_TOKEN, 'Content-Type': 'application/json' } }
    );
  } catch (e) {
    console.log('push error:', e.response ? JSON.stringify(e.response.data) : e.message);
  }
}

async function pushText(userId, text) {
  await push(userId, [{ type: 'text', text }]);
}

// ==============================
// Yahoo Finance 報價 + 歷史資料
// ==============================
async function getYahooData(symbol) {
  try {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + symbol + '?interval=1d&range=3mo';
    const r = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const result = r.data.chart.result[0];
    const meta = result.meta;
    const quotes = result.indicators.quote[0];
    const timestamps = result.timestamp;
    const closes = quotes.close;
    const highs = quotes.high;
    const lows = quotes.low;
    const volumes = quotes.volume;

    const price = meta.regularMarketPrice;
    const prev = meta.regularMarketPreviousClose || meta.chartPreviousClose || meta.previousClose;
    const change = price - prev;

    return {
      price, change,
      changePct: (change / prev * 100).toFixed(2),
      volume: meta.regularMarketVolume,
      high52: meta.fiftyTwoWeekHigh,
      low52: meta.fiftyTwoWeekLow,
      dayHigh: meta.regularMarketDayHigh,
      dayLow: meta.regularMarketDayLow,
      currency: meta.currency,
      marketCap: meta.marketCap || null,
      closes: closes.filter(c => c !== null),
      highs: highs.filter(h => h !== null),
      lows: lows.filter(l => l !== null),
      volumes: volumes.filter(v => v !== null)
    };
  } catch (e) {
    if (symbol.endsWith('.TW')) {
      try {
        const sym2 = symbol.replace('.TW', '.TWO');
        return await getYahooData(sym2);
      } catch (e2) {}
    }
    console.log('data error:', e.message);
    return null;
  }
}

// ==============================
// 技術指標計算
// ==============================
function calcMA(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const slice = closes.slice(-(period + 1));
  let gains = 0, losses = 0;
  for (let i = 1; i < slice.length; i++) {
    const diff = slice[i] - slice[i-1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calcMACD(closes) {
  if (closes.length < 26) return null;
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  if (!ema12 || !ema26) return null;
  return ema12 - ema26;
}

function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcBollinger(closes, period = 20) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const ma = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + Math.pow(b - ma, 2), 0) / period;
  const std = Math.sqrt(variance);
  return { upper: ma + 2 * std, middle: ma, lower: ma - 2 * std };
}

function calcVolumeAvg(volumes, period = 5) {
  if (volumes.length < period) return null;
  const slice = volumes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// ==============================
// TradingView 連結
// ==============================
function getTradingViewUrl(code, isUS) {
  if (isUS) {
    return 'https://www.tradingview.com/chart/?symbol=NASDAQ:' + code;
  }
  // 台股
  return 'https://www.tradingview.com/chart/?symbol=TWSE:' + code;
}

// ==============================
// Groq AI 口語化分析
// ==============================
async function askGroq(techData) {
  const prompt = `你是股票老師，請用口語化、淺顯易懂的繁體中文解釋以下技術指標，像在跟朋友說話一樣，不要用太多專業術語，200字內。

${techData}

請依格式回覆：
💹 今日走勢
（用一句話說今天漲跌狀況）

📊 均線說什麼
（MA5/20/60目前排列，簡單說是多頭還是空頭排列）

🔥 RSI 強弱
（用口語說現在是超買/超賣/正常，並給建議）

📉 MACD 動能
（說明目前動能是往上還是往下）

🎯 布林通道位置
（說現在股價在通道的哪個位置，代表什麼意思）

🧠 綜合判斷
（偏多/偏空/中性，給一個清楚的結論）`;

  const r = await axios.post('https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'llama-3.3-70b-versatile',
      max_tokens: 600,
      messages: [
        { role: 'system', content: '你是親切的股票老師，用口語化繁體中文解說技術指標，讓初學者也能看懂。' },
        { role: 'user', content: prompt }
      ]
    },
    { headers: { Authorization: 'Bearer ' + GROQ_KEY, 'Content-Type': 'application/json' }, timeout: 25000 }
  );
  return r.data.choices[0].message.content;
}

// ==============================
// Webhook
// ==============================
app.post('/webhook', async (req, res) => {
  res.status(200).send('OK');
  const events = req.body && req.body.events ? req.body.events : [];

  for (const e of events) {
    if (e.type !== 'message' || e.message.type !== 'text') continue;
    const uid = e.source.userId;
    const txt = e.message.text.trim();
    console.log('msg:', txt);

    const clean = txt.toUpperCase();
    let yahooSymbol = null;
    let market = null;
    let display = clean;
    let stockName = '';
    let isUS = false;

    if (/^\d{4,6}[A-Z]{0,2}$/.test(clean)) {
      yahooSymbol = clean + '.TW';
      market = '台股';
      stockName = TW_NAMES[clean] || TW_NAMES[txt] || '';
    } else if (/^[A-Z]{1,5}$/.test(clean)) {
      yahooSymbol = clean;
      market = '美股';
      isUS = true;
    } else {
      await pushText(uid, '請輸入：\n• 台股：數字代碼（如 2330、00940、00631L）\n• 美股：英文代碼（如 AAPL、NVDA）');
      continue;
    }

    const title = display + (stockName ? ' ' + stockName : '');
    await pushText(uid, '🔍 正在分析 ' + title + '，請稍候...');

    try {
      const data = await getYahooData(yahooSymbol);

      if (!data) {
        await pushText(uid, '⚠️ 找不到 ' + display + ' 的資料，請確認代碼是否正確。');
        continue;
      }

      const closes = data.closes;
      const volumes = data.volumes;

      // 計算技術指標
      const ma5 = calcMA(closes, 5);
      const ma20 = calcMA(closes, 20);
      const ma60 = calcMA(closes, 60);
      const rsi = calcRSI(closes, 14);
      const macd = calcMACD(closes);
      const boll = calcBollinger(closes, 20);
      const volAvg5 = calcVolumeAvg(volumes, 5);
      const currentPrice = data.price;

      // 組合技術資料文字
      let techData = '股票：' + title + '（' + market + '）\n';
      techData += '現價：' + currentPrice + ' ' + data.currency + '\n';
      techData += '今日漲跌：' + (data.change >= 0 ? '▲' : '▼') + Math.abs(data.change).toFixed(2) + ' (' + (data.change >= 0 ? '+' : '') + data.changePct + '%)\n';
      techData += '今日高低：' + data.dayHigh + ' / ' + data.dayLow + '\n';
      techData += '成交量：' + Number(data.volume).toLocaleString() + '\n';
      techData += '52週高點：' + data.high52 + ' / 低點：' + data.low52 + '\n\n';

      techData += '【技術指標】\n';
      if (ma5) techData += 'MA5（5日均線）：' + ma5.toFixed(2) + '\n';
      if (ma20) techData += 'MA20（月線）：' + ma20.toFixed(2) + '\n';
      if (ma60) techData += 'MA60（季線）：' + ma60.toFixed(2) + '\n';
      if (rsi) techData += 'RSI(14)：' + rsi.toFixed(1) + '（' + (rsi > 70 ? '超買區' : rsi < 30 ? '超賣區' : '正常區') + '）\n';
      if (macd) techData += 'MACD：' + macd.toFixed(3) + '（' + (macd > 0 ? '正值，動能偏多' : '負值，動能偏空') + '）\n';
      if (boll) {
        techData += '布林上軌：' + boll.upper.toFixed(2) + '\n';
        techData += '布林中軌：' + boll.middle.toFixed(2) + '\n';
        techData += '布林下軌：' + boll.lower.toFixed(2) + '\n';
        const bollPos = currentPrice > boll.upper ? '上軌以上（過熱）' :
          currentPrice > boll.middle ? '中上軌之間（偏強）' :
          currentPrice > boll.lower ? '中下軌之間（偏弱）' : '下軌以下（超賣）';
        techData += '目前位置：' + bollPos + '\n';
      }
      if (volAvg5) {
        const volRatio = data.volume / volAvg5;
        techData += '量比（今日/5日均量）：' + volRatio.toFixed(1) + 'x（' + (volRatio > 1.5 ? '爆量' : volRatio < 0.5 ? '縮量' : '正常量') + '）\n';
      }

      console.log('techData:', techData);

      // AI 分析
      const analysis = await askGroq(techData);

      // TradingView K線圖連結
      const tvUrl = getTradingViewUrl(display, isUS);

      // 組合最終訊息
      const arrow = data.change >= 0 ? '▲' : '▼';
      const headerMsg = '📈 ' + title + ' 分析報告\n' +
        '─────────────\n' +
        '現價：' + currentPrice + ' ' + data.currency + '　' + arrow + data.changePct + '%\n' +
        '今日：' + data.dayHigh + ' ／ ' + data.dayLow + '\n' +
        '成交量：' + Number(data.volume).toLocaleString() + '\n' +
        '52週：' + data.low52 + ' ～ ' + data.high52 + '\n' +
        '─────────────\n' +
        analysis + '\n' +
        '─────────────\n' +
        '📊 K線圖：' + tvUrl;

      await pushText(uid, headerMsg);

    } catch (err) {
      console.log('error:', err.response ? JSON.stringify(err.response.data) : err.message);
      await pushText(uid, '❌ 分析 ' + display + ' 失敗，請稍後再試。');
    }
  }
});

app.get('/', function(req, res) { res.send('OK'); });
app.listen(process.env.PORT || 3000, function() { console.log('啟動成功'); });
