const axios         = require("axios");
const TelegramBot   = require("node-telegram-bot-api");
const express       = require("express");
const path          = require("path");
const fs            = require("fs");
const bcrypt        = require("bcryptjs");
const jwt           = require("jsonwebtoken");
const { addExtra }  = require("puppeteer-extra");
const puppeteerCore = require("puppeteer-core");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const chromium      = require("@sparticuz/chromium");
const { pool, initDB, PLAN_LIMITS } = require("./db");

const puppeteer = addExtra(puppeteerCore);
puppeteer.use(StealthPlugin());

// ============================================================
// CONFIG
// ============================================================
let VINTED_COOKIE_STRING = (process.env.VINTED_COOKIE_STRING || "").replace(/[^\x20-\x7E]/g, "").trim();
let VINTED_ANON_ID       = (process.env.VINTED_ANON_ID || "").replace(/[^\x20-\x7E]/g, "").trim();
let VINTED_CSRF_TOKEN    = (process.env.VINTED_CSRF_TOKEN || "").replace(/[^\x20-\x7E]/g, "").trim();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID        = process.env.CHAT_ID; // opzionale — per il messaggio di avvio
const PORT           = process.env.PORT || 3000;
const EBAY_APP_ID    = process.env.EBAY_APP_ID || "";
const JWT_SECRET     = process.env.JWT_SECRET || "pokebot-jwt-secret-change-me";

if (!TELEGRAM_TOKEN)        console.error("🛑 TELEGRAM_TOKEN è obbligatorio.");
if (!process.env.DATABASE_URL) console.error("🛑 DATABASE_URL è obbligatorio.");
if (!EBAY_APP_ID)           console.warn("⚠️ EBAY_APP_ID non configurato — ricerca eBay disabilitata.");

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
const getRandomUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

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
  "infradito", "claquettes", "claquette", "slippers", "sneaker",
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
  "golden goose", "backpack", "ledertasche", "tasche", "star wars",
  "superstar", "jacket", "giacca", "giubbotto", "pantalone", "vestito",
  "scarpa da ginnastica", "taglia", " tg ", " tg.", "size ",
];

const ONE_PIECE_ALLOW_TERMS = new Set(["manga", "fumetto"]);
function getExcludeTerms(keyword) {
  if (normalize(keyword).includes("one piece")) {
    return EXCLUDE_TERMS.filter(t => !ONE_PIECE_ALLOW_TERMS.has(t));
  }
  return EXCLUDE_TERMS;
}

// ============================================================
// BOT STATE — globale (non per-utente)
// ============================================================
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
let isRunning     = false;
let refreshPromise = null;

const botStats = {
  isRunning:     false,
  lastCheckTime: null,
  lastResetDate: new Date().toDateString(),
};

const STATE_FILE = "state.json";
try {
  const _s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  if (_s.lastCheckTime) botStats.lastCheckTime = _s.lastCheckTime;
  if (_s.lastResetDate) botStats.lastResetDate = _s.lastResetDate;
  console.log(`📊 Stato caricato: ultimo controllo ${botStats.lastCheckTime || "mai"}.`);
} catch { /* primo avvio */ }

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      lastCheckTime: botStats.lastCheckTime,
      lastResetDate: botStats.lastResetDate,
    }));
  } catch (err) { console.error("❌ saveState:", err.message); }
}

// ============================================================
// UTILITIES
// ============================================================
const delay = ms => new Promise(r => setTimeout(r, ms));
const randomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1) + min);
const normalize = s => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

