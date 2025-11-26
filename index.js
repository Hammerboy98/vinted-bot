const axios = require("axios");
const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const fs = require("fs");
//require("dotenv").config();

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
    "🛑 vVariabili d'ambiente TOKEN, CHAT_ID, COOKIE o CSRF MANCANTI. Impossibile avviare il bot."
  );
}

// ⭐ NUOVA PULIZIA AGGRESSIVA CONTRO I CARATTERI INVALIDI ⭐
let cleanedCookie = VINTED_COOKIE_STRING;
if (cleanedCookie) {
  // 1. Rimuove caratteri non validi: Mantiene solo lettere, numeri, _, -, =, :, ;, / e punti
  cleanedCookie = cleanedCookie
    .replace(/[^a-zA-Z0-9_\-=:,;\/.\s]/g, "")
    .replace(/[\n\r]/g, "")
    .trim();
}

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const PORT = process.env.PORT || 3000;

// === COSTANTI AGGIUNTIVE ===
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

// === LETTURA KEYWORDS DA FILE JSON (ORA ARRAY DI OGGETTI) ===
let KEYWORDS_CONFIG = [];
try {
  const data = fs.readFileSync("keywords.json", "utf8");
  const json = JSON.parse(data);
  // La struttura json.keywords dovrebbe essere: [{search: "...", must_contain: [...]}, ...]
  KEYWORDS_CONFIG = json.keywords || [];
} catch (err) {
  console.log(
    "⚠️ Nessun file keywords.json trovato o errore di lettura, uso array vuoto. Errore:",
    err.message
  );
}

console.log(
  "🔑 Keywords iniziali (ricerca):",
  KEYWORDS_CONFIG.map((k) => k.search || "N/A")
);

