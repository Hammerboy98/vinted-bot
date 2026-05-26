const axios = require("axios");
const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const session = require("express-session");
const path = require("path");
const fs = require("fs");
const { addExtra } = require("puppeteer-extra");
const puppeteerCore = require("puppeteer-core");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const chromium = require("@sparticuz/chromium");

const puppeteer = addExtra(puppeteerCore);
puppeteer.use(StealthPlugin());

// ============================================================
// CONFIG
// ============================================================
let VINTED_COOKIE_STRING = (process.env.VINTED_COOKIE_STRING || "").replace(/[^\x20-\x7E]/g, "").trim();
let VINTED_ANON_ID = (process.env.VINTED_ANON_ID || "").replace(/[^\x20-\x7E]/g, "").trim();
let VINTED_CSRF_TOKEN = (process.env.VINTED_CSRF_TOKEN || "").replace(/[^\x20-\x7E]/g, "").trim();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const PORT = process.env.PORT || 3000;
const EBAY_APP_ID = process.env.EBAY_APP_ID || "";
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || "admin";
const SESSION_SECRET = process.env.SESSION_SECRET || "pokebot-secret-key";

if (!TELEGRAM_TOKEN || !CHAT_ID) {
  console.error("🛑 TELEGRAM_TOKEN e CHAT_ID sono obbligatori.");
}
if (!EBAY_APP_ID) {
  console.warn("⚠️ EBAY_APP_ID non configurato — ricerca eBay disabilitata.");
}

// ============================================================
// USER AGENTS
// ============================================================
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

// ============================================================
// KEYWORDS
// ============================================================
let KEYWORDS_CONFIG = [];
try {
  const data = fs.readFileSync("keywords.json", "utf8");
  KEYWORDS_CONFIG = JSON.parse(data).keywords || [];
} catch (err) {
  console.log("⚠️ keywords.json non trovato:", err.message);
}

console.log("🔑 Keywords:", KEYWORDS_CONFIG.map((k) => k.search));

function saveKeywordsConfig() {
  fs.writeFileSync("keywords.json", JSON.stringify({ keywords: KEYWORDS_CONFIG }, null, 2));
}

// ============================================================
// EXCLUDE TERMS
// ============================================================
const EXCLUDE_TERMS = [
  "peluche", "plush", "pupazzo", "stuffed", "bambolotto",
  "statuina", "statua", "figurina", "action figure", "miniatura", "funko",
  "videogioco", "gioco da tavolo", "gioco di ruolo",
  "gameboy", "game boy", "gba", "nintendo ds", "nds", "game boy advance",
  "console", "cartuccia",
  "custodia", "cover", "case", "pellicola", "vetro temperato",
  "maglietta", "t-shirt", "felpa", "hoodie", "cappello", "costume", "pigiama",
  "calzini", "socks", "scarpe", "scarpa",
  "sandali", "sandalo", "sandales", "sandalen", "sandal",
  "ciabatte", "ciabatta", "ciabattine",
  "infradito", "claquettes", "slippers", "sneaker",
  "poster", "quadro", "stampa", "canvas", "lampada",
  "tazza", "mug", "borraccia", "tappetino",
  "zaino", "borsa", "borsetta", "portafoglio",
  "ciondolo", "collana", "bracciale", "orecchini",
  "fumetto", "manga", "libro",
  "medaglia", "medal", "moneta", "coin",
  "portachiavi", "keychain", "spilla",
  "adesivo", "sticker",
  "booster", "bustina", "display box",
  "raccoglitore", "binder",
  "gadget", "puzzle",
];

// ============================================================
// BOT STATE
// ============================================================
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

let vintedNotifiedLinks = new Set();
let ebayNotifiedIds = new Set();
let isRunning = false;
let refreshPromise = null;

const botStats = {
  lastCheckTime: null,
  itemsFoundToday: 0,
  lastResetDate: new Date().toDateString(),
  vintedEnabled: true,
  ebayEnabled: !!EBAY_APP_ID,
  isRunning: false,
};

// ============================================================
// UTILITIES
// ============================================================
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const randomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1) + min);
const normalize = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

function resetDailyStatsIfNeeded() {
  const today = new Date().toDateString();
  if (botStats.lastResetDate !== today) {
    botStats.itemsFoundToday = 0;
    botStats.lastResetDate = today;
  }
}