function getSearchTerms(searchStr) {
  return normalize(searchStr)
    .split(/\s+/)
    .map(w => w.replace(/^#/, ""))
    .filter(w => (/^\d+$/.test(w) ? true : w.length >= 2));
}

function titleMatchesAll(titleNorm, filterTerms) {
  return filterTerms.every(w => {
    if (/^\d+$/.test(w)) return new RegExp(`(?<!\\d)${w}(?!\\d)`).test(titleNorm);
    return titleNorm.includes(w);
  });
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout ${ms}ms`)), ms)),
  ]);
}

async function sendNotificationTo(chatId, caption, photoUrl) {
  if (photoUrl) {
    try {
      await withTimeout(bot.sendPhoto(chatId, photoUrl, { caption, parse_mode: "Markdown" }), 15000);
      return;
    } catch {}
  }
  try {
    await withTimeout(bot.sendMessage(chatId, caption, { parse_mode: "Markdown" }), 15000);
  } catch (err) {
    console.error(`❌ sendNotification → chat ${chatId}:`, err.message);
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
    page.on("request", req => {
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
    let newAnonId = null, sessionFound = false;
    for (const c of cookies) {
      cookieParts.push(`${c.name}=${c.value}`);
      if (c.name === "_vinted_fr_session") sessionFound = true;
      if (c.name === "anon_id") newAnonId = c.value;
    }
    if (sessionFound) {
      VINTED_COOKIE_STRING = cookieParts.join("; ").replace(/[^\x20-\x7E]/g, "").trim();
      if (newAnonId)     VINTED_ANON_ID    = newAnonId.replace(/[^\x20-\x7E]/g, "").trim();
      if (newCsrfToken)  VINTED_CSRF_TOKEN = newCsrfToken.replace(/[^\x20-\x7E]/g, "").trim();
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
    if (!ok) { console.error("🔴 Refresh fallito, skip Vinted."); return []; }
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
    const res = await axios.get("https://svcs.ebay.com/services/search/FindingService/v1", {
      params: {
        "OPERATION-NAME": "findItemsByKeywords",
        "SERVICE-VERSION": "1.0.0",
        "SECURITY-APPNAME": EBAY_APP_ID,
        "RESPONSE-DATA-FORMAT": "JSON",
        "GLOBAL-ID": "EBAY-IT",
        keywords: keyword,
        "paginationInput.entriesPerPage": 50,
        sortOrder: "StartTimeNewest",
      },
      timeout: 15000,
    });
    const result = res.data?.findItemsByKeywordsResponse?.[0]?.searchResult?.[0]?.item;
    return Array.isArray(result) ? result : [];
  } catch (err) {
    console.error(`❌ Errore eBay "${keyword}":`, err.message);
    return [];
  }
}

// ============================================================
// MAIN CHECK LOOP — multi-utente
// ============================================================
async function checkAll() {
  if (isRunning) {
    const stuckMs = Date.now() - (checkAll._startedAt || 0);
    if (stuckMs > 20 * 60 * 1000) {
      console.warn("⚠️ isRunning bloccato da oltre 20 min — reset forzato.");
      isRunning = false; botStats.isRunning = false;
    } else return;
  }
  isRunning = true; botStats.isRunning = true;
  checkAll._startedAt = Date.now();
  console.log("🔍 Avvio ciclo controllo...");

  try {
    const usersRes = await pool.query(`
      SELECT u.id, u.telegram_chat_id, u.vinted_enabled, u.ebay_enabled,
             COALESCE(array_agg(k.search) FILTER (WHERE k.search IS NOT NULL), '{}') AS keywords
      FROM users u
      INNER JOIN keywords k ON k.user_id = u.id
      WHERE u.telegram_chat_id IS NOT NULL AND u.telegram_chat_id != ''
      GROUP BY u.id
    `);

    const users = usersRes.rows;
    if (users.length === 0) {
      console.log("ℹ️ Nessun utente con keyword + Telegram configurati.");
      return;
    }

    // Raggruppa keyword → utenti (ogni keyword viene cercata una volta sola)
    const kwMap = new Map();
    for (const user of users) {
      for (const kw of user.keywords) {
        if (!kwMap.has(kw)) kwMap.set(kw, []);
        kwMap.get(kw).push(user);
      }
    }
    console.log(`🔑 ${kwMap.size} keyword uniche per ${users.length} utenti.`);

    for (const [keyword, kwUsers] of kwMap) {
      const filterTerms = getSearchTerms(keyword);
      const excludeTerms = getExcludeTerms(keyword);
      console.log(`🔎 "${keyword}" (${kwUsers.length} utenti)`);

      // --- VINTED ---
      const vintedUsers = kwUsers.filter(u => u.vinted_enabled);
      if (vintedUsers.length > 0) {
        const items = await searchVinted(keyword);
        if (!items.length) console.log("  ℹ️ Vinted: 0 risultati");
        for (const item of items) {
          const link       = `https://www.vinted.it/items/${item.id}`;
          const titleNorm  = normalize(item.title);
          const fullContent = normalize(`${item.title} ${item.description || ""}`);
          if (!titleMatchesAll(titleNorm, filterTerms)) continue;
          if (excludeTerms.some(t => fullContent.includes(normalize(t)))) continue;
          const priceDisplay = item.price?.amount ? `${item.price.amount} ${item.price.currency || "€"}` : "N/D";
          for (const u of vintedUsers) {
            const ins = await pool.query(
              `INSERT INTO found_items (user_id, platform, title, price, link, keyword, image)
               VALUES ($1,'vinted',$2,$3,$4,$5,$6) ON CONFLICT (user_id,link) DO NOTHING RETURNING id`,
              [u.id, item.title, priceDisplay, link, keyword, item.photo?.url || null]
            );
            if (!ins.rows.length) continue;
            const caption = `🟣 *[VINTED]* Nuovo Articolo!\n🔎 Keyword: ${keyword}\n\n📛 *${item.title}*\n💰 *Prezzo:* ${priceDisplay}\n\n🔗 [Vedi Articolo](${link})`;
            await sendNotificationTo(u.telegram_chat_id, caption, item.photo?.url);
            console.log(`  📨 [Vinted] ${item.title} → user ${u.id}`);
          }
        }
      }

      // --- EBAY ---
      const ebayUsers = kwUsers.filter(u => u.ebay_enabled);
      if (ebayUsers.length > 0) {
        const items = await searchEbay(keyword);
        if (!items.length) console.log("  ℹ️ eBay: 0 risultati");
        for (const item of items) {
          const link  = item.viewItemURL?.[0];
          const title = item.title?.[0] || "";
          if (!link) continue;
          const titleNorm = normalize(title);
          if (!titleMatchesAll(titleNorm, filterTerms)) continue;
          if (excludeTerms.some(t => titleNorm.includes(normalize(t)))) continue;
          const priceVal  = item.sellingStatus?.[0]?.currentPrice?.[0]?.["__value__"];
          const priceCurr = item.sellingStatus?.[0]?.currentPrice?.[0]?.["@currencyId"] || "EUR";
          const priceDisplay = priceVal ? `${priceVal} ${priceCurr}` : "N/D";
          const image = item.galleryURL?.[0] || null;
          for (const u of ebayUsers) {
            const ins = await pool.query(
              `INSERT INTO found_items (user_id, platform, title, price, link, keyword, image)
               VALUES ($1,'ebay',$2,$3,$4,$5,$6) ON CONFLICT (user_id,link) DO NOTHING RETURNING id`,
              [u.id, title, priceDisplay, link, keyword, image]
            );
            if (!ins.rows.length) continue;
            const caption = `🔵 *[EBAY]* Nuovo Articolo!\n🔎 Keyword: ${keyword}\n\n📛 *${title}*\n💰 *Prezzo:* ${priceDisplay}\n\n🔗 [Vedi Articolo](${link})`;
            await sendNotificationTo(u.telegram_chat_id, caption, image);
            console.log(`  📨 [eBay] ${title} → user ${u.id}`);
          }
        }
      }

      await delay(randomDelay(10000, 20000));
    }

    botStats.lastCheckTime = new Date().toISOString();
    console.log("✅ Ciclo completato.");
  } catch (err) {
    console.error("❌ ERRORE CICLO:", err.message);
    if (CHAT_ID) bot.sendMessage(CHAT_ID, `🚨 *ERRORE* nel ciclo\n\`${err.message}\``, { parse_mode: "Markdown" }).catch(() => {});
  } finally {
    isRunning = false;
    botStats.isRunning = false;
    saveState();
  }
}

