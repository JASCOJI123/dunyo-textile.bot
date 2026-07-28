const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const APP_URL = process.env.APP_URL; // masalan: https://dunyo-textile.onrender.com
const DATA_FILE = path.join(__dirname, 'data.json');

function loadData() {
  if (!fs.existsSync(DATA_FILE)) return { users: {}, entries: [] };
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}
function saveData(d) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
}

async function tgApi(method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return res.json();
}

// === TELEGRAM WEBHOOK ===
app.post('/webhook', async (req, res) => {
  const update = req.body;
  res.sendStatus(200); // Telegram darhol javob talab qiladi

  const msg = update.message;
  if (!msg) return;
  const chatId = msg.chat.id;
  const data = loadData();

  // /start bosilganda - telefon raqamini so'raymiz
  if (msg.text === '/start') {
    await tgApi('sendMessage', {
      chat_id: chatId,
      text: "Assalomu alaykum! 🎡 Dunyo Textile chegirma barabaniga xush kelibsiz.\n\nO'yinni boshlash uchun avval telefon raqamingizni yuboring 👇",
      reply_markup: {
        keyboard: [[{ text: "📱 Raqamni yuborish", request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true
      }
    });
    return;
  }

  // Foydalanuvchi raqamni yubordi
  if (msg.contact) {
    const uid = String(msg.from.id);
    data.users[uid] = {
      id: uid,
      first_name: msg.from.first_name || "",
      last_name: msg.from.last_name || "",
      username: msg.from.username || "",
      phone: msg.contact.phone_number,
      joined_at: new Date().toISOString()
    };
    saveData(data);

    await tgApi('sendMessage', {
      chat_id: chatId,
      text: "Rahmat! Endi barabanni aylantirishingiz mumkin 🎉",
      reply_markup: {
        keyboard: [[{ text: "🎡 O'yinni boshlash", web_app: { url: APP_URL + "/game.html" } }]],
        resize_keyboard: true
      }
    });
    return;
  }

  // O'yin natijasi keldi (game.html dagi tg.sendData orqali)
  if (msg.web_app_data) {
    const uid = String(msg.from.id);
    let payload;
    try { payload = JSON.parse(msg.web_app_data.data); } catch (e) { payload = {}; }

    const user = data.users[uid] || { first_name: msg.from.first_name || "", phone: "noma'lum" };
    data.entries.push({
      user_id: uid,
      name: [user.first_name, user.last_name].filter(Boolean).join(" "),
      phone: user.phone,
      username: user.username || "",
      prize: payload.label || "",
      code: payload.code || "",
      type: payload.type || "",
      date: new Date().toISOString()
    });
    saveData(data);

    const text = payload.type === 'retry'
      ? "Bu safar omad kulmadi 🙃 Lekin harakatingiz uchun rahmat!"
      : `Tabriklaymiz! 🎁 Yutuq: ${payload.label}\nKod: ${payload.code}\n\nUshbu kodni kassada ko'rsating.`;

    await tgApi('sendMessage', { chat_id: chatId, text });
    return;
  }
});

// === ADMIN PANEL ===
app.get('/admin', (req, res) => {
  if (req.query.key !== ADMIN_PASSWORD) {
    res.status(401).send('<h2 style="font-family:sans-serif">Kirish taqiqlangan. Manzil oxiriga ?key=PAROL qo\'shing.</h2>');
    return;
  }
  const data = loadData();
  const rows = data.entries.slice().reverse().map(e => `
    <tr>
      <td>${new Date(e.date).toLocaleString('uz-UZ')}</td>
      <td>${e.name || '-'}</td>
      <td>${e.phone || '-'}</td>
      <td>${e.username ? '@' + e.username : '-'}</td>
      <td>${e.prize}</td>
      <td>${e.code || '-'}</td>
    </tr>`).join('');

  res.send(`<!DOCTYPE html><html lang="uz"><head><meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin — Dunyo Textile</title>
  <style>
    body{font-family:system-ui,sans-serif;background:#0e1152;color:#f4f0e4;margin:0;padding:24px;}
    h1{font-size:20px;margin-bottom:18px;}
    .stat{display:inline-block;background:#1c2172;padding:10px 18px;border-radius:10px;margin-right:10px;margin-bottom:18px;font-size:14px;}
    table{width:100%;border-collapse:collapse;background:#181c66;border-radius:10px;overflow:hidden;font-size:13px;}
    th,td{padding:10px 12px;text-align:left;border-bottom:1px solid #2b306e;white-space:nowrap;}
    th{background:#131552;text-transform:uppercase;font-size:11px;letter-spacing:.05em;}
    tr:hover{background:#20256e;}
    .wrap{overflow-x:auto;}
  </style></head><body>
  <h1>Dunyo Textile — Baraban statistikasi</h1>
  <div class="stat">Jami ro'yxatdan o'tgan: <b>${Object.keys(data.users).length}</b></div>
  <div class="stat">Jami aylantirish: <b>${data.entries.length}</b></div>
  <div class="wrap">
  <table>
    <tr><th>Sana</th><th>Ism</th><th>Telefon</th><th>Username</th><th>Yutuq</th><th>Kod</th></tr>
    ${rows || '<tr><td colspan="6">Hali ma\'lumot yo\'q</td></tr>'}
  </table>
  </div>
  </body></html>`);
});

app.get('/', (req, res) => res.send('Bot serveri ishlayapti ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port', PORT));
