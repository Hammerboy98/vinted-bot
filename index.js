const axios = require("axios");
const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const fs = require("fs");
const { addExtra } = require("puppeteer-extra");
const puppeteerCore = require("puppeteer-core");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const chromium = require("@sparticuz/chromium");

// Stealth plugin: bypassa Cloudflare e detection fingerprint
const puppeteer = addExtra(puppeteerCore);
puppeteer.use(StealthPlugin());

// Variabili di sessione (aggiornabili a runtime dopo refresh)
// Rimuove newline e control character dal valore letto dall'env (copia-incolla nel dashboard Render)
// Mantiene solo ASCII stampabile (0x20-0x7E): Node 22 rifiuta qualsiasi altro byte negli header HTTP
let VINTED_COOKIE_STRING = (process.env.VINTED_COOKIE_STRING || "").replace(/[^\x20-\x7E]/g, "").trim();
let VINTED_ANON_ID = (process.env.VINTED_ANON_ID || "").replace(/[^\x20-\x7E]/g, "").trim();
let VINTED_CSRF_TOKEN = (process.env.VINTED_CSRF_TOKEN || "").replace(/[^\x20-\x7E]/g, "").trim();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const PORT = process.env.PORT || 3000;

if (!TELEGRAM_TOKEN || !CHAT_ID || !VINTED_COOKIE_STRING || !VINTED_CSRF_TOKEN) {
  console.error(
    "🛑 Variabili d'ambiente mancanti: TELEGRAM_TOKEN, CHAT_ID, VINTED_COOKIE_STRING, VINTED_CSRF_TOKEN."
  );
}

// Pool di User-Agent realistici — ruotati ad ogni richiesta API
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
];

function getRandomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// Lettura keywords
let KEYWORDS_CONFIG = [];
try {
  const data = fs.readFileSync("keywords.json", "utf8");
  KEYWORDS_CONFIG = JSON.parse(data).keywords || [];
} catch (err) {
  console.log("⚠️ keywords.json non trovato:", err.message);
}

console.log("🔑 Keywords:", KEYWORDS_CONFIG.map((k) => k.search));

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

let notifiedLinks = new Set();
let isRunning = false;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1) + min);
}

// ============================================================
// REFRESH SESSIONE — Puppeteer + Stealth (bypassa Cloudflare)
// ============================================================
async function refreshVintedSession() {
  console.log("🔄 Refresh sessione Vinted con Puppeteer stealth...");
  let browser;
  try {
    const executablePath = await chromium.executablePath();

    browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        "--disable-features=site-isolation-for-navigation",
        "--disable-setuid-sandbox",
      ],
      defaultViewport: chromium.defaultViewport,
      executablePath,
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    await page.setUserAgent(getRandomUA());
    await page.setExtraHTTPHeaders({
      "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
      "Accept-Encoding": "gzip, deflate, br",
    });

    console.log("...Navigazione su Vinted (networkidle2)...");
    await page.goto("https://www.vinted.it/", {
      waitUntil: "networkidle2",
      timeout: 60000,
    });

    // Verifica che Vinted sia carico (non la challenge Cloudflare)
    try {
      await page.waitForSelector('[data-testid="header--logo"]', { timeout: 15000 });
      console.log("✅ Pagina Vinted caricata correttamente.");
    } catch {
      console.warn("⚠️ Logo Vinted non trovato, possibile challenge Cloudflare attiva. Attendo 5s...");
      await delay(5000);
    }

    // Estrai CSRF token dal meta tag (Rails standard)
    const newCsrfToken = await page
      .evaluate(() => {
        const meta = document.querySelector('meta[name="csrf-token"]');
        return meta ? meta.getAttribute("content") : null;
      })
      .catch(() => null);

    const currentCookies = await page.cookies();
    const cookieParts = [];
    let newAnonId = null;
    let sessionFound = false;

    for (const cookie of currentCookies) {
      cookieParts.push(`${cookie.name}=${cookie.value}`);
      if (cookie.name === "_vinted_fr_session") sessionFound = true;
      if (cookie.name === "anon_id") newAnonId = cookie.value;
    }

    if (sessionFound) {
      VINTED_COOKIE_STRING = cookieParts.join("; ");
      if (newAnonId) VINTED_ANON_ID = newAnonId;
      if (newCsrfToken) {
        VINTED_CSRF_TOKEN = newCsrfToken;
        console.log("🔐 CSRF token aggiornato dal meta tag.");
      }
      console.log(`✅ Sessione aggiornata! Cookie: ${VINTED_COOKIE_STRING.substring(0, 80)}...`);
      return true;
    }

    console.warn("⚠️ Cookie _vinted_fr_session non trovato. Cloudflare potrebbe aver bloccato il browser.");
    return false;
  } catch (err) {
    console.error("❌ Errore refresh Puppeteer:", err.message);
    return false;
  } finally {
    if (browser) await browser.close();
  }
}