// Pulizia articoli trovati più vecchi di 30 giorni
setInterval(async () => {
  try {
    const r = await pool.query("DELETE FROM found_items WHERE found_at < NOW() - INTERVAL '30 days'");
    if (r.rowCount > 0) console.log(`🧹 Rimossi ${r.rowCount} articoli trovati > 30 giorni.`);
  } catch (err) { console.error("❌ Cleanup:", err.message); }
}, 8 * 60 * 60 * 1000);

// ============================================================
// STARTUP + LOOP
// ============================================================
process.on("unhandledRejection", reason => console.error("❌ Unhandled rejection:", reason));

(async () => {
  try {
    await initDB();
  } catch (err) {
    console.error("❌ DB init fallito:", err.message);
    process.exit(1);
  }
  if (CHAT_ID) {
    bot.sendMessage(CHAT_ID, "🤖 *PokéBot v3 Avviato!* Sistema multi-utente attivo.", { parse_mode: "Markdown" })
       .catch(err => console.error("❌ Avvio:", err.message));
  }
  await checkAll();
  while (true) {
    console.log("--- Prossimo ciclo tra 15 minuti. ---");
    await delay(900000);
    await checkAll();
  }
})();

// ============================================================
// EXPRESS
// ============================================================
const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── AUTH MIDDLEWARE ──────────────────────────────────────────
const requireAuth = (req, res, next) => {
  const auth  = req.headers["authorization"] || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) return res.status(401).json({ error: "Non autorizzato." });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Sessione scaduta. Effettua di nuovo il login." });
  }
};

