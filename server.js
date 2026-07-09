const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const app = express();

const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || 'YOUR_LINE_CHANNEL_SECRET';
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || 'YOUR_LINE_CHANNEL_ACCESS_TOKEN';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'YOUR_ANTHROPIC_API_KEY';
const FMP_API_KEY = process.env.FMP_API_KEY || 'YOUR_FMP_API_KEY';

app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

function verifyLineSignature(req, res, next) {
  const signature = req.headers['x-line-signature'];
  const body = req.body;
  const hash = crypto.createHmac('SHA256', LINE_CHANNEL_SECRET).update(body).digest('base64');
  if (hash !== signature) {
  console.log('Signature mismatch, but continuing...');
  // return res.status(401).json({ error: 'Invalid signature' });
}
  next();
}

function detectMarket(input) {
  const clean = input.trim().toUpperCase();
  if (/^\d{4}$/.test(clean)) return { symbol: clean + '.TW', market: 'TW', display: clean };
  if (/^[A-Z]{1,5}$/.test(clean)) return { symbol: clean, market: 'US', display: clean };
  return null;
}

async function fetchStockNews(symbol) {
  try {
    const res = await axios.get(`https://financialmodelingprep.com/api/v3/stock_news?tickers=${symbol}&limit=5&apikey=${FMP_API_KEY}`, { timeout: 8000 });
    return res.data || [];
  } catch (e) { return []; }
}

async function fetchStockQuote(symbol) {
  try {
    const res = await axios.get(`https://financialmodelingprep.com/api/v3/quote/${symbol}?apikey=${FMP_API_KEY}`, { timeout: 8000 });
    return res.data?.[0] || null;
  } catch (e) { return null; }
}

async function analyzeWithClaude(symbol, display, market, quote, newsItems) {
  const quoteText = quote
    ? `【即時報價】\n價格：${quote.price} ${market === 'TW' ? 'TWD' : 'USD'}\n漲跌：${quote.change > 0 ? '▲' : '▼'} ${Math.abs(quote.change).toFixed(2)} (${quote.changesPercentage?.toFixed(2)}%)\n成交量：${quote.volume?.toLocaleString()}\n52週高點：${quote.yearHigh} / 低點：${quote.yearLow}`
    : '（報價資料無法取得）';
  const newsText = newsItems.length > 0
    ? newsItems.map((n, i) => `${i + 1}. ${n.title}\n   來源：${n.site} | ${n.publishedDate?.substring(0, 10)}`).join('\n')
    : '（目前無最新新聞）';
  const prompt = `你是一位專業的股票分析師，請針對以下資料做出繁體中文分析報告。\n\n股票代碼：${display}（${market === 'TW' ? '台股' : '美股'}）\n\n${quoteText}\n\n【最新新聞】\n${newsText}\n\n請依以下格式回覆（精簡，適合 Line 閱讀）：\n\n📊 ${display} 分析摘要\n\n💹 價格動態\n（一句話說明目前走勢）\n\n📰 新聞重點\n（2-3 點條列重要訊息）\n\n🧠 多空判斷\n（明確說明偏多/偏空/中性，並給理由）\n\n⚠️ 注意事項\n（風險提示，1-2 句）\n\n字數控制在 250 字以內。`;
  const response = await axios.post('https://api.anthropic.com/v1/messages',
    { model: 'claude-sonnet-4-6', max_tokens: 800, messages: [{ role: 'user', content: prompt }] },
    { headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, timeout: 30000 }
  );
  return response.data.content?.[0]?.text || '分析失敗，請稍後再試。';
}

async function replyToLine(replyToken, text) {
  await axios.post('https://api.line.me/v2/bot/message/reply',
    { replyToken, messages: [{ type: 'text', text }] },
    { headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
  );
}

app.post('/webhook', verifyLineSignature, async (req, res) => {
  res.status(200).json({ status: 'ok' });
  let body;
  try { body = JSON.parse(req.body.toString()); } catch { return; }
  for (const event of (body.events || [])) {
    if (event.type !== 'message' || event.message.type !== 'text') continue;
    const { replyToken } = event;
    const userInput = event.message.text.trim();
    if (['help', 'Help', '說明', '?', '？'].includes(userInput)) {
      await replyToLine(replyToken, '🤖 股票 AI 分析機器人\n\n📌 使用方式：\n• 台股：輸入 4 位數代碼（如 2330）\n• 美股：輸入英文代碼（如 AAPL）\n\n輸入代碼即可開始分析 👇');
      continue;
    }
    const stockInfo = detectMarket(userInput);
    if (!stockInfo) { await replyToLine(replyToken, `⚠️ 無法識別「${userInput}」\n請輸入台股4位數字或美股英文代碼`); continue; }
    try { await replyToLine(replyToken, `🔍 正在分析 ${stockInfo.display}，請稍候...`); } catch {}
    try {
      const [quote, news] = await Promise.all([fetchStockQuote(stockInfo.symbol), fetchStockNews(stockInfo.symbol)]);
      const analysis = await analyzeWithClaude(stockInfo.symbol, stockInfo.display, stockInfo.market, quote, news);
      await axios.post('https://api.line.me/v2/bot/message/push',
        { to: event.source.userId, messages: [{ type: 'text', text: analysis }] },
        { headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
      );
    } catch (err) {
      console.error('分析流程錯誤:', err.message);
      await axios.post('https://api.line.me/v2/bot/message/push',
        { to: event.source.userId, messages: [{ type: 'text', text: `❌ 分析 ${stockInfo.display} 時發生錯誤，請稍後再試。` }] },
        { headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
      );
    }
  }
});

app.get('/', (req, res) => res.json({ status: 'running', service: 'Line Bot 股票 AI' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Line Bot 啟動中，Port: ${PORT}`));