// ============================================================
// RICERCA API — Retry su 401 / 403 / 429 con backoff esponenziale
// ============================================================
async function searchVinted(keyword) {
  const url = "https://www.vinted.it/api/v2/catalog/items";

  if (!VINTED_COOKIE_STRING || !VINTED_CSRF_TOKEN) {
    console.error("🛑 Cookie o CSRF token mancanti, salto ricerca.");
    return [];
  }

  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const currentUA = getRandomUA();

    try {
      const res = await axios.get(url, {
        params: { search_text: keyword },
        timeout: 12000,
        headers: {
          "User-Agent": currentUA,
          Accept: "application/json, text/plain, */*",
          "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
          "Accept-Encoding": "gzip, deflate, br",
          Referer: "https://www.vinted.it/",
          Connection: "keep-alive",
          Cookie: VINTED_COOKIE_STRING,
          "X-Anon-Id": VINTED_ANON_ID,
          "X-CSRF-Token": VINTED_CSRF_TOKEN,
          "X-Money-Object": "true",
          "Sec-Fetch-Site": "same-origin",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Dest": "empty",
          "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-platform": '"Windows"',
        },
      });

      return res.data.items || [];
    } catch (err) {
      const status = err.response?.status;

      if (status === 401) {
        console.warn(`🔑 401 per "${keyword}" (tentativo ${attempt}) — refresh sessione...`);
        if (attempt < MAX_ATTEMPTS) {
          const ok = await refreshVintedSession();
          if (!ok) {
            console.error("🔴 Refresh fallito. Uscita.");
            return [];
          }
          continue;
        }
        console.error("🔴 401 persistente dopo refresh.");
        return [];
      }

      if (status === 403) {
        console.warn(`🚫 403 per "${keyword}" (tentativo ${attempt}) — Cloudflare block, refresh...`);
        if (attempt < MAX_ATTEMPTS) {
          const ok = await refreshVintedSession();
          if (!ok) return [];
          await delay(randomDelay(5000, 10000));
          continue;
        }
        return [];
      }

      if (status === 429) {
        // Backoff esponenziale: 30s, 60s, 120s
        const backoff = Math.min(300000, 30000 * Math.pow(2, attempt - 1));
        console.warn(`⏳ 429 rate limit per "${keyword}". Attendo ${backoff / 1000}s...`);
        if (attempt < MAX_ATTEMPTS) {
          await delay(backoff);
          continue;
        }
        return [];
      }

      console.error(`❌ Errore ricerca "${keyword}" (tentativo ${attempt}):`, err.message);
      return [];
    }
  }

  return [];
}

// ============================================================
// CICLO PRINCIPALE
// ============================================================
async function checkVinted() {
  if (isRunning) return;
  isRunning = true;
  console.log("🔍 Controllo Vinted…");

  try {
    for (let config of KEYWORDS_CONFIG) {
      const keyword = config.search;
      const mustContain = config.must_contain || [];
      const items = await searchVinted(keyword);

      if (items.length === 0) console.log(`ℹ️ 0 articoli per "${keyword}"`);

      for (const item of items) {
        const articleId = item.id;
        const link = `https://www.vinted.it/items/${articleId}`;
        const searchContent = `${item.title} ${item.description || ""}`.toLowerCase();

        const isRelevant = mustContain.every((word) => searchContent.includes(word));
        if (!isRelevant) continue;
        if (notifiedLinks.has(link)) continue;

        notifiedLinks.add(link);

        const itemPrice = item.price;
        const priceDisplay =
          itemPrice && itemPrice.amount
            ? `${itemPrice.amount} ${itemPrice.currency || "€"}`
            : "Prezzo Sconosciuto";

        const photoUrl = item.photo ? item.photo.url : null;
        const caption = `✨ **Nuovo Articolo Trovato!**\n🔎 Keyword: ${keyword}\n\n📛 *${item.title}*\n\n💰 **Prezzo:** ${priceDisplay}\n\n🔗 [Vedi Articolo](${link})`;

        if (photoUrl) {
          try {
            await bot.sendPhoto(CHAT_ID, photoUrl, { caption, parse_mode: "Markdown" });
            console.log("📨 Notificato con foto:", item.title);
          } catch (e) {
            console.error("❌ Errore foto Telegram:", e.message);
            await bot.sendMessage(CHAT_ID, caption, { parse_mode: "Markdown" });
          }
        } else {
          await bot.sendMessage(CHAT_ID, caption, { parse_mode: "Markdown" });
          console.log("📨 Notificato (solo testo):", item.title);
        }
      }

      const waitTime = randomDelay(10000, 20000);
      console.log(`⏳ Prossima keyword tra ${waitTime / 1000}s...`);
      await delay(waitTime);
    }

    console.log("✅ Ciclo completato.");
  } catch (err) {
    console.error("❌ ERRORE CRITICO NEL CICLO:", err.message);
    await bot
      .sendMessage(
        CHAT_ID,
        `🚨 **ERRORE CRITICO!** Il ciclo di controllo è fallito.\n\nDettagli: \`${err.message}\``,
        { parse_mode: "Markdown" }
      )
      .catch((e) => console.error("❌ Errore invio allerta Telegram:", e.message));
  } finally {
    isRunning = false;
  }
}

