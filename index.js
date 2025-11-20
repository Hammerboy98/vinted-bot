const axios = require("axios");
const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const fs = require("fs");
require("dotenv").config();

// === CONFIG ===
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const PORT = process.env.PORT || 3000;

// === LETTURA KEYWORDS DA FILE JSON ===
let KEYWORDS = [];
try {
  const data = fs.readFileSync("keywords.json", "utf8");
  const json = JSON.parse(data);
  KEYWORDS = json.keywords || [];
} catch (err) {
  console.log(
    "⚠️ Nessun file keywords.json trovato o errore di lettura, uso array vuoto."
  );
}

console.log("🔑 Keywords iniziali:", KEYWORDS);

// === TELEGRAM BOT (polling) ===
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Messaggio di test + keywords all'avvio
const startMessage =
  KEYWORDS.length > 0
    ? `🟢 PokéBot attivo!\n🔑 Sto monitorando le seguenti keywords:\n• ${KEYWORDS.join(
        "\n• "
      )}`
    : "🟢 PokéBot attivo!\n⚠️ Nessuna keyword impostata.";

bot.sendMessage(CHAT_ID, startMessage);

// === SET PER EVITARE DUPLICATI ===
let notifiedLinks = new Set();
let isRunning = false;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// === FUNZIONE PER CERCARE SU VINTED ===
async function searchVinted(keyword) {
  const url = "https://www.vinted.it/api/v2/catalog/items";
  const params = {
    search_text: keyword,
    catalog_ids: 1885,
    per_page: 20,
    page: 1,
    order: "newest_first",
  };

  try {
    const res = await axios.get(url, {
      params,
      timeout: 10000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36",
        Accept: "application/json",
      },
    });

    return res.data.items || [];
  } catch (err) {
    console.error(
      `❌ Errore ${err.response?.status || ""} durante la ricerca "${keyword}"`
    );
    return [];
  }
}

// === FUNZIONE PRINCIPALE ===
async function checkVinted() {
  if (isRunning) return;
  isRunning = true;

  console.log("🔍 Controllo Vinted…");

  for (let keyword of KEYWORDS) {
    await bot.sendMessage(
      CHAT_ID,
      `🔎 Sto cercando articoli per: *${keyword}*`,
      {
        parse_mode: "Markdown",
      }
    );

    const items = await searchVinted(keyword);
    console.log(`✅ Trovati ${items.length} articoli per "${keyword}"`);

    for (const item of items) {
      const link = `https://www.vinted.it/items/${item.id}`;
      const title = item.title.toLowerCase();
      const desc = (item.description || "").toLowerCase();

      if (!title.includes(keyword) && !desc.includes(keyword)) continue;
      if (notifiedLinks.has(link)) continue;

      notifiedLinks.add(link);

      const price = item.price;
      const photo = item.photo?.url;

      await bot.sendMessage(
        CHAT_ID,
        `✨ *Nuovo articolo trovato!*\n📛 *${item.title}*\n💶 Prezzo: ${price}€\n🔗 ${link}`,
        { parse_mode: "Markdown" }
      );

      if (photo) await bot.sendPhoto(CHAT_ID, photo);
      console.log("📨 Notificato:", item.title);
    }

    await delay(2500);
  }

  isRunning = false;
}

// === PULIZIA DUPLICATI OGNI 8 ORE ===
setInterval(() => {
  notifiedLinks.clear();
  console.log("🧹 Pulizia notifiche.");
}, 8 * 60 * 60 * 1000);

// === CONTROLLI PERIODICI ===
setInterval(checkVinted, 15 * 60 * 1000); // ogni 15 minuti
setTimeout(checkVinted, 5000); // primo check dopo 5s

// =========================================================
// 🔧 COMANDI TELEGRAM DINAMICI
// =========================================================

// ➕ /add keyword
bot.onText(/\/add (.+)/, (msg, match) => {
  const newKeyword = match[1].toLowerCase().trim();
  if (!KEYWORDS.includes(newKeyword)) {
    KEYWORDS.push(newKeyword);
    fs.writeFileSync(
      "keywords.json",
      JSON.stringify({ keywords: KEYWORDS }, null, 2)
    );
    bot.sendMessage(msg.chat.id, `💾 Keyword aggiunta: *${newKeyword}*`, {
      parse_mode: "Markdown",
    });
  } else {
    bot.sendMessage(
      msg.chat.id,
      `⚠️ La keyword *${newKeyword}* è già presente.`,
      { parse_mode: "Markdown" }
    );
  }
});

// 📜 /list → mostra tutte le keyword
bot.onText(/\/list/, (msg) => {
  if (KEYWORDS.length === 0) {
    bot.sendMessage(msg.chat.id, "📭 Nessuna keyword salvata.");
    return;
  }
  const list = KEYWORDS.map((k) => `• ${k}`).join("\n");
  bot.sendMessage(msg.chat.id, `📜 *Lista keyword attuali:*\n\n${list}`, {
    parse_mode: "Markdown",
  });
});

// ❌ /remove keyword
bot.onText(/\/remove (.+)/, (msg, match) => {
  const keyword = match[1].toLowerCase().trim();
  if (!KEYWORDS.includes(keyword)) {
    return bot.sendMessage(
      msg.chat.id,
      `❌ Keyword *${keyword}* non trovata.`,
      { parse_mode: "Markdown" }
    );
  }
  KEYWORDS = KEYWORDS.filter((k) => k !== keyword);
  fs.writeFileSync(
    "keywords.json",
    JSON.stringify({ keywords: KEYWORDS }, null, 2)
  );
  bot.sendMessage(msg.chat.id, `🗑️ Keyword rimossa: *${keyword}*`, {
    parse_mode: "Markdown",
  });
});

// === SERVER EXPRESS PER MONITORING ===
const app = express();
app.get("/", (_, res) => res.send("PokéBot attivo e funzionante!"));
app.listen(PORT, () => console.log(`Server su porta ${PORT}`));
