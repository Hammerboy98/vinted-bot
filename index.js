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

// === TELEGRAM BOT ===
const bot = new TelegramBot(TELEGRAM_TOKEN);

// Funzione per forzare polling senza 409
async function startBotPolling() {
  try {
    // 1️⃣ Cancella webhook se presente
    await bot.setWebHook("");
    console.log("✅ Webhook Telegram cancellato, avvio polling...");

    // 2️⃣ Aspetta 2 secondi prima di iniziare il polling
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // 3️⃣ Avvia il polling
    bot.startPolling();
  } catch (err) {
    console.error("❌ Errore avvio polling:", err.message);
  }
}

startBotPolling();

// Messaggio di avvio con keywords
const keywordMessage =
  KEYWORDS.length > 0
    ? `🟢 PokéBot attivo!\n🔑 Keyword attuali:\n• ${KEYWORDS.join("\n• ")}`
    : "🟢 PokéBot attivo!\n⚠️ Nessuna keyword impostata.";

bot.sendMessage(CHAT_ID, keywordMessage);

// === UTILITIES PER RITARDI E DUPLICATI ===
let notifiedLinks = new Set();
let isRunning = false;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Genera un ritardo in millisecondi tra un valore minimo e massimo.
 * @param {number} min - Ritardo minimo (ms).
 * @param {number} max - Ritardo massimo (ms).
 */
function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1) + min);
}

// === API VINTED con User-Agent e Headers aggiornati ===
async function searchVinted(keyword) {
  const url = "https://www.vinted.it/api/v2/catalog/items";
  const params = {
    search_text: keyword,
    // 1885 sembra essere un ID per le carte collezionabili (Collezionismo)
    catalog_ids: 1885,
    per_page: 20,
    page: 1,
    order: "newest_first",
  };

  try {
    const res = await axios.get(url, {
      params,
      timeout: 7000,
      headers: {
        // User-Agent aggiornato a una versione recente di Chrome (Cambia questo periodicamente se serve)
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
        // Aggiunto l'header Accept-Language per simulare un browser italiano
        "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
      },
    });
    return res.data.items || [];
  } catch (err) {
    if (err.response) {
      console.error(
        `❌ Errore ${err.response.status} durante la ricerca "${keyword}"`
      );
      // Logga la risposta per debug se il codice non è 403
      if (err.response.status !== 403) {
        console.error(
          `Risposta completa: ${JSON.stringify(err.response.data)}`
        );
      }
    } else {
      console.error(`❌ Errore durante la ricerca "${keyword}":`, err.message);
    }
    return [];
  }
}

// === FUNZIONE PRINCIPALE (Aggiunto Ritardo Randomizzato) ===
async function checkVinted() {
  if (isRunning) return;
  isRunning = true;

  console.log("🔍 Controllo Vinted…");

  for (let keyword of KEYWORDS) {
    // Nota: Il messaggio viene inviato ogni volta, potresti volerlo rimuovere per non spammare Telegram
    /*
    await bot.sendMessage(
      CHAT_ID,
      `🔎 Cerco articoli per la keyword: *${keyword}*`,
      { parse_mode: "Markdown" }
    );
    */

    const items = await searchVinted(keyword);

    if (items.length === 0) {
      console.log(`✅ Trovati 0 articoli per "${keyword}"`);
    }

    for (const item of items) {
      const link = `https://www.vinted.it/items/${item.id}`;
      const title = item.title.toLowerCase();
      const desc = (item.description || "").toLowerCase();

      // Controllo se la keyword è nel titolo o descrizione E non è un duplicato
      if (
        (!title.includes(keyword) && !desc.includes(keyword)) ||
        notifiedLinks.has(link)
      )
        continue;

      notifiedLinks.add(link);

      const price = item.price;
      const photo = item.photo?.url;

      await bot.sendMessage(
        CHAT_ID,
        `✨ *Nuova carta trovata!*\n🔎 Keyword: ${keyword}\n📛 *${item.title}*\n💶 Prezzo: ${price}€\n🔗 ${link}`,
        { parse_mode: "Markdown" }
      );

      if (photo) bot.sendPhoto(CHAT_ID, photo);
      console.log("📨 Notificato:", item.title);
    }

    // ⬇️ MODIFICA CHIAVE: Ritardo casuale tra 5 e 10 secondi (5000ms a 10000ms)
    const waitTime = randomDelay(5000, 10000);
    console.log(
      `⏳ Attendo ${
        waitTime / 1000
      } secondi prima di cercare la prossima keyword...`
    );
    await delay(waitTime);
  }

  isRunning = false;
  console.log("✅ Ciclo di controllo Vinted completato.");
}

// === PULIZIA DUPLICATI OGNI 8 ORE ===
setInterval(() => {
  notifiedLinks.clear();
  console.log("🧹 Pulizia notifiche.");
}, 8 * 60 * 60 * 1000);

// === CONTROLLI PERIODICI ===
// Il ciclo completo avviene ogni 15 minuti, ma ora le pause interne sono più lunghe.
setInterval(checkVinted, 15 * 60 * 1000);
setTimeout(checkVinted, 10 * 1000);

// =========================================================
// 🔧 COMANDI TELEGRAM DINAMICI (Nessuna modifica qui)
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

// === SERVER PER MONITORING ===
const app = express();
app.get("/", (_, res) => res.send("PokéBot attivo con comandi dinamici."));
app.listen(PORT, () => console.log(`Server su porta ${PORT}`));
