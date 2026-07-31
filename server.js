const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    // MUHIM: Telegram mini-ilova ichki brauzeri game.html'ni ba'zan
    // eski holatda keshlab qo'yadi. Bu HTML fayl uchun keshni butunlay
    // o'chiradi, shunda har safar eng yangi versiya yuklanadi.
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
  }
}));

// Har bir deploy'da o'zgartiring - bu Telegram'ga "sahifa yangilangan,
// keshni ishlatma" deb signal beradi (query parametr o'zgarsa, URL yangi
// resurs sifatida qabul qilinadi)
const GAME_VERSION = 'v4';

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || ''; // bo'sh bo'lsa tekshiruv o'chirilgan hisoblanadi
const APP_URL = process.env.APP_URL; // masalan: https://dunyo-textile.onrender.com
const BOT_USERNAME = process.env.BOT_USERNAME || '';
const CATALOG_URL = process.env.CATALOG_URL || '';
const CHANNEL_USERNAME = (process.env.CHANNEL_USERNAME || 'dunyotextil').replace(/^@/, '');
const DATA_FILE = path.join(__dirname, 'data.json');
const CODE_VALID_HOURS = 48;

function loadData() {
  if (!fs.existsSync(DATA_FILE)) return { users: {}, entries: [], pendingReferrals: {}, referrals: [] };
  const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  d.pendingReferrals = d.pendingReferrals || {};
  d.referrals = d.referrals || [];
  return d;
}
function saveData(d) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
}

// === Bir vaqtning o'zida bir nechta yangilanish kelganda ma'lumot
// yo'qolib qolmasligi uchun barcha o'zgartirishlar navbat bilan bajariladi ===
let writeQueue = Promise.resolve();
function serialize(fn) {
  const result = writeQueue.then(fn, fn);
  writeQueue = result.then(() => {}, () => {});
  return result;
}

function getMaxTries(data, uid) {
  const u = data.users[uid];
  return (u && u.maxTries) || 1;
}
function countEntries(data, uid) {
  return data.entries.filter(e => e.user_id === uid).length;
}
function canPlay(data, uid) {
  return countEntries(data, uid) < getMaxTries(data, uid);
}
function lastEntry(data, uid) {
  const list = data.entries.filter(e => e.user_id === uid);
  return list.length ? list[list.length - 1] : null;
}
function isToday(iso) {
  const d = new Date(iso), t = new Date();
  return d.toDateString() === t.toDateString();
}
function formatExpiry(iso) {
  const d = new Date(iso);
  return d.toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

async function tgApi(method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return res.json();
}

function referralLink(uid) {
  if (!BOT_USERNAME) return null;
  return `https://t.me/${BOT_USERNAME}?start=ref_${uid}`;
}
function referralShareUrl(uid) {
  const link = referralLink(uid);
  if (!link) return null;
  const text = "Men Dunyo Textile chegirma barabanida omadimni sinab ko'rdim — siz ham urinib ko'ring! 🎡";
  return `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`;
}

// === KANALGA A'ZOLIKNI TEKSHIRISH ===
async function isSubscribed(uid) {
  if (!CHANNEL_USERNAME) return true;
  try {
    const r = await tgApi('getChatMember', { chat_id: '@' + CHANNEL_USERNAME, user_id: Number(uid) });
    if (!r.ok) return false;
    const status = r.result.status;
    return ['member', 'administrator', 'creator'].includes(status);
  } catch (e) {
    return false;
  }
}
function subscribeGateKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "📢 @" + CHANNEL_USERNAME, url: `https://t.me/${CHANNEL_USERNAME}` }],
      [{ text: "✅ A'zo bo'ldim, tekshirish", callback_data: "check_sub" }]
    ]
  };
}
async function sendPlayButton(chatId) {
  await tgApi('sendMessage', {
    chat_id: chatId,
    text: "Ajoyib! Endi barabanni aylantirishingiz mumkin 🎉",
    reply_markup: {
      keyboard: [[{ text: "🎡 O'yinni boshlash", web_app: { url: APP_URL + "/game.html?" + GAME_VERSION } }]],
      resize_keyboard: true
    }
  });
}
async function sendAlreadyPlayed(chatId, data, uid) {
  const le = lastEntry(data, uid);
  await tgApi('sendMessage', {
    chat_id: chatId,
    text: `Siz allaqachon ishtirok etgansiz 🎯\nYutug'ingiz: ${le ? le.prize : '-'}${le && le.code ? '\nKod: ' + le.code : ''}`
  });
}