// ============================================================
// VINTED SESSION REFRESH
// ============================================================
function refreshVintedSession() {
  if (refreshPromise) {
    console.log("⏳ Refresh già in corso...");
    return refreshPromise;
  }
  refreshPromise = _execRefresh().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

async function _execRefresh() {
  console.log("🔄 Refresh sessione Vinted...");
  let browser;
  try {
    const executablePath = await chromium.executablePath();
    browser = await puppeteer.launch({
      args: [...chromium.args, "--disable-features=site-isolation-for-navigation", "--disable-setuid-sandbox"],
      defaultViewport: chromium.defaultViewport,
      executablePath,
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    await page.setUserAgent(getRandomUA());
    await page.setExtraHTTPHeaders({ "Accept-Language": "it-IT,it;q=0.9", "Accept-Encoding": "gzip, deflate, br" });
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      ["image", "stylesheet", "font", "media"].includes(req.resourceType()) ? req.abort() : req.continue();
    });

    await page.goto("https://www.vinted.it/", { waitUntil: "domcontentloaded", timeout: 45000 });

    try {
      await page.waitForSelector('[data-testid="header--logo"]', { timeout: 15000 });
    } catch {
      console.warn("⚠️ Logo non trovato, attendo CF challenge...");
      await delay(8000);
    }

    const newCsrfToken = await page.evaluate(() => {
      const meta = document.querySelector('meta[name="csrf-token"]');
      return meta ? meta.getAttribute("content") : null;
    }).catch(() => null);

    const cookies = await page.cookies();
    const cookieParts = [];
    let newAnonId = null;
    let sessionFound = false;

    for (const c of cookies) {
      cookieParts.push(`${c.name}=${c.value}`);
      if (c.name === "_vinted_fr_session") sessionFound = true;
      if (c.name === "anon_id") newAnonId = c.value;
    }

    if (sessionFound) {
      VINTED_COOKIE_STRING = cookieParts.join("; ").replace(/[^\x20-\x7E]/g, "").trim();
      if (newAnonId) VINTED_ANON_ID = newAnonId.replace(/[^\x20-\x7E]/g, "").trim();
      if (newCsrfToken) VINTED_CSRF_TOKEN = newCsrfToken.replace(/[^\x20-\x7E]/g, "").trim();
      console.log("✅ Sessione Vinted aggiornata.");
      return true;
    }
    console.warn("⚠️ _vinted_fr_session non trovato.");
    return false;
  } catch (err) {
    console.error("❌ Errore Puppeteer:", err.message);
    return false;
  } finally {
    if (browser) await browser.close();
  }
}

// ============================================================
// VINTED SEARCH
// ============================================================
async function searchVinted(keyword) {
  if (!VINTED_COOKIE_STRING || !VINTED_CSRF_TOKEN) {
    console.warn("⚠️ Cookie Vinted mancanti, avvio refresh preventivo...");
    const ok = await refreshVintedSession();
    if (!ok) {
      console.error("🔴 Refresh fallito, skip Vinted.");
      return [];
    }
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await axios.get("https://www.vinted.it/api/v2/catalog/items", {
        params: { search_text: keyword, per_page: 96, order: "newest_first" },
        timeout: 12000,
        headers: {
          "User-Agent": getRandomUA(),
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
      if ((status === 401 || status === 403) && attempt < 3) {
        console.warn(`⚠️ ${status} Vinted "${keyword}" — refresh...`);
        const ok = await refreshVintedSession();
        if (!ok) return [];
        if (status === 403) await delay(randomDelay(5000, 10000));
        continue;
      }
      if (status === 429 && attempt < 3) {
        const backoff = Math.min(300000, 30000 * Math.pow(2, attempt - 1));
        console.warn(`⏳ 429 rate limit Vinted, attendo ${backoff / 1000}s...`);
        await delay(backoff);
        continue;
      }
      console.error(`❌ Errore Vinted "${keyword}":`, err.message);
      return [];
    }
  }
  return [];
}

// ============================================================
// EBAY SEARCH
// ============================================================
async function searchEbay(keyword) {
  if (!EBAY_APP_ID) return [];
  try {
    const res = await axios.get("https://svcs.ebay.it/services/search/FindingService/v1", {
      params: {
        "OPERATION-NAME": "findItemsByKeywords",
        "SERVICE-VERSION": "1.0.0",
        "SECURITY-APPNAME": EBAY_APP_ID,
        "RESPONSE-DATA-FORMAT": "JSON",
        keywords: keyword,
        "paginationInput.entriesPerPage": 50,
        sortOrder: "StartTimeNewest",
      },
      timeout: 12000,
    });
    const result = res.data?.findItemsByKeywordsResponse?.[0]?.searchResult?.[0]?.item;
    return Array.isArray(result) ? result : [];
  } catch (err) {
    console.error(`❌ Errore eBay "${keyword}":`, err.message);
    return [];
  }
}

// ============================================================
// NOTIFICATION
// ============================================================
async function sendNotification(caption, photoUrl) {
  if (photoUrl) {
    try {
      await bot.sendPhoto(CHAT_ID, photoUrl, { caption, parse_mode: "Markdown" });
      return;
    } catch {}
  }
  await bot.sendMessage(CHAT_ID, caption, { parse_mode: "Markdown" });
}

// ============================================================
// MAIN CHECK LOOP
// ============================================================
async function checkAll() {
  if (isRunning) return;
  isRunning = true;
  botStats.isRunning = true;
  resetDailyStatsIfNeeded();
  console.log("🔍 Avvio controllo...");

  try {
    for (const config of KEYWORDS_CONFIG) {
      const keyword = config.search;
      const mustContain = config.must_contain || [];
      const specificTerms = mustContain.filter((w) => w !== "pokemon");
      const apiQuery = specificTerms.length > 0 ? specificTerms.join(" ") : keyword;

      console.log(`🔎 Cerco: "${keyword}"`);

      // --- VINTED ---
      if (botStats.vintedEnabled) {
        const items = await searchVinted(apiQuery);
        if (items.length === 0) console.log(`ℹ️ Vinted: 0 articoli per "${keyword}"`);

        for (const item of items) {
          const link = `https://www.vinted.it/items/${item.id}`;
          const titleNorm = normalize(item.title);
          const fullContent = normalize(`${item.title} ${item.description || ""}`);

          if (!mustContain.every((w) => titleNorm.includes(normalize(w)))) continue;
          if (/\bno\b/i.test(item.title)) continue;
          if (EXCLUDE_TERMS.some((t) => fullContent.includes(normalize(t)))) continue;
          if (vintedNotifiedLinks.has(link)) continue;

          vintedNotifiedLinks.add(link);
          botStats.itemsFoundToday++;

          const priceDisplay = item.price?.amount
            ? `${item.price.amount} ${item.price.currency || "€"}`
            : "N/D";

          const caption = `🟣 *[VINTED]* Nuovo Articolo!\n🔎 Keyword: ${keyword}\n\n📛 *${item.title}*\n💰 *Prezzo:* ${priceDisplay}\n\n🔗 [Vedi Articolo](${link})`;
          await sendNotification(caption, item.photo?.url);
          console.log("📨 [Vinted]", item.title);
        }
      }

      // --- EBAY ---
      if (botStats.ebayEnabled) {
        const items = await searchEbay(keyword);
        if (items.length === 0) console.log(`ℹ️ eBay: 0 articoli per "${keyword}"`);

        for (const item of items) {
          const itemId = item.itemId?.[0];
          const link = item.viewItemURL?.[0];
          const title = item.title?.[0] || "";
          if (!link || !itemId) continue;

          const titleNorm = normalize(title);
          if (!mustContain.every((w) => titleNorm.includes(normalize(w)))) continue;
          if (/\bno\b/i.test(title)) continue;
          if (EXCLUDE_TERMS.some((t) => titleNorm.includes(normalize(t)))) continue;
          if (ebayNotifiedIds.has(itemId)) continue;

          ebayNotifiedIds.add(itemId);
          botStats.itemsFoundToday++;

          const priceVal = item.sellingStatus?.[0]?.currentPrice?.[0]?.["__value__"];
          const priceCurr = item.sellingStatus?.[0]?.currentPrice?.[0]?.["@currencyId"] || "EUR";
          const priceDisplay = priceVal ? `${priceVal} ${priceCurr}` : "N/D";

          const caption = `🔵 *[EBAY]* Nuovo Articolo!\n🔎 Keyword: ${keyword}\n\n📛 *${title}*\n💰 *Prezzo:* ${priceDisplay}\n\n🔗 [Vedi Articolo](${link})`;
          await sendNotification(caption, item.galleryURL?.[0]);
          console.log("📨 [eBay]", title);
        }
      }

      const waitTime = randomDelay(10000, 20000);
      console.log(`⏳ Prossima keyword tra ${waitTime / 1000}s...`);
      await delay(waitTime);
    }

    botStats.lastCheckTime = new Date().toISOString();
    console.log("✅ Ciclo completato.");
  } catch (err) {
    console.error("❌ ERRORE CICLO:", err.message);
    bot.sendMessage(CHAT_ID, `🚨 *ERRORE CRITICO* nel ciclo\n\`${err.message}\``, { parse_mode: "Markdown" }).catch(() => {});
  } finally {
    isRunning = false;
    botStats.isRunning = false;
  }
}

// ============================================================
// LOOP OGNI 15 MINUTI
// ============================================================
process.on("unhandledRejection", (reason) => {
  console.error("❌ Unhandled rejection:", reason);
});

(async () => {
  await checkAll();
  while (true) {
    console.log("--- Prossimo ciclo tra 15 minuti. ---");
    await delay(900000);
    await checkAll();
  }
})();

bot
  .sendMessage(CHAT_ID, "🤖 *PokéBot Avviato!* Ricerca in corso su Vinted e eBay.", { parse_mode: "Markdown" })
  .catch((err) => console.error("❌ Avvio:", err.message));

setInterval(() => {
  vintedNotifiedLinks.clear();
  ebayNotifiedIds.clear();
  console.log("🧹 Pulizia set notifiche.");
}, 8 * 60 * 60 * 1000);

// ============================================================
// EXPRESS
// ============================================================
const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 },
  })
);