// ============================================================
// LOOP OGNI 15 MINUTI
// ============================================================
async function startVintedLoop() {
  checkVinted();

  while (true) {
    console.log("--- Prossimo ciclo tra 15 minuti. ---");
    await delay(900000);
    await checkVinted();
  }
}

startVintedLoop();

bot
  .sendMessage(CHAT_ID, "🤖 **PokéBot Vinted Avviato!** Ricerca in corso...", { parse_mode: "Markdown" })
  .catch((err) => console.error("❌ Errore messaggio avvio:", err.message));

// Pulizia set duplicati ogni 8 ore
setInterval(() => {
  notifiedLinks.clear();
  console.log("🧹 Pulizia notifiche.");
}, 8 * 60 * 60 * 1000);

// ============================================================
// EXPRESS + WEBHOOK TELEGRAM
// ============================================================
const app = express();
app.use(express.json());

const externalUrl = process.env.RENDER_EXTERNAL_URL;

if (externalUrl) {
  const webhookUrl = `${externalUrl}/bot${TELEGRAM_TOKEN}`;
  bot
    .setWebHook(webhookUrl)
    .then(() => console.log(`✅ Webhook impostato: ${webhookUrl}`))
    .catch((err) => console.error("❌ Errore webhook:", err.message));

  app.post(`/bot${TELEGRAM_TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });

  app.get("/", (_, res) => res.send("PokéBot Vinted attivo."));

  // Self-ping ogni 10 minuti per evitare lo spindown su Render free tier
  // Per massima affidabilità, configura anche UptimeRobot su questo URL.
  setInterval(() => {
    axios.get(externalUrl).catch(() => {});
  }, 10 * 60 * 1000);
} else {
  console.log("⚠️ RENDER_EXTERNAL_URL non trovato. Avvio Polling locale.");
  bot.startPolling();
  app.get("/", (_, res) => res.send("PokéBot attivo (polling locale)."));
}

app.listen(PORT, () => console.log(`Server su porta ${PORT}`));

// ============================================================
// COMANDI TELEGRAM DINAMICI
// ============================================================
function saveKeywordsConfig() {
  fs.writeFileSync(
    "keywords.json",
    JSON.stringify({ keywords: KEYWORDS_CONFIG }, null, 2)
  );
}

bot.onText(/\/add (.+)/, (msg, match) => {
  const newKeywordSearch = match[1].toLowerCase().trim();
  const mustContain = newKeywordSearch.split(/\s+/).filter((w) => w.length > 2);
  const newConfig = { search: newKeywordSearch, must_contain: mustContain };

  if (!KEYWORDS_CONFIG.some((c) => c.search === newKeywordSearch)) {
    KEYWORDS_CONFIG.push(newConfig);
    saveKeywordsConfig();
    bot.sendMessage(
      msg.chat.id,
      `💾 Keyword aggiunta.\n**Ricerca:** *${newKeywordSearch}*\n**Filtri:** ${mustContain.join(", ")}`,
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

bot.onText(/\/list/, (msg) => {
  if (KEYWORDS_CONFIG.length === 0) {
    bot.sendMessage(msg.chat.id, "📭 Nessuna keyword salvata.");
    return;
  }
  const list = KEYWORDS_CONFIG.map(
    (k) => `• **Ricerca:** ${k.search}\n  (Filtri: ${k.must_contain.join(", ")})`
  ).join("\n\n");
  bot.sendMessage(msg.chat.id, `📜 *Lista keyword:*\n\n${list}`, {
    parse_mode: "Markdown",
  });
});

bot.onText(/\/remove (.+)/, (msg, match) => {
  const keywordToRemove = match[1].toLowerCase().trim();
  const initialLength = KEYWORDS_CONFIG.length;
  KEYWORDS_CONFIG = KEYWORDS_CONFIG.filter((k) => k.search !== keywordToRemove);

  if (KEYWORDS_CONFIG.length < initialLength) {
    saveKeywordsConfig();
    bot.sendMessage(msg.chat.id, `🗑️ Keyword rimossa: *${keywordToRemove}*`, {
      parse_mode: "Markdown",
    });
  } else {
    bot.sendMessage(
      msg.chat.id,
      `❌ Keyword *${keywordToRemove}* non trovata.`,
      { parse_mode: "Markdown" }
    );
  }
});