// === TELEGRAM WEBHOOK ===
app.post('/webhook', (req, res) => {
  if (WEBHOOK_SECRET && req.headers['x-telegram-bot-api-secret-token'] !== WEBHOOK_SECRET) {
    res.sendStatus(401);
    return;
  }
  res.sendStatus(200); // Telegram darhol javob talab qiladi

  serialize(async () => {
    const update = req.body;
    try {
      if (update.callback_query) {
        const cq = update.callback_query;
        const uid = String(cq.from.id);
        const chatId = cq.message.chat.id;
        if (cq.data === 'check_sub') {
          const ok = await isSubscribed(uid);
          if (ok) {
            await tgApi('answerCallbackQuery', { callback_query_id: cq.id, text: "Rahmat! ✅" });
            const data = loadData();
            if (data.users[uid] && !canPlay(data, uid)) {
              await sendAlreadyPlayed(chatId, data, uid);
            } else {
              await tgApi('sendMessage', {
                chat_id: chatId,
                text: "A'zolik tasdiqlandi! Endi telefon raqamingizni yuboring 👇",
                reply_markup: {
                  keyboard: [[{ text: "📱 Raqamni yuborish", request_contact: true }]],
                  resize_keyboard: true,
                  one_time_keyboard: true
                }
              });
            }
          } else {
            await tgApi('answerCallbackQuery', { callback_query_id: cq.id, text: "Hali kanalga a'zo bo'lmagansiz 🙏", show_alert: true });
          }
        }
        return;
      }

      const msg = update.message;
      if (!msg || !msg.from) return;
      const chatId = msg.chat.id;
      const uid = String(msg.from.id);
      const data = loadData();

      if (msg.text && msg.text.startsWith('/start')) {
        const parts = msg.text.trim().split(/\s+/);
        const payload = parts[1];
        if (payload && payload.startsWith('ref_')) {
          const referrerId = payload.slice(4);
          if (referrerId !== uid && !data.users[uid]) {
            data.pendingReferrals[uid] = referrerId;
            saveData(data);
          }
        }

        const subscribed = await isSubscribed(uid);
        if (!subscribed) {
          await tgApi('sendMessage', {
            chat_id: chatId,
            text: "Assalomu alaykum! 🎡\n\nBotdan foydalanish uchun avval kanalimizga a'zo bo'ling, so'ng \"Tekshirish\" tugmasini bosing 👇",
            reply_markup: subscribeGateKeyboard()
          });
          return;
        }

        if (data.users[uid] && !canPlay(data, uid)) {
          await sendAlreadyPlayed(chatId, data, uid);
          return;
        }

        await tgApi('sendMessage', {
          chat_id: chatId,
          text: "Assalomu alaykum! 🎡 Dunyo Textile chegirma barabaniga xush kelibsiz.\n\nDavom etish orqali siz telefon raqamingiz aksiya doirasida saqlanishiga roziligingizni bildirasiz.\n\nO'yinni boshlash uchun telefon raqamingizni yuboring 👇",
          reply_markup: {
            keyboard: [[{ text: "📱 Raqamni yuborish", request_contact: true }]],
            resize_keyboard: true,
            one_time_keyboard: true
          }
        });
        return;
      }

      if (msg.contact) {
        const subscribed = await isSubscribed(uid);
        if (!subscribed) {
          await tgApi('sendMessage', {
            chat_id: chatId,
            text: "Davom etishdan oldin kanalimizga a'zo bo'ling 👇",
            reply_markup: subscribeGateKeyboard()
          });
          return;
        }

        const isNewUser = !data.users[uid];
        const prevMaxTries = isNewUser ? 1 : getMaxTries(data, uid);

        data.users[uid] = {
          id: uid,
          first_name: msg.from.first_name || "",
          last_name: msg.from.last_name || "",
          username: msg.from.username || "",
          phone: msg.contact.phone_number,
          joined_at: data.users[uid] ? data.users[uid].joined_at : new Date().toISOString(),
          maxTries: prevMaxTries
        };

        if (isNewUser) {
          const referrerId = data.pendingReferrals[uid];
          if (referrerId && data.users[referrerId] && referrerId !== uid) {
            data.users[uid].referredBy = referrerId;
            data.users[referrerId].maxTries = getMaxTries(data, referrerId) + 1;
            data.referrals.push({ referrer: referrerId, invited: uid, date: new Date().toISOString() });

            tgApi('sendMessage', {
              chat_id: Number(referrerId),
              text: "🎉 Ajoyib! Do'stingiz taklifingiz orqali qo'shildi.\nSizga qo'shimcha +1 aylantirish imkoniyati berildi!",
              reply_markup: {
                keyboard: [[{ text: "🎡 O'yinni boshlash", web_app: { url: APP_URL + "/game.html?" + GAME_VERSION } }]],
                resize_keyboard: true
              }
            }).catch(() => {});
          }
          delete data.pendingReferrals[uid];
        }
        saveData(data);

        if (!canPlay(data, uid)) {
          await sendAlreadyPlayed(chatId, data, uid);
          return;
        }
        await sendPlayButton(chatId);
        return;
      }

      if (msg.web_app_data) {
        const subscribed = await isSubscribed(uid);
        if (!subscribed) {
          await tgApi('sendMessage', {
            chat_id: chatId,
            text: "Yutuqni qayd etishdan oldin kanalimizga a'zo bo'ling 👇",
            reply_markup: subscribeGateKeyboard()
          });
          return;
        }

        let payload;
        try { payload = JSON.parse(msg.web_app_data.data); } catch (e) { payload = {}; }

        // MUHIM: aylantirish natijasi odatda /record-spin orqali allaqachon
        // yozib qo'yilgan bo'ladi (foydalanuvchi ilovani qanday yopishidan
        // qat'i nazar). Shu yozuvni topamiz - agar topilmasa (masalan eski
        // versiya keshi tufayli), zaxira sifatida shu yerda yaratamiz.
        let entry = data.entries.find(e => e.user_id === uid && (
          (payload.code && e.code === payload.code) ||
          (!payload.code && e.type === 'retry' && e.prize === payload.label)
        ));

        if (!entry) {
          if (!canPlay(data, uid)) {
            await sendAlreadyPlayed(chatId, data, uid);
            return;
          }
          const user = data.users[uid] || { first_name: msg.from.first_name || "", phone: "noma'lum" };
          const expiresAt = new Date(Date.now() + CODE_VALID_HOURS * 3600 * 1000).toISOString();
          entry = {
            id: crypto.randomUUID(),
            user_id: uid,
            name: [user.first_name, user.last_name].filter(Boolean).join(" ") || msg.from.first_name || "Mijoz",
            phone: user.phone,
            username: user.username || "",
            prize: payload.label || "",
            code: payload.code || "",
            type: payload.type || "",
            date: new Date().toISOString(),
            expiresAt: payload.type === 'retry' ? null : expiresAt,
            used: false,
            usedAt: null
          };
          data.entries.push(entry);
          saveData(data);
        }

        let text, keyboard = [];
        if (entry.type === 'retry') {
          text = "Bu safar omad kulmadi 🙃 Lekin harakatingiz uchun rahmat!";
        } else {
          text = `Tabriklaymiz! 🎁 Yutuq: ${entry.prize}\nKod: ${entry.code}\nAmal qilish muddati: ${formatExpiry(entry.expiresAt)} gacha\n\nUshbu kodni kassada ko'rsating.`;
          if (CATALOG_URL) keyboard.push([{ text: "🛍 Katalogni ko'rish", url: CATALOG_URL }]);
        }
        const shareUrl = referralShareUrl(uid);
        if (shareUrl) keyboard.push([{ text: "🤝 Do'stni taklif qilish (+1 imkoniyat)", url: shareUrl }]);

        await tgApi('sendMessage', {
          chat_id: chatId,
          text,
          reply_markup: keyboard.length ? { inline_keyboard: keyboard } : undefined
        });
        return;
      }
    } catch (err) {
      console.error('webhook xatosi:', err);
    }
  });
});