// ============================================================
// PANEL AUTH
// ============================================================
const requireAuth = (req, res, next) => {
  if (req.session.authenticated) return next();
  const wantsJson = req.path.includes("/api/") || req.headers.accept?.includes("application/json");
  if (wantsJson) return res.status(401).json({ error: "Non autorizzato." });
  res.redirect("/panel/login");
};

app.get("/panel/login", (req, res) => {
  if (req.session.authenticated) return res.redirect("/panel/");
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.post("/panel/login", (req, res) => {
  if (req.body.password === PANEL_PASSWORD) {
    req.session.authenticated = true;
    req.session.save((err) => {
      if (err) console.error("❌ Session save error:", err);
      res.redirect("/panel/");
    });
    return;
  }
  res.redirect("/panel/login?error=1");
});

app.get("/panel/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/panel/login"));
});

app.get("/panel", requireAuth, (req, res) => res.redirect("/panel/"));
app.get("/panel/", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "panel.html"));
});

// ============================================================
// PANEL API
// ============================================================
app.get("/panel/api/status", requireAuth, (req, res) => {
  res.json({
    ...botStats,
    keywords: KEYWORDS_CONFIG.length,
    vintedConfigured: !!(VINTED_COOKIE_STRING && VINTED_CSRF_TOKEN),
    ebayConfigured: !!EBAY_APP_ID,
  });
});

