const axios = require('axios');
const sharp = require('sharp');

const T = process.env.LINE_CHANNEL_ACCESS_TOKEN;

const svg = `<svg width="2500" height="843" xmlns="http://www.w3.org/2000/svg">
<rect width="2500" height="843" fill="#06C755"/>
<line x1="833" y1="0" x2="833" y2="843" stroke="rgba(255,255,255,0.4)" stroke-width="3"/>
<line x1="1666" y1="0" x2="1666" y2="843" stroke="rgba(255,255,255,0.4)" stroke-width="3"/>
<line x1="0" y1="421" x2="2500" y2="421" stroke="rgba(255,255,255,0.4)" stroke-width="3"/>
<text x="416" y="180" text-anchor="middle" font-size="130" font-family="Arial Unicode MS,Arial,sans-serif">?</text>
<text x="416" y="340" text-anchor="middle" font-size="80" font-family="Arial Unicode MS,Arial,sans-serif" fill="white" font-weight="bold">使用說明</text>
<text x="1249" y="180" text-anchor="middle" font-size="130" font-family="Arial Unicode MS,Arial,sans-serif">*</text>
<text x="1249" y="340" text-anchor="middle" font-size="80" font-family="Arial Unicode MS,Arial,sans-serif" fill="white" font-weight="bold">我的股票</text>
<text x="2082" y="180" text-anchor="middle" font-size="130" font-family="Arial Unicode MS,Arial,sans-serif">@</text>
<text x="2082" y="340" text-anchor="middle" font-size="80" font-family="Arial Unicode MS,Arial,sans-serif" fill="white" font-weight="bold">早報分析</text>
<text x="416" y="601" text-anchor="middle" font-size="130" font-family="Arial Unicode MS,Arial,sans-serif">!</text>
<text x="416" y="761" text-anchor="middle" font-size="80" font-family="Arial Unicode MS,Arial,sans-serif" fill="white" font-weight="bold">我的警示</text>
<text x="1249" y="601" text-anchor="middle" font-size="130" font-family="Arial Unicode MS,Arial,sans-serif">#</text>
<text x="1249" y="761" text-anchor="middle" font-size="80" font-family="Arial Unicode MS,Arial,sans-serif" fill="white" font-weight="bold">分析全部</text>
<text x="2082" y="601" text-anchor="middle" font-size="130" font-family="Arial Unicode MS,Arial,sans-serif">$</text>
<text x="2082" y="761" text-anchor="middle" font-size="80" font-family="Arial Unicode MS,Arial,sans-serif" fill="white" font-weight="bold">證交所</text>
</svg>`;

async function setup() {
  try {
    // 1. 建立 Rich Menu
    const menu = {
      size: { width: 2500, height: 843 },
      selected: true,
      name: 'Stock AI Menu',
      chatBarText: '📊 功能選單',
      areas: [
        { bounds: { x: 0, y: 0, width: 833, height: 421 }, action: { type: 'message', text: '說明' } },
        { bounds: { x: 833, y: 0, width: 833, height: 421 }, action: { type: 'message', text: '我的股票' } },
        { bounds: { x: 1666, y: 0, width: 834, height: 421 }, action: { type: 'message', text: '早報' } },
        { bounds: { x: 0, y: 421, width: 833, height: 422 }, action: { type: 'message', text: '我的警示' } },
        { bounds: { x: 833, y: 421, width: 833, height: 422 }, action: { type: 'message', text: '分析全部' } },
        { bounds: { x: 1666, y: 421, width: 834, height: 422 }, action: { type: 'uri', uri: 'https://www.twse.com.tw/zh/index.html' } }
      ]
    };

    const r1 = await axios.post('https://api.line.me/v2/bot/richmenu', menu, {
      headers: { Authorization: 'Bearer ' + T, 'Content-Type': 'application/json' }
    });
    const menuId = r1.data.richMenuId;
    console.log('Menu created:', menuId);

    // 2. 產生並上傳圖片
    const buf = await sharp(Buffer.from(svg)).png().toBuffer();
    await axios.post('https://api.line.me/v2/bot/richmenu/' + menuId + '/content', buf, {
      headers: { Authorization: 'Bearer ' + T, 'Content-Type': 'image/png', 'Content-Length': buf.length }
    });
    console.log('Image uploaded');

    // 3. 設為預設選單
    await axios.post('https://api.line.me/v2/bot/user/all/richmenu/' + menuId, {}, {
      headers: { Authorization: 'Bearer ' + T }
    });
    console.log('Set as default. Done!');
  } catch (e) {
    console.log('Error:', e.response ? JSON.stringify(e.response.data) : e.message);
  }
}

setup();