// === O'yin sahifasi uchun yordamchi API'lar ===

app.get('/config', (req, res) => {
  res.json({ botUsername: BOT_USERNAME, catalogUrl: CATALOG_URL, channelUsername: CHANNEL_USERNAME });
});

app.get('/check', async (req, res) => {
  const uid = String(req.query.uid || '');
  const data = loadData();
  const subscribed = await isSubscribed(uid);
  const max = getMaxTries(data, uid);
  const used = countEntries(data, uid);
  const le = lastEntry(data, uid);
  res.json({
    subscribed,
    canPlay: subscribed && used < max,
    triesLeft: Math.max(0, max - used),
    maxTries: max,
    last: le ? { prize: le.prize, code: le.code, type: le.type, expiresAt: le.expiresAt } : null,
    referralLink: referralLink(uid)
  });
});

app.get('/stats', (req, res) => {
  const data = loadData();
  const todayEntries = data.entries.filter(e => isToday(e.date));
  const todayWinners = todayEntries.filter(e => e.type !== 'retry');
  res.json({
    totalParticipants: Object.keys(data.users).length,
    todayParticipants: todayEntries.length,
    todayWinners: todayWinners.length
  });
});

app.get('/recent-winners', (req, res) => {
  const data = loadData();
  const winners = data.entries
    .filter(e => e.type !== 'retry')
    .slice(-15)
    .reverse()
    .map(e => ({ name: (e.name || 'Mijoz').split(' ')[0], prize: e.prize }));
  res.json(winners);
});