app.get("/panel/api/keywords", requireAuth, (req, res) => {
  res.json({ keywords: KEYWORDS_CONFIG });
});

app.post("/panel/api/keywords", requireAuth, (req, res) => {
  const { search, must_contain } = req.body;
  if (!search) return res.status(400).json({ error: "Campo 'search' obbligatorio." });

  const searchLower = search.toLowerCase().trim();
  if (KEYWORDS_CONFIG.some((k) => k.search === searchLower)) {
    return res.status(409).json({ error: "Keyword già presente." });
  }

  const filters = must_contain
    ? must_contain.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
    : searchLower.split(/\s+/).filter((w) => w.length > 2);

  KEYWORDS_CONFIG.push({ search: searchLower, must_contain: filters });
  saveKeywordsConfig();
  res.json({ ok: true });
});

app.delete("/panel/api/keywords", requireAuth, (req, res) => {
  const { search } = req.body;
  const before = KEYWORDS_CONFIG.length;
  KEYWORDS_CONFIG = KEYWORDS_CONFIG.filter((k) => k.search !== search);
  if (KEYWORDS_CONFIG.length < before) {
    saveKeywordsConfig();
    return res.json({ ok: true });
  }
  res.status(404).json({ error: "Keyword non trovata." });
});

app.post("/panel/api/toggle/:platform", requireAuth, (req, res) => {
  const p = req.params.platform;
  if (p === "vinted") {
    botStats.vintedEnabled = !botStats.vintedEnabled;
    return res.json({ enabled: botStats.vintedEnabled });
  }
  if (p === "ebay") {
    botStats.ebayEnabled = !botStats.ebayEnabled;
    return res.json({ enabled: botStats.ebayEnabled });
  }
  res.status(400).json({ error: "Platform non valida." });
});

