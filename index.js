const axios = require("axios");
const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const fs = require("fs");
require("dotenv").config();

// === CONFIG ===
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

// === CARICAMENTO KEYWORDS DA FILE ===
function loadKeywords() {
  if (!fs.existsSync("keywords.json")) {
    fs.writeFileSync(
      "keywords.json",
      JSON.stringify({ keywords: [] }, null, 2)
    );
  }
  const data = JSON.parse(fs.readFileSync("keywords.json"));
  return data.keywords;
}

function saveKeywords(list) {
  fs.writeFileSync(
    "keywords.json",
    JSON.stringify({ keywords: list }, null, 2)
  );
}

// Keywords dinamiche
let KEYWORDS = loadKeywords();

console.log("🔑 Keywords caricate:", KEYWORDS);

// === TELEGRAM BOT ===
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
bot.sendMessage(CHAT_ID, "🟡 PokéBot attivo con comandi dinamici!");

// === SET PER EVITARE DUPLICATI ===
let notifiedLinks = new Set();
let isRunning = false;

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// === API VINTED ===
async function searchVinted(keyword) {
  const url = "https://www.vinted.it/api/v2/catalog/items";
  const params = {
    search_text: keyword,
    catalog_ids: 1885,
    per_page: 20,
    page: 1,
    order: "newest_first",
  };

  const res = await axios.get(url, {
    params,
    timeout: 7000,
    headers: { "User-Agent": "Mozilla/5.0" },
  });

  return res.data.items || [];
}

// === MAIN CHECK FUNCTION ===
async function checkVinted() {
  if (isRunning) return;
  isRunning = true;

  console.log("🔍 Controllo Vinted…");

  try {
    for (let keyword of KEYWORDS) {
      const items = await searchVinted(keyword);

      for (const item of items) {
        const link = `https://www.vinted.it/items/${item.id}`;
        const title = item.title.toLowerCase();
        const desc = (item.description || "").toLowerCase();

        if (
          !title.includes(keyword.toLowerCase()) &&
          !desc.includes(keyword.toLowerCase())
        )
          continue;

        if (notifiedLinks.has(link)) continue;
        notifiedLinks.add(link);

        const price = item.price;
        const photo = item.photo?.url;

        await bot.sendMessage(
          CHAT_ID,
          `✨ *Nuova carta trovata!*\n📛 *${item.title}*\n💶 Prezzo: ${price}€\n🔗 ${link}`,
          { parse_mode: "Markdown" }
        );

        if (photo) bot.sendPhoto(CHAT_ID, photo);
        console.log("📨 Notificato:", item.title);
      }

      await delay(2500);
    }
  } catch (err) {
    console.error("❌ Errore:", err.message);
  } finally {
    isRunning = false;
  }
}

// === PULIZIA OGNI 8 ORE ===
setInterval(() => {
  notifiedLinks.clear();
  console.log("🧹 Pulizia notifiche.");
}, 8 * 60 * 60 * 1000);

// === CONTROLLI PERIODICI ===
setInterval(checkVinted, 15 * 60 * 1000);
setTimeout(checkVinted, 10 * 1000);

// =========================================================
// 🔧 COMANDI TELEGRAM DINAMICI
// =========================================================

// ➕ /add keyword1 keyword2 keyword3...
bot.onText(/\/add (.+)/, (msg, match) => {
  const input = match[1].toLowerCase().trim();
  const parts = input.split(" ");

  const newKeyword = parts.join(" ");
  if (!KEYWORDS.includes(newKeyword)) {
    KEYWORDS.push(newKeyword);
    saveKeywords(KEYWORDS);
    bot.sendMessage(msg.chat.id, `💾 Keyword aggiunta: *${newKeyword}*`, {
      parse_mode: "Markdown",
    });
  } else {
    bot.sendMessage(
      msg.chat.id,
      `⚠️ La keyword *${newKeyword}* è già presente.`,
      {
        parse_mode: "Markdown",
      }
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
      {
        parse_mode: "Markdown",
      }
    );
  }

  KEYWORDS = KEYWORDS.filter((k) => k !== keyword);
  saveKeywords(KEYWORDS);

  bot.sendMessage(msg.chat.id, `🗑️ Keyword rimossa: *${keyword}*`, {
    parse_mode: "Markdown",
  });
});

// === SERVER PER RENDER ===
const app = express();
const port = process.env.PORT || 3000;
app.get("/", (_, res) => res.send("PokéBot attivo con comandi dinamici."));
app.listen(port, () => console.log(`Server su porta ${port}`));