// === MUHIM: aylantirish natijasini DARHOL yozib qo'yish ===
// Bu foydalanuvchi natijani ko'rgach mini-ilovani "Yopish" tugmasisiz,
// Telegram'ning o'z "Закрыть" tugmasi yoki svayp orqali yopib yuborsa ham,
// natija hisobga olinishini kafolatlaydi (aks holda qayta ochib
// cheksiz o'ynash mumkin bo'lib qolardi).
app.post('/record-spin', async (req, res) => {
  try {
    const result = await serialize(async () => {
      const { uid, type, label, code } = req.body || {};
      if (!uid) return { status: 400, body: { error: 'uid required' } };
      const uidStr = String(uid);

      const subscribed = await isSubscribed(uidStr);
      if (!subscribed) return { status: 403, body: { error: 'not subscribed' } };

      const data = loadData();
      if (!canPlay(data, uidStr)) {
        const le = lastEntry(data, uidStr);
        return { status: 200, body: { ok: true, alreadyPlayed: true, entry: le } };
      }

      const user = data.users[uidStr] || { first_name: '', phone: "noma'lum" };
      const expiresAt = type !== 'retry' ? new Date(Date.now() + CODE_VALID_HOURS * 3600 * 1000).toISOString() : null;
      const entry = {
        id: crypto.randomUUID(),
        user_id: uidStr,
        name: [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Mijoz',
        phone: user.phone,
        username: user.username || '',
        prize: label || '',
        code: code || '',
        type: type || '',
        date: new Date().toISOString(),
        expiresAt,
        used: false,
        usedAt: null
      };
      data.entries.push(entry);
      saveData(data);
      return { status: 200, body: { ok: true, entry } };
    });
    res.status(result.status).json(result.body);
  } catch (err) {
    console.error('record-spin xatosi:', err);
    res.status(500).json({ error: 'server error' });
  }
});

// === ADMIN LOGIN (HTTP Basic Auth - brauzer o'zi login oynasini chiqaradi) ===
function basicAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Basic ')) {
    const [user, pass] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
    if (user === ADMIN_USERNAME && pass === ADMIN_PASSWORD) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Dunyo Textile Admin"');
  res.status(401).send('Kirish uchun login va parol talab qilinadi.');
}