// ── HTML ROUTES ──────────────────────────────────────────────
app.get("/panel/login",    (_, res) => res.sendFile(path.join(__dirname, "public", "login.html")));
app.get("/panel/logout",   (_, res) => res.sendFile(path.join(__dirname, "public", "login.html")));
app.get("/panel/register", (_, res) => res.sendFile(path.join(__dirname, "public", "register.html")));
app.get(["/panel", "/panel/"], (_, res) => res.sendFile(path.join(__dirname, "public", "panel.html")));
app.get("/pricing",        (_, res) => res.sendFile(path.join(__dirname, "public", "pricing.html")));

// ── AUTH API ─────────────────────────────────────────────────
app.post("/panel/api/auth/register", async (req, res) => {
  const { email, firstName, lastName, password } = req.body;
  if (!email || !firstName || !lastName || !password)
    return res.status(400).json({ error: "Tutti i campi sono obbligatori." });
  if (password.length < 8)
    return res.status(400).json({ error: "La password deve avere almeno 8 caratteri." });
  try {
    const hash   = await bcrypt.hash(password, 12);
    const result = await pool.query(
      "INSERT INTO users (email, first_name, last_name, password_hash) VALUES ($1,$2,$3,$4) RETURNING id, email, first_name, last_name, plan",
      [email.toLowerCase().trim(), firstName.trim(), lastName.trim(), hash]
    );
    const u = result.rows[0];
    const token = jwt.sign({ userId: u.id, email: u.email, plan: u.plan }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ ok: true, token, user: { id: u.id, email: u.email, firstName: u.first_name, lastName: u.last_name, plan: u.plan } });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "Email già registrata." });
    console.error("❌ Register:", err.message);
    res.status(500).json({ error: "Errore del server. Riprova." });
  }
});

app.post("/panel/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: "Email e password obbligatori." });
  try {
    const result = await pool.query("SELECT * FROM users WHERE email = $1", [email.toLowerCase().trim()]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ ok: false, error: "Credenziali non valide." });
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ ok: false, error: "Credenziali non valide." });
    const token = jwt.sign({ userId: user.id, email: user.email, plan: user.plan }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ ok: true, token, user: { id: user.id, email: user.email, firstName: user.first_name, lastName: user.last_name, plan: user.plan } });
  } catch (err) {
    console.error("❌ Login:", err.message);
    res.status(500).json({ error: "Errore del server." });
  }
});

// ── PROFILE API ──────────────────────────────────────────────
app.get("/panel/api/profile", requireAuth, async (req, res) => {
  const r = await pool.query(
    "SELECT id, email, first_name, last_name, telegram_chat_id, plan, created_at FROM users WHERE id = $1",
    [req.user.userId]
  );
  if (!r.rows[0]) return res.status(404).json({ error: "Utente non trovato." });
  const u = r.rows[0];
  res.json({ id: u.id, email: u.email, firstName: u.first_name, lastName: u.last_name, telegramChatId: u.telegram_chat_id, plan: u.plan, createdAt: u.created_at });
});

app.put("/panel/api/profile", requireAuth, async (req, res) => {
  const { firstName, lastName, telegramChatId } = req.body;
  if (!firstName || !lastName) return res.status(400).json({ error: "Nome e cognome obbligatori." });
  await pool.query(
    "UPDATE users SET first_name=$1, last_name=$2, telegram_chat_id=$3 WHERE id=$4",
    [firstName.trim(), lastName.trim(), (telegramChatId || "").trim() || null, req.user.userId]
  );
  res.json({ ok: true });
});