app.post("/panel/api/run", requireAuth, (req, res) => {
  if (isRunning) return res.json({ ok: false, message: "Già in esecuzione." });
  checkAll();
  res.json({ ok: true, message: "Controllo avviato." });
});

// ============================================================
// WEBHOOK / POLLING
// ============================================================
const externalUrl = process.env.RENDER_EXTERNAL_URL;

if (externalUrl) {
  const webhookUrl = `${externalUrl}/bot${TELEGRAM_TOKEN}`;
  bot
    .setWebHook(webhookUrl)
    .then(() => console.log(`✅ Webhook: ${webhookUrl}`))
    .catch((err) => console.error("❌ Webhook:", err.message));

  app.post(`/bot${TELEGRAM_TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });

  app.get("/", (_, res) => res.send("PokéBot attivo."));

  setInterval(() => axios.get(externalUrl).catch(() => {}), 10 * 60 * 1000);
} else {
  console.log("⚠️ RENDER_EXTERNAL_URL non trovato. Avvio Polling locale.");
  bot.startPolling();
  app.get("/", (_, res) => res.send("PokéBot attivo (polling locale)."));
}

app.listen(PORT, () => console.log(`Server su porta ${PORT}`));

// ============================================================
// TELEGRAM COMMANDS
// ============================================================
bot.onText(/\/add (.+)/, (msg, match) => {
  const search = match[1].toLowerCase().trim();
  const mustContain = search.split(/\s+/).filter((w) => w.length > 2);

  if (!KEYWORDS_CONFIG.some((c) => c.search === search)) {
    KEYWORDS_CONFIG.push({ search, must_contain: mustContain });
    saveKeywordsConfig();
    bot.sendMessage(
      msg.chat.id,
      `💾 Keyword aggiunta.\n*Ricerca:* ${search}\n*Filtri:* ${mustContain.join(", ")}`,
      { parse_mode: "Markdown" }
    );
  } else {
    bot.sendMessage(msg.chat.id, `⚠️ Keyword già presente: ${search}`);
  }
});

bot.onText(/\/list/, (msg) => {
  if (!KEYWORDS_CONFIG.length) return bot.sendMessage(msg.chat.id, "📭 Nessuna keyword salvata.");
  const list = KEYWORDS_CONFIG.map((k) => `• *${k.search}*\n  Filtri: ${k.must_contain.join(", ")}`).join("\n\n");
  bot.sendMessage(msg.chat.id, `📜 *Lista keyword:*\n\n${list}`, { parse_mode: "Markdown" });
});

bot.onText(/\/remove (.+)/, (msg, match) => {
  const search = match[1].toLowerCase().trim();
  const before = KEYWORDS_CONFIG.length;
  KEYWORDS_CONFIG = KEYWORDS_CONFIG.filter((k) => k.search !== search);
  if (KEYWORDS_CONFIG.length < before) {
    saveKeywordsConfig();
    bot.sendMessage(msg.chat.id, `🗑️ Rimossa: *${search}*`, { parse_mode: "Markdown" });
  } else {
    bot.sendMessage(msg.chat.id, `❌ Non trovata: ${search}`);
  }
});

bot.onText(/\/status/, (msg) => {
  const lastCheck = botStats.lastCheckTime
    ? new Date(botStats.lastCheckTime).toLocaleString("it-IT")
    : "Mai";
  bot.sendMessage(
    msg.chat.id,
    `📊 *Stato Bot*\n\nVinted: ${botStats.vintedEnabled ? "✅ Attivo" : "⏸ Pausato"}\neBay: ${botStats.ebayEnabled ? "✅ Attivo" : "⏸ Pausato"}\nUltimo controllo: ${lastCheck}\nTrovati oggi: ${botStats.itemsFoundToday}\nKeyword: ${KEYWORDS_CONFIG.length}`,
    { parse_mode: "Markdown" }
  );
});
