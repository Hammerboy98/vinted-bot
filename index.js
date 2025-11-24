const axios = require("axios");
const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const fs = require("fs");
require("dotenv").config(); // <--- Questa riga è CRUCIALE

// ⭐ CONFIGURAZIONE ORA LEGGE DA .ENV ⭐
let VINTED_COOKIE_STRING = process.env.VINTED_COOKIE_STRING;

// ⭐ NUOVA PULIZIA AGGRESSIVA CONTRO I CARATTERI INVALIDI ⭐
if (VINTED_COOKIE_STRING) {
  // 1. Rimuove caratteri non validi: Mantiene solo lettere, numeri, _, -, =, :, ;, / e punti
  VINTED_COOKIE_STRING = VINTED_COOKIE_STRING.replace(
    /[^a-zA-Z0-9_\-=:,;\/.\s]/g,
    ""
  ) // Rimuove tutto ciò che non è un carattere valido per un cookie
    .replace(/[\n\r]/g, "") // Rimuove a capo/ritorno carrello
    .trim(); // Rimuove spazi vuoti iniziali e finali
}
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const PORT = process.env.PORT || 3000;

// === COSTANTI AGGIUNTIVE ===
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
// ... il resto del codice ...

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

// === TELEGRAM BOT SETUP ===
const bot = new TelegramBot(TELEGRAM_TOKEN);

async function startBotPolling() {
  try {
    // Cancella webhook e forza il polling
    await bot.setWebHook("");
    console.log("✅ Webhook Telegram cancellato, avvio polling...");
    await new Promise((resolve) => setTimeout(resolve, 2000));
    bot.startPolling();
  } catch (err) {
    console.error("❌ Errore avvio polling:", err.message);
  }
}

startBotPolling();

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
 */
function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1) + min);
}

// 🛡️ FUNZIONE API CON HEADERS E COOKIE AGGIORNATI
async function searchVinted(keyword) {
  const url = "https://www.vinted.it/api/v2/catalog/items";
  const params = {
    search_text: keyword,
  };

  try {
    const res = await axios.get(url, {
      params,
      timeout: 10000,
      headers: {
        "User-Agent": USER_AGENT,
        // Accept corretto per l'API JSON
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
        Referer: "https://www.vinted.it/",
        Connection: "keep-alive",
        // ⭐ COOKIE CRITICO AGGIUNTO QUI ⭐
        Cookie: VINTED_COOKIE_STRING,
      },
    });

    return res.data.items || [];
  } catch (err) {
    if (err.response) {
      console.error(
        `❌ Errore ${err.response.status} durante la ricerca API per "${keyword}"`
      );
      if (err.response.status === 403) {
        console.error(`🛑 BLOCCO 403 RILEVATO. Riprova più tardi.`);
      } else if (err.response.status === 401) {
        console.error(
          `🛑 BLOCCO 401 RILEVATO. **Il Cookie di sessione è scaduto o non valido**. Devi aggiornare la costante VINTED_COOKIE_STRING.`
        );
      }
    } else {
      console.error(
        `❌ Errore durante la ricerca API "${keyword}":`,
        err.message
      );
    }
    return [];
  }
}

// === FUNZIONE PRINCIPALE DI CONTROLLO ===
async function checkVinted() {
  if (isRunning) return;
  isRunning = true;

  console.log("🔍 Controllo Vinted…");

  for (let keyword of KEYWORDS) {
    const items = await searchVinted(keyword);

    if (items.length === 0) {
      console.log(`✅ Trovati 0 articoli per "${keyword}"`);
    }

    for (const item of items) {
      // ⭐ CORREZIONE: COSTRUIAMO URL E PREZZO CORRETTAMENTE ⭐
      const articleId = item.id;
      const link = `https://www.vinted.it/items/${articleId}`;
      const title = item.title.toLowerCase();

      // Vinted price è una stringa, usiamo item.price
      const price = item.price; // Esempio: "15.00"

      // Controllo se il titolo contiene la keyword e se il link è già stato notificato
      if (!title.includes(keyword) || notifiedLinks.has(link)) continue;

      notifiedLinks.add(link);

      // ⭐ MESSAGGIO TELEGRAM CORRETTO CON PREZZO E LINK ⭐
      await bot.sendMessage(
        CHAT_ID,
        `✨ **Nuovo Articolo Trovato!**\n🔎 Keyword: ${keyword}\n\n📛 *${item.title}*\n\n💰 **Prezzo:** ${price} €\n\n🔗 ${link}`,
        {
          parse_mode: "Markdown",
          disable_web_page_preview: false, // Lascia attiva l'anteprima del link
        }
      );

      console.log("📨 Notificato:", item.title);
    }

    // Ritardo casuale tra 10 e 20 secondi tra una keyword e l'altra
    const waitTime = randomDelay(10000, 20000);
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

// ⏰ LOGICA RIVISTA: Ciclo imprevedibile e lento per evitare il blocco 403
async function startVintedLoop() {
  // Esegui il controllo una volta subito
  checkVinted();

  while (true) {
    // Ritardo principale: aspetta tra 10 minuti (600000ms) e 60 minuti (3600000ms)
    const loopWaitTime = randomDelay(600000, 3600000);

    console.log(
      `--- CICLO COMPLETATO. Prossimo controllo tra ${(
        loopWaitTime / 60000
      ).toFixed(1)} minuti. ---`
    );
    await delay(loopWaitTime);

    await checkVinted();
  }
}

// Avvia il ciclo principale
startVintedLoop();

// === PULIZIA DUPLICATI OGNI 8 ORE ===
setInterval(() => {
  notifiedLinks.clear();
  console.log("🧹 Pulizia notifiche.");
}, 8 * 60 * 60 * 1000);

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

// === SERVER PER MONITORING ===
const app = express();
app.get("/", (_, res) => res.send("PokéBot attivo con comandi dinamici."));
app.listen(PORT, () => console.log(`Server su porta ${PORT}`));