// === TELEGRAM BOT SETUP ===
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
    search_text: keyword,
    // Possibile aggiungere filtri qui per categoria/condizione se necessario, ma partiamo dal testo
  };

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
        "User-Agent": USER_AGENT,
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
        Referer: "https://www.vinted.it/",
        Connection: "keep-alive",

        // ⭐ COOKIE CRITICO AGGIUNTO QUI (PULITO) ⭐
        Cookie: cleanedCookie,

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
      if (err.response.status === 401) {
        console.error(
          `🛑 BLOCCO 401 RILEVATO. **Il Cookie di sessione/CSRF è scaduto o non valido**.`
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

// === FUNZIONE PRINCIPALE DI CONTROLLO CON FILTRO AGGRESSIVO ===
async function checkVinted() {
  if (isRunning) return;
  isRunning = true;

  console.log("🔍 Controllo Vinted…");

  // Itera sulla configurazione delle keyword (che ora sono oggetti)
  for (let config of KEYWORDS_CONFIG) {
    const keyword = config.search;
    // mustContain: Array di parole chiave che DEVONO essere presenti nel risultato (logica AND)
    const mustContain = config.must_contain || [];

    const items = await searchVinted(keyword);

    if (items.length === 0) {
      console.log(`✅ Trovati 0 articoli per "${keyword}"`);
    }

    // ⭐ NUOVO: CICLO DI FILTRAGGIO AGGRESSIVO ⭐
    for (const item of items) {
      const articleId = item.id;
      const link = `https://www.vinted.it/items/${articleId}`;

      // Combiniamo titolo e descrizione in minuscolo per la verifica
      const searchContent = `${item.title} ${item.description}`.toLowerCase();

      // Controllo di coerenza: l'articolo DEVE contenere TUTTE le parole in 'mustContain'
      const isRelevant = mustContain.every((word) =>
        searchContent.includes(word)
      );

      if (!isRelevant) {
        // Articolo non pertinente (manca una delle parole chiave essenziali filtrate)
        continue;
      }

      // Controllo anti-duplicato
      if (notifiedLinks.has(link)) continue;

      notifiedLinks.add(link);

      // ⭐ MESSAGGIO TELEGRAM CORRETTO CON PREZZO E LINK ⭐
      const price = item.price;
      const photoUrl = item.photo ? item.photo.url : null;

      const caption = `✨ **Nuovo Articolo Trovato!**\n🔎 Keyword di Ricerca: ${keyword}\n\n📛 *${item.title}*\n\n💰 **Prezzo:** ${price} €\n\n🔗 [Vedi Articolo](${link})`;

      if (photoUrl) {
        try {
          await bot.sendPhoto(CHAT_ID, photoUrl, {
            caption: caption,
            parse_mode: "Markdown",
          });
          console.log("📨 Notificato con Foto:", item.title);
        } catch (e) {
          console.error("❌ Errore invio foto Telegram:", e.message);
          // Fallback
          await bot.sendMessage(CHAT_ID, caption, { parse_mode: "Markdown" });
        }
      } else {
        // Se la foto non è disponibile
        await bot.sendMessage(CHAT_ID, caption, { parse_mode: "Markdown" });
        console.log("📨 Notificato (solo testo):", item.title);
      }
    } // fine for (item)

    // Ritardo casuale tra una keyword e l'altra
    const waitTime = randomDelay(10000, 20000);
    console.log(
      `⏳ Attendo ${
        waitTime / 1000
      } secondi prima di cercare la prossima keyword...`
    );
    await delay(waitTime);
  } // fine for (config)

  isRunning = false;
  console.log("✅ Ciclo di controllo Vinted completato.");
}

// ⏰ LOGICA MODIFICATA: Ciclo FISSO ogni 15 minuti (900.000 ms)
async function startVintedLoop() {
  // Esegui il controllo una volta subito
  checkVinted();

  const FIFTEEN_MINUTES_MS = 900000;

  while (true) {
    const loopWaitTime = FIFTEEN_MINUTES_MS;

    console.log(
      `--- CICLO COMPLETATO. Prossimo controllo tra 15.0 minuti. ---`
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
// ⭐ CONFIGURAZIONE WEBHOOK (Per Render)
// =========================================================
const app = express();
app.use(express.json());

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
    });

  // 2. Endpoint per ricevere i messaggi da Telegram
  app.post(`/bot${TELEGRAM_TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });

  // 3. Server per monitoraggio (Health Check)
  app.get("/", (_, res) => res.send("PokéBot attivo tramite Webhook."));
} else {
  // Fallback locale
  console.log("⚠️ Variabile RENDER_EXTERNAL_URL non trovata. Avvio Polling.");
  bot.startPolling();
  app.get("/", (_, res) => res.send("PokéBot attivo con Polling."));
}

// Avvia il server Express
app.listen(PORT, () => console.log(`Server su porta ${PORT}`));

// =========================================================
// 🔧 COMANDI TELEGRAM DINAMICI (AGGIORNATI ALLA NUOVA STRUTTURA)
// =========================================================

/**
 * Funzione helper per salvare la configurazione.
 */
function saveKeywordsConfig() {
  fs.writeFileSync(
    "keywords.json",
    JSON.stringify({ keywords: KEYWORDS_CONFIG }, null, 2)
  );
}

// ➕ /add keyword
bot.onText(/\/add (.+)/, (msg, match) => {
  const newKeywordSearch = match[1].toLowerCase().trim();

  // Genera i filtri must_contain separando la frase
  // Ignora parole di 1 o 2 caratteri che sono spesso rumore
  const mustContain = newKeywordSearch.split(/\s+/).filter((w) => w.length > 2);

  const newConfig = {
    search: newKeywordSearch,
    must_contain: mustContain,
  };

  // Controlla se la keyword di ricerca è già presente
  if (!KEYWORDS_CONFIG.some((c) => c.search === newKeywordSearch)) {
    KEYWORDS_CONFIG.push(newConfig);
    saveKeywordsConfig();
    bot.sendMessage(
      msg.chat.id,
      `💾 Keyword aggiunta.\n**Ricerca Vinted:** *${newKeywordSearch}*\n**Filtri (Must Contain):** ${mustContain.join(
        ", "
      )}`,
      { parse_mode: "Markdown" }
    );
  } else {
    bot.sendMessage(
      msg.chat.id,
      `⚠️ La keyword *${newKeywordSearch}* è già presente.`,
      { parse_mode: "Markdown" }
    );
  }
});

// 📜 /list → mostra tutte le keyword
bot.onText(/\/list/, (msg) => {
  if (KEYWORDS_CONFIG.length === 0) {
    bot.sendMessage(msg.chat.id, "📭 Nessuna keyword salvata.");
    return;
  }

  const list = KEYWORDS_CONFIG.map(
    (k) =>
      `• **Ricerca:** ${k.search}\n  (Filtri: ${k.must_contain.join(", ")})`
  ).join("\n\n");

  bot.sendMessage(msg.chat.id, `📜 *Lista keyword attuali:*\n\n${list}`, {
    parse_mode: "Markdown",
  });
});

// ❌ /remove keyword
bot.onText(/\/remove (.+)/, (msg, match) => {
  const keywordToRemove = match[1].toLowerCase().trim();

  const initialLength = KEYWORDS_CONFIG.length;
  // Filtra l'array mantenendo solo le configurazioni la cui search non è quella da rimuovere
  KEYWORDS_CONFIG = KEYWORDS_CONFIG.filter((k) => k.search !== keywordToRemove);

  if (KEYWORDS_CONFIG.length < initialLength) {
    saveKeywordsConfig();
    bot.sendMessage(msg.chat.id, `🗑️ Keyword rimossa: *${keywordToRemove}*`, {
      parse_mode: "Markdown",
    });
  } else {
    return bot.sendMessage(
      msg.chat.id,
      `❌ Keyword *${keywordToRemove}* non trovata. (Cerca per il valore di 'Ricerca Vinted')`,
      { parse_mode: "Markdown" }
    );
  }
});