// ── STATUS API ───────────────────────────────────────────────
app.get("/panel/api/status", requireAuth, async (req, res) => {
  try {
    const [kwRes, todayRes, userRes] = await Promise.all([
      pool.query("SELECT COUNT(*) FROM keywords WHERE user_id = $1", [req.user.userId]),
      pool.query("SELECT COUNT(*) FROM found_items WHERE user_id = $1 AND found_at >= CURRENT_DATE", [req.user.userId]),
      pool.query("SELECT vinted_enabled, ebay_enabled FROM users WHERE id = $1", [req.user.userId]),
    ]);
    const u = userRes.rows[0] || {};
    res.json({
      isRunning:       botStats.isRunning,
      lastCheckTime:   botStats.lastCheckTime,
      keywords:        parseInt(kwRes.rows[0].count),
      itemsFoundToday: parseInt(todayRes.rows[0].count),
      vintedEnabled:   u.vinted_enabled ?? true,
      ebayEnabled:     u.ebay_enabled   ?? true,
      vintedConfigured: !!(VINTED_COOKIE_STRING && VINTED_CSRF_TOKEN),
      ebayConfigured:  !!EBAY_APP_ID,
      plan:            req.user.plan,
      planLimit:       PLAN_LIMITS[req.user.plan] || 5,
    });
  } catch (err) {
    console.error("❌ /api/status:", err.message);
    res.status(500).json({ error: "Errore del server." });
  }
});

// ── KEYWORDS API ─────────────────────────────────────────────
app.get("/panel/api/keywords", requireAuth, async (req, res) => {
  const r = await pool.query("SELECT search FROM keywords WHERE user_id = $1 ORDER BY created_at DESC", [req.user.userId]);
  res.json({ keywords: r.rows });
});

app.post("/panel/api/keywords", requireAuth, async (req, res) => {
  const { search } = req.body;
  if (!search) return res.status(400).json({ error: "Campo 'search' obbligatorio." });
  const limit = PLAN_LIMITS[req.user.plan] || 5;
  const kwCount = await pool.query("SELECT COUNT(*) FROM keywords WHERE user_id = $1", [req.user.userId]);
  if (parseInt(kwCount.rows[0].count) >= limit) {
    return res.status(403).json({
      error: `Limite piano ${req.user.plan}: massimo ${limit} keywords. Fai l'upgrade del piano.`,
      limitReached: true,
    });
  }
  try {
    await pool.query("INSERT INTO keywords (user_id, search) VALUES ($1,$2)", [req.user.userId, search.toLowerCase().trim()]);
    res.json({ ok: true });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "Keyword già presente." });
    res.status(500).json({ error: "Errore server." });
  }
});

app.delete("/panel/api/keywords", requireAuth, async (req, res) => {
  const { search } = req.body;
  const r = await pool.query("DELETE FROM keywords WHERE user_id = $1 AND search = $2", [req.user.userId, search]);
  if (r.rowCount > 0) return res.json({ ok: true });
  res.status(404).json({ error: "Keyword non trovata." });
});

// ── ITEMS API ────────────────────────────────────────────────
app.get("/panel/api/items", requireAuth, async (req, res) => {
  const r = await pool.query(
    `SELECT platform, title, price, link, keyword, image, found_at AS "foundAt"
     FROM found_items WHERE user_id = $1 ORDER BY found_at DESC LIMIT 500`,
    [req.user.userId]
  );
  res.json({ items: r.rows });
});

app.delete("/panel/api/items", requireAuth, async (req, res) => {
  await pool.query("DELETE FROM found_items WHERE user_id = $1", [req.user.userId]);
  res.json({ ok: true });
});

// ── PLATFORM TOGGLE ──────────────────────────────────────────
app.post("/panel/api/toggle/:platform", requireAuth, async (req, res) => {
  const p = req.params.platform;
  if (p !== "vinted" && p !== "ebay") return res.status(400).json({ error: "Platform non valida." });
  const col = p === "vinted" ? "vinted_enabled" : "ebay_enabled";
  const r = await pool.query(
    `UPDATE users SET ${col} = NOT ${col} WHERE id = $1 RETURNING ${col} AS enabled`,
    [req.user.userId]
  );
  res.json({ enabled: r.rows[0].enabled });
});

// ── RUN NOW ──────────────────────────────────────────────────
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
  bot.setWebHook(webhookUrl)
     .then(() => console.log(`✅ Webhook: ${webhookUrl}`))
     .catch(err => console.error("❌ Webhook:", err.message));
  app.post(`/bot${TELEGRAM_TOKEN}`, (req, res) => { bot.processUpdate(req.body); res.sendStatus(200); });
  app.get("/", (_, res) => res.send("PokéBot v3 attivo."));
  setInterval(() => axios.get(externalUrl).catch(() => {}), 10 * 60 * 1000);
} else {
  console.log("⚠️ RENDER_EXTERNAL_URL non trovato. Avvio Polling locale.");
  bot.startPolling();
  app.get("/", (_, res) => res.send("PokéBot v3 attivo (polling locale)."));
}

app.listen(PORT, () => console.log(`🚀 Server su porta ${PORT}`));

