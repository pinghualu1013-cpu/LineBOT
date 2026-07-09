const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY;
const FMP_KEY = process.env.FMP_API_KEY;

async function push(userId, text) {
  try {
    await axios.post('https://api.line.me/v2/bot/message/push',
      { to: userId, messages: [{ type: 'text', text }] },
      { headers: { Authorization: 'Bearer ' + LINE_TOKEN, 'Content-Type': 'application/json' } }
    );
  } catch (e) {
    console.log('push error:', e.response ? JSON.stringify(e.response.data) : e.message);
  }
}

async function getQuote(symbol) {
  try {
    const r = await axios.get('https://financialmodelingprep.com/api/v3/quote/' + symbol + '?apikey=' + FMP_KEY, { timeout: 8000 });
    return r.data && r.data[0] ? r.data[0] : null;
  } catch (e) { return null; }
}

async function getNews(symbol) {
  try {
    const r = await axios.get('https://financialmodelingprep.com/api/v3/stock_news?tickers=' + symbol + '&limit=3&apikey=' + FMP_KEY, { timeout: 8000 });
    return r.data || [];
  } catch (e) { return []; }
}

async function askClaude(prompt) {
  const r = await axios.post('https://api.anthropic.com/v1/messages',
    { model: 'claude-sonnet-4-6', max_tokens: 600, messages: [{ role: 'user', content: prompt }] },
    { headers: { 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, timeout: 25000 }
  );
  return r.data.content[0].text;
}

app.post('/webhook', async (req, res) => {
  res.status(200).send('OK');
  const events = req.body && req.body.events ? req.body.events : [];
  for (const e of events) {
    if (e.type !== 'message' || e.message.type !== 'text') continue;
    const uid = e.source.userId;
    const txt = e.message.text.trim();
    console.log('msg:', txt, 'uid:', uid);

    const clean = txt.toUpperCase();
    let symbol = null;
    let market = null;
    let display = null;

    if (/^\d{4}$/.test(clean)) {
      symbol = clean + '.TW';
      market = '台股';
      display = clean;
    } else if (/^[A-Z]{1,5}$/.test(clean)) {
      symbol = clean;
      market = '美股';
      display = clean;
    }

    if (!symbol) {
      await push(uid, '請輸入台股4位數字（如 2330）或美股代碼（如 AAPL）');
      continue;
    }

    await push(uid, '🔍 正在分析 ' + display + '，請稍候...');

    try {
      const quote = await getQuote(symbol);
      const news = await getNews(symbol);

      let info = '股票：' + display + '（' + market + '）\n';
      if (quote) {
        info += '價格：' + quote.price + '\n';
        info += '漲跌：' + (quote.change > 0 ? '▲' : '▼') + Math.abs(quote.change).toFixed(2) + ' (' + (quote.changesPercentage ? quote.changesPercentage.toFixed(2) : '0') + '%)\n';
      }
      if (news.length > 0) {
        info += '\n新聞：\n';
        for (let i = 0; i < Math.min(3, news.length); i++) {
          info += (i+1) + '. ' + news[i].title + '\n';
        }
      }

      const prompt = '你是股票分析師，用繁體中文分析以下資料，200字內，適合LINE閱讀，給出多空判斷：\n\n' + info;
      const result = await askClaude(prompt);
      await push(uid, result);
    } catch (err) {
      console.log('分析錯誤:', err.response ? JSON.stringify(err.response.data) : err.message);
      await push(uid, '❌ 分析失敗：' + (err.response ? JSON.stringify(err.response.data) : err.message));
    }
  }
});

app.get('/', function(req, res) { res.send('OK'); });

app.listen(process.env.PORT || 3000, function() { console.log('啟動成功'); });
