const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const GROQ_KEY = process.env.GROQ_API_KEY;

const TW_NAMES = {
  '0050': '元大台灣50', '0056': '元大高股息', '00878': '國泰永續高股息',
  '00881': '國泰台灣ESG永續', '00919': '群益台灣精選高息', '00929': '復華台灣科技優息',
  '00940': '元大台灣價值高息', '00631L': '元大台灣50正2', '00632R': '元大台灣50反1',
  '1101': '台泥', '1216': '統一', '1301': '台塑', '1303': '南亞', '1326': '台化',
  '2002': '中鋼', '2207': '和泰車', '2303': '聯電', '2308': '台達電', '2317': '鴻海',
  '2327': '國巨', '2330': '台積電', '2357': '華碩', '2376': '技嘉', '2377': '微星',
  '2379': '瑞昱', '2382': '廣達', '2395': '研華', '2408': '南亞科', '2409': '友達',
  '2412': '中華電', '2454': '聯發科', '2474': '可成', '2603': '長榮', '2609': '陽明',
  '2610': '華航', '2615': '萬海', '2618': '長榮航', '2881': '富邦金', '2882': '國泰金',
  '2883': '開發金', '2884': '玉山金', '2885': '元大金', '2886': '兆豐金', '2887': '台新金',
  '2890': '永豐金', '2891': '中信金', '2892': '第一金', '2912': '統一超', '3008': '大立光',
  '3034': '聯詠', '3045': '台灣大', '4904': '遠傳', '4938': '和碩', '5871': '中租-KY',
  '5880': '合庫金', '6505': '台塑化', '6669': '緯穎', '6770': '力積電', '8299': '群聯'
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
// Yahoo Finance 歷史資料
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
    const opens = quotes.open;
    const highs = quotes.high;
    const lows = quotes.low;
    const volumes = quotes.volume;

    const price = meta.regularMarketPrice;
    const closesClean = closes.filter(c => c !== null);
    const prev = closesClean.length >= 2
      ? closesClean[closesClean.length - 2]
      : (meta.regularMarketPreviousClose || meta.chartPreviousClose);
    const change = price - prev;

    // 處理日期標籤
    const labels = timestamps.map(ts => {
      const d = new Date(ts * 1000);
      return (d.getMonth() + 1) + '/' + d.getDate();
    });

    return {
      price, change,
      changePct: (change / prev * 100).toFixed(2),
      volume: meta.regularMarketVolume,
      high52: meta.fiftyTwoWeekHigh,
      low52: meta.fiftyTwoWeekLow,
      dayHigh: meta.regularMarketDayHigh,
      dayLow: meta.regularMarketDayLow,
      currency: meta.currency,
      labels,
      closes: closes.map(c => c ? parseFloat(c.toFixed(2)) : null),
      opens: opens.map(o => o ? parseFloat(o.toFixed(2)) : null),
      highs: highs.map(h => h ? parseFloat(h.toFixed(2)) : null),
      lows: lows.map(l => l ? parseFloat(l.toFixed(2)) : null),
      volumes: volumes.map(v => v || 0)
    };
  } catch (e) {
    if (symbol.endsWith('.TW')) {
      try {
        return await getYahooData(symbol.replace('.TW', '.TWO'));
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
  return closes.map((_, i) => {
    if (i < period - 1) return null;
    const slice = closes.slice(i - period + 1, i + 1).filter(c => c !== null);
    if (slice.length < period) return null;
    return parseFloat((slice.reduce((a, b) => a + b, 0) / period).toFixed(2));
  });
}

function calcRSI(closes, period = 14) {
  const clean = closes.filter(c => c !== null);
  if (clean.length < period + 1) return null;
  const slice = clean.slice(-(period + 1));
  let gains = 0, losses = 0;
  for (let i = 1; i < slice.length; i++) {
    const diff = slice[i] - slice[i - 1];
    if (diff > 0) gains += diff; else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return parseFloat((100 - (100 / (1 + avgGain / avgLoss))).toFixed(1));
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
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  if (!ema12 || !ema26) return null;
  return parseFloat((ema12 - ema26).toFixed(3));
}

function calcBollinger(closes, period = 20) {
  const clean = closes.filter(c => c !== null);
  if (clean.length < period) return null;
  const slice = clean.slice(-period);
  const ma = slice.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(slice.reduce((a, b) => a + Math.pow(b - ma, 2), 0) / period);
  return { upper: parseFloat((ma + 2 * std).toFixed(2)), middle: parseFloat(ma.toFixed(2)), lower: parseFloat((ma - 2 * std).toFixed(2)) };
}

// ==============================
// QuickChart K線圖（最近30天）
// ==============================
function buildChartUrl(title, labels, closes, ma5arr, ma20arr, ma60arr) {
  const n = 30;
  const sl = (arr) => arr.slice(-n);

  const config = {
    type: 'line',
    data: {
      labels: sl(labels),
      datasets: [
        {
          label: '收盤價',
          data: sl(closes),
          borderColor: '#2196F3',
          backgroundColor: 'rgba(33,150,243,0.08)',
          borderWidth: 2,
          pointRadius: 2,
          fill: true,
          tension: 0.1
        },
        {
          label: 'MA5',
          data: sl(ma5arr),
          borderColor: '#FF9800',
          borderWidth: 1.5,
          pointRadius: 0,
          fill: false,
          tension: 0.1
        },
        {
          label: 'MA20',
          data: sl(ma20arr),
          borderColor: '#E91E63',
          borderWidth: 1.5,
          pointRadius: 0,
          fill: false,
          tension: 0.1
        },
        {
          label: 'MA60',
          data: sl(ma60arr),
          borderColor: '#9C27B0',
          borderWidth: 1.5,
          pointRadius: 0,
          fill: false,
          tension: 0.1
        }
      ]
    },
    options: {
      title: { display: true, text: title + ' 近30日走勢', fontSize: 16, fontColor: '#333' },
      legend: { position: 'top' },
      scales: {
        yAxes: [{ ticks: { beginAtZero: false } }],
        xAxes: [{ ticks: { maxTicksLimit: 10 } }]
      }
    }
  };

  return JSON.stringify(config);
}

// ==============================
// Groq AI 口語化分析
// ==============================
async function askGroq(techData) {
  const prompt = `你是股票老師，請用口語化、淺顯易懂的繁體中文解釋以下技術指標，像在跟朋友說話一樣，180字內。

${techData}

請依格式回覆：
💹 今日走勢（一句話）
📊 均線排列（說多頭/空頭/糾結，用白話解釋）
🔥 RSI強弱（說超買/超賣/正常，給建議）
📉 MACD動能（說往上/往下，代表什麼）
🎯 布林位置（說在哪個區間，代表什麼）
🧠 綜合判斷（偏多/偏空/中性 + 一句理由）`;

  const r = await axios.post('https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'llama-3.3-70b-versatile',
      max_tokens: 500,
      messages: [
        { role: 'system', content: '你是親切的股票老師，用口語繁體中文解說，讓初學者也能懂。' },
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

    if (/^\d{4,6}[A-Z]{0,2}$/.test(clean)) {
      yahooSymbol = clean + '.TW';
      market = '台股';
      stockName = TW_NAMES[clean] || '';
    } else if (/^[A-Z]{1,5}$/.test(clean)) {
      yahooSymbol = clean;
      market = '美股';
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
      const cleanCloses = closes.filter(c => c !== null);

      // 計算技術指標
      const ma5arr = calcMA(closes, 5);
      const ma20arr = calcMA(closes, 20);
      const ma60arr = calcMA(closes, 60);
      const ma5 = ma5arr[ma5arr.length - 1];
      const ma20 = ma20arr[ma20arr.length - 1];
      const ma60 = ma60arr[ma60arr.length - 1];
      const rsi = calcRSI(closes, 14);
      const macd = calcMACD(closes);
      const boll = calcBollinger(closes, 20);
      const volAvg5 = data.volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;

      const arrow = data.change >= 0 ? '▲' : '▼';
      const sign = data.change >= 0 ? '+' : '';

      // 技術資料文字
      let techData = '股票：' + title + '（' + market + '）\n';
      techData += '現價：' + data.price + ' ' + data.currency + '\n';
      techData += '漲跌：' + arrow + Math.abs(data.change).toFixed(2) + ' (' + sign + data.changePct + '%)\n';
      techData += '今日高低：' + data.dayHigh + ' / ' + data.dayLow + '\n';
      techData += '52週：' + data.low52 + ' ~ ' + data.high52 + '\n\n';
      if (ma5) techData += 'MA5：' + ma5 + '\n';
      if (ma20) techData += 'MA20：' + ma20 + '\n';
      if (ma60) techData += 'MA60：' + ma60 + '\n';
      if (rsi) techData += 'RSI：' + rsi + '（' + (rsi > 70 ? '超買' : rsi < 30 ? '超賣' : '正常') + '）\n';
      if (macd) techData += 'MACD：' + macd + '（' + (macd > 0 ? '正值偏多' : '負值偏空') + '）\n';
      if (boll) {
        const pos = data.price > boll.upper ? '上軌以上過熱' : data.price > boll.middle ? '中上軌偏強' : data.price > boll.lower ? '中下軌偏弱' : '下軌以下超賣';
        techData += '布林：上' + boll.upper + ' 中' + boll.middle + ' 下' + boll.lower + '（' + pos + '）\n';
      }
      const volRatio = (data.volume / volAvg5).toFixed(1);
      techData += '量比：' + volRatio + 'x（' + (volRatio > 1.5 ? '爆量' : volRatio < 0.5 ? '縮量' : '正常') + '）\n';

      // AI 分析
      const analysis = await askGroq(techData);

      // 文字分析訊息
      const textMsg = '📈 ' + title + ' 分析報告\n' +
        '─────────────\n' +
        '現價：' + data.price + ' ' + data.currency + '　' + arrow + data.changePct + '%\n' +
        '今日：' + data.dayHigh + ' ／ ' + data.dayLow + '\n' +
        '成交量：' + Number(data.volume).toLocaleString() + '（量比 ' + volRatio + 'x）\n' +
        '52週：' + data.low52 + ' ～ ' + data.high52 + '\n' +
        '─────────────\n' + analysis;

      // 先傳文字分析
      await pushText(uid, textMsg);

      // 再傳圖片（用 QuickChart POST API 取得短網址）
      try {
        const chartJson = buildChartUrl(title, data.labels, closes, ma5arr, ma20arr, ma60arr);
        const qcRes = await axios.post('https://quickchart.io/chart/create', {
          chart: JSON.parse(chartJson),
          width: 600, height: 400,
          backgroundColor: 'white',
          format: 'png'
        }, { timeout: 10000 });
        const imgUrl = qcRes.data && qcRes.data.url ? qcRes.data.url : null;
        if (imgUrl) {
          await push(uid, [{ type: 'image', originalContentUrl: imgUrl, previewImageUrl: imgUrl }]);
        }
      } catch (imgErr) {
        console.log('chart error:', imgErr.message);
      }

    } catch (err) {
      console.log('error:', err.response ? JSON.stringify(err.response.data) : err.message);
      await pushText(uid, '❌ 分析 ' + display + ' 失敗，請稍後再試。');
    }
  }
});

app.get('/', function(req, res) { res.send('OK'); });
app.listen(process.env.PORT || 3000, function() { console.log('啟動成功'); });