// ============================================================
// TELEGRAM COMMANDS
// ============================================================
async function getLinkedUser(chatId) {
  const r = await pool.query("SELECT * FROM users WHERE telegram_chat_id = $1", [chatId.toString()]);
  return r.rows[0] || null;
}

bot.onText(/\/start/, msg => {
  bot.sendMessage(msg.chat.id,
    `👋 *Benvenuto su PokéBot!*\n\nIl tuo Chat ID è: \`${msg.chat.id}\`\n\nCopia questo ID e incollalo nelle *Impostazioni* del pannello web per collegare l'account e ricevere le notifiche.`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/chatid/, msg => {
  bot.sendMessage(msg.chat.id, `Il tuo Chat ID è: \`${msg.chat.id}\``, { parse_mode: "Markdown" });
});

bot.onText(/\/add (.+)/, async (msg, match) => {
  const chatId = msg.chat.id.toString();
  const search = match[1].toLowerCase().trim();
  const user   = await getLinkedUser(chatId);
  if (!user) return bot.sendMessage(chatId, "❌ Account non collegato.\nVai nelle Impostazioni del pannello web → imposta il tuo Chat ID → riprova.");
  const limit   = PLAN_LIMITS[user.plan] || 5;
  const kwCount = await pool.query("SELECT COUNT(*) FROM keywords WHERE user_id = $1", [user.id]);
  if (parseInt(kwCount.rows[0].count) >= limit)
    return bot.sendMessage(chatId, `❌ Limite piano (${limit} keywords). Fai l'upgrade del piano.`);
  try {
    await pool.query("INSERT INTO keywords (user_id, search) VALUES ($1,$2)", [user.id, search]);
    bot.sendMessage(chatId, `✅ Keyword aggiunta: *${search}*`, { parse_mode: "Markdown" });
  } catch {
    bot.sendMessage(chatId, `⚠️ Keyword già presente: ${search}`);
  }
});

bot.onText(/\/list/, async msg => {
  const chatId = msg.chat.id.toString();
  const user   = await getLinkedUser(chatId);
  if (!user) return bot.sendMessage(chatId, "❌ Account non collegato.");
  const r = await pool.query("SELECT search FROM keywords WHERE user_id = $1 ORDER BY created_at DESC", [user.id]);
  if (!r.rows.length) return bot.sendMessage(chatId, "📭 Nessuna keyword salvata.");
  const list = r.rows.map(k => `• *${k.search}*`).join("\n");
  bot.sendMessage(chatId, `📜 *Le tue keyword:*\n\n${list}`, { parse_mode: "Markdown" });
});

bot.onText(/\/remove (.+)/, async (msg, match) => {
  const chatId = msg.chat.id.toString();
  const search = match[1].toLowerCase().trim();
  const user   = await getLinkedUser(chatId);
  if (!user) return bot.sendMessage(chatId, "❌ Account non collegato.");
  const r = await pool.query("DELETE FROM keywords WHERE user_id = $1 AND search = $2", [user.id, search]);
  if (r.rowCount > 0) bot.sendMessage(chatId, `🗑️ Rimossa: *${search}*`, { parse_mode: "Markdown" });
  else bot.sendMessage(chatId, `❌ Non trovata: ${search}`);
});

bot.onText(/\/status/, async msg => {
  const chatId = msg.chat.id.toString();
  const user   = await getLinkedUser(chatId);
  if (!user) return bot.sendMessage(chatId, "❌ Account non collegato.");
  const [kwRes, todayRes] = await Promise.all([
    pool.query("SELECT COUNT(*) FROM keywords WHERE user_id = $1", [user.id]),
    pool.query("SELECT COUNT(*) FROM found_items WHERE user_id = $1 AND found_at >= CURRENT_DATE", [user.id]),
  ]);
  const lastCheck = botStats.lastCheckTime ? new Date(botStats.lastCheckTime).toLocaleString("it-IT") : "Mai";
  bot.sendMessage(chatId,
    `📊 *Stato Bot*\n\nVinted: ${user.vinted_enabled ? "✅ Attivo" : "⏸ Pausato"}\neBay: ${user.ebay_enabled ? "✅ Attivo" : "⏸ Pausato"}\nUltimo controllo: ${lastCheck}\nTrovati oggi: ${todayRes.rows[0].count}\nKeyword: ${kwRes.rows[0].count}\nPiano: ${user.plan}`,
    { parse_mode: "Markdown" }
  );
});