// === ADMIN PANEL ===
app.get('/admin', basicAuth, (req, res) => {
  const data = loadData();
  const rows = data.entries.slice().reverse().map(e => {
    const statusBadge = e.type === 'retry'
      ? '<span style="color:#8891c6;">—</span>'
      : (e.used
          ? '<span style="color:#3aa35a;font-weight:700;">✅ Ishlatilgan</span>'
          : '<span style="color:#d9b54a;font-weight:700;">● Faol</span>');
    const actionBtn = (e.type !== 'retry')
      ? `<a href="/admin/toggle-used?id=${e.id}" style="color:#f4efe0;background:#232a63;padding:5px 10px;border-radius:6px;text-decoration:none;font-size:11px;">${e.used ? "↩️ Bekor qilish" : "✅ Ishlatildi deb belgilash"}</a>`
      : '-';
    return `
    <tr>
      <td>${new Date(e.date).toLocaleString('uz-UZ')}</td>
      <td>${e.name || '-'}</td>
      <td>${e.phone || '-'}</td>
      <td>${e.username ? '@' + e.username : '-'}</td>
      <td>${e.prize}</td>
      <td>${e.code || '-'}</td>
      <td>${e.expiresAt ? formatExpiry(e.expiresAt) : '-'}</td>
      <td>${statusBadge}</td>
      <td>${actionBtn}</td>
    </tr>`;
  }).join('');

  res.send(`<!DOCTYPE html><html lang="uz"><head><meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin — Dunyo Textile</title>
  <style>
    body{font-family:system-ui,sans-serif;background:#0e1152;color:#f4f0e4;margin:0;padding:24px;}
    h1{font-size:20px;margin-bottom:18px;}
    .stat{display:inline-block;background:#1c2172;padding:10px 18px;border-radius:10px;margin-right:10px;margin-bottom:18px;font-size:14px;}
    .actions{margin-bottom:16px;}
    .actions a{color:#f4efe0;background:#1c2172;padding:9px 16px;border-radius:8px;text-decoration:none;font-size:13px;margin-right:8px;}
    table{width:100%;border-collapse:collapse;background:#181c66;border-radius:10px;overflow:hidden;font-size:13px;}
    th,td{padding:10px 12px;text-align:left;border-bottom:1px solid #2b306e;white-space:nowrap;}
    th{background:#131552;text-transform:uppercase;font-size:11px;letter-spacing:.05em;}
    tr:hover{background:#20256e;}
    .wrap{overflow-x:auto;}
  </style></head><body>
  <h1>Dunyo Textile — Baraban statistikasi</h1>
  <div class="stat">Jami ro'yxatdan o'tgan: <b>${Object.keys(data.users).length}</b></div>
  <div class="stat">Jami aylantirish: <b>${data.entries.length}</b></div>
  <div class="stat">Referal orqali qo'shilgan: <b>${data.referrals.length}</b></div>
  <div class="actions">
    <a href="/admin/export.csv">📥 Excel (CSV) yuklab olish</a>
  </div>
  <div class="wrap">
  <table>
    <tr><th>Sana</th><th>Ism</th><th>Telefon</th><th>Username</th><th>Yutuq</th><th>Kod</th><th>Kod muddati</th><th>Holati</th><th>Amal</th></tr>
    ${rows || '<tr><td colspan="9">Hali ma\'lumot yo\'q</td></tr>'}
  </table>
  </div>
  </body></html>`);
});

app.get('/admin/toggle-used', basicAuth, (req, res) => {
  const id = req.query.id;
  const data = loadData();
  const e = data.entries.find(x => x.id === id);
  if (e) {
    e.used = !e.used;
    e.usedAt = e.used ? new Date().toISOString() : null;
    saveData(data);
  }
  res.redirect('/admin');
});

app.get('/admin/export.csv', basicAuth, (req, res) => {
  const data = loadData();
  const header = ['Sana', 'Ism', 'Telefon', 'Username', 'Yutuq', 'Kod', 'Kod muddati', 'Holati'];
  function esc(v) {
    v = String(v ?? '');
    if (/[",\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
    return v;
  }
  const rows = data.entries.map(e => [
    new Date(e.date).toLocaleString('uz-UZ'),
    e.name || '',
    e.phone || '',
    e.username ? '@' + e.username : '',
    e.prize || '',
    e.code || '',
    e.expiresAt ? formatExpiry(e.expiresAt) : '',
    e.type === 'retry' ? '-' : (e.used ? 'Ishlatilgan' : 'Faol')
  ]);
  const csv = [header, ...rows].map(r => r.map(esc).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="dunyo-textile-statistika.csv"');
  res.send('\uFEFF' + csv); // BOM - Excel'da o'zbekcha harflar to'g'ri chiqishi uchun
});

app.get('/', (req, res) => res.send('Bot serveri ishlayapti ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port', PORT));
