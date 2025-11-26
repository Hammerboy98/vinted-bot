const axios = require("axios");
const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const fs = require("fs");
require("dotenv").config();

// ⭐ CONFIGURAZIONE ORA LEGGE DA .ENV (RENDER) ⭐
const VINTED_COOKIE_STRING = process.env.VINTED_COOKIE_STRING;
const VINTED_ANON_ID = process.env.VINTED_ANON_ID;
const VINTED_CSRF_TOKEN = process.env.VINTED_CSRF_TOKEN;

// ⭐ CONTROLLO ESSENZIALE ALL'AVVIO ⭐
if (
  !process.env.TELEGRAM_TOKEN ||
  !process.env.CHAT_ID ||
  !VINTED_COOKIE_STRING ||
  !VINTED_CSRF_TOKEN
) {
  console.error(
    "🛑 Variabili d'ambiente TOKEN, CHAT_ID, COOKIE o CSRF MANCANTI. Impossibile avviare il bot."
  ); // Non usiamo process.exit(1) per non bloccare Render in caso di Webhook setup
}

// ⭐ NUOVA PULIZIA AGGRESSIVA CONTRO I CARATTERI INVALIDI ⭐
// Eseguita direttamente sulla variabile VINTED_COOKIE_STRING
let cleanedCookie = VINTED_COOKIE_STRING;
if (cleanedCookie) {
  // 1. Rimuove caratteri non validi: Mantiene solo lettere, numeri, _, -, =, :, ;, / e punti
  cleanedCookie = cleanedCookie
    .replace(/[^a-zA-Z0-9_\-=:,;\/.\s]/g, "") // Rimuove tutto ciò che non è un carattere valido per un cookie
    .replace(/[\n\r]/g, "") // Rimuove a capo/ritorno carrello
    .trim(); // Rimuove spazi vuoti iniziali e finali
}

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const PORT = process.env.PORT || 3000;

// === COSTANTI AGGIUNTIVE ===
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

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
//namo
// === TELEGRAM BOT SETUP ===
// Imposta il bot in modalità Webhook (necessario per Render)
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

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
    search_text: keyword, // Aggiungiamo un filtro per l'ordine in modo da vedere gli articoli più recenti
    order: "newest",
  }; // Se mancano i token essenziali, saltiamo la ricerca API per evitare 401

  if (!cleanedCookie || !VINTED_CSRF_TOKEN) {
    console.error(
      "🛑 SALTO RICERCA API: Cookie o CSRF token non impostati o non validi."
    );
    return [];
  }

  try {
    const res = await axios.get(url, {
      params,
      timeout: 10000,
      headers: {
        "User-Agent": USER_AGENT, // Accept corretto per l'API JSON
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
        Referer: "https://www.vinted.it/",
        Connection: "keep-alive", // ⭐ COOKIE CRITICO AGGIUNTO QUI (PULITO) ⭐

        Cookie: cleanedCookie, // ⭐ NUOVI HEADER ESSENZIALI (come visti nel log 200) ⭐

        "X-Anon-Id": VINTED_ANON_ID,
        "X-CSRF-Token": VINTED_CSRF_TOKEN,
        "X-Money-Object": "true",
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
          `🛑 BLOCCO 401 RILEVATO. **Il Cookie di sessione/CSRF è scaduto o non valido**. Devi aggiornare le variabili d'ambiente.`
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
      // ⭐ ESTRAZIONE DATI UTILI, INCLUSO IL LINK DELL'IMMAGINE ⭐
      const articleId = item.id;
      const link = `https://www.vinted.it/items/${articleId}`; // Vinted price è una stringa (es. "15.00"), usiamo item.price
      const price = item.price || "N/D";
      const imageUrl = item.photo ? item.photo.url : null; // Controllo se il link è già stato notificato

      if (notifiedLinks.has(link)) continue;

      notifiedLinks.add(link); // ⭐ COSTRUZIONE DEL MESSAGGIO E INVIO FOTO ⭐

      const caption = `
✨ **Nuovo Articolo Trovato!**
🔎 Keyword: ${keyword}

📛 *${item.title}*

💰 **Prezzo:** ${price} €

🔗 [Vedi su Vinted](${link})`;

      try {
        if (imageUrl) {
          // Invio come Foto se l'URL è disponibile
          await bot.sendPhoto(CHAT_ID, imageUrl, {
            caption: caption.trim(),
            parse_mode: "Markdown",
          });
        } else {
          // Fallback a messaggio normale se l'immagine manca
          await bot.sendMessage(CHAT_ID, caption.trim(), {
            parse_mode: "Markdown",
            disable_web_page_preview: false,
          });
        }
        console.log("📨 Notificato:", item.title);
      } catch (e) {
        console.error("❌ Errore invio messaggio Telegram:", e.message);
      }
    } // Ritardo casuale tra 10 e 20 secondi tra una keyword e l'altra

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

// ⏰ LOGICA MODIFICATA: Ciclo FISSO ogni 15 minuti (900.000 ms)
async function startVintedLoop() {
  // Esegui il controllo una volta subito
  checkVinted(); // 15 minuti in millisecondi

  const FIFTEEN_MINUTES_MS = 900000;

  while (true) {
    // Ritardo principale: attende 15 minuti esatti.
    const loopWaitTime = FIFTEEN_MINUTES_MS;

    console.log(
      `--- CICLO COMPLETATO. Prossimo controllo tra ${
        loopWaitTime / 60000
      } minuti. ---`
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
// ⭐ CONFIGURAZIONE WEBHOOK (Per eliminare l'errore 409)
// =========================================================
const app = express();
app.use(express.json()); // Middleware per leggere i dati JSON

const externalUrl = process.env.RENDER_EXTERNAL_URL;

if (externalUrl) {
  // 1. Configura il Webhook su Telegram
  const webhookUrl = `${externalUrl}/bot${TELEGRAM_TOKEN}`;
  bot
    .setWebHook(webhookUrl)
    .then(() => {
      console.log(`✅ Webhook impostato su: ${webhookUrl}`);
    })
    .catch((err) => {
      console.error("❌ Errore impostazione Webhook:", err.message);
    }); // 2. Endpoint per ricevere i messaggi da Telegram

  app.post(`/bot${TELEGRAM_TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  }); // 3. Server per monitoraggio (Health Check)

  app.get("/", (_, res) => res.send("PokéBot attivo tramite Webhook."));
} else {
  // Fallback locale (questa parte non dovrebbe essere eseguita su Render)
  console.log("⚠️ Variabile RENDER_EXTERNAL_URL non trovata. Avvio Pollingg.");
  bot.startPolling();
  app.get("/", (_, res) => res.send("PokéBot attivo con Polling."));
}

// Avvia il server Express
app.listen(PORT, () => console.log(`Server su porta ${PORT}`));

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
  bot.sendMessage(msg.chat.id, `🗑️ Keyword rimossaa: *${keyword}*`, {
    parse_mode: "Markdown",
  });
});
