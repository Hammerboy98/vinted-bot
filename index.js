require("dotenv").config();
const crypto        = require("crypto");
const axios         = require("axios");
const TelegramBot   = require("node-telegram-bot-api");
const express       = require("express");
const path          = require("path");
const fs            = require("fs");
const bcrypt        = require("bcryptjs");
const jwt           = require("jsonwebtoken");
let nodemailer = null;
try { nodemailer = require("nodemailer"); } catch { console.warn("⚠️ nodemailer non installato — email di verifica disabilitata."); }
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
const EBAY_APP_ID        = process.env.EBAY_APP_ID || "";
const EBAY_CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET || "";
const JWT_SECRET         = process.env.JWT_SECRET || "pokebot-jwt-secret-change-me";

const STRIPE_SECRET_KEY       = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET   = process.env.STRIPE_WEBHOOK_SECRET || "";
const STRIPE_PRO_PRICE_ID     = process.env.STRIPE_PRO_PRICE_ID || "";
const STRIPE_PREMIUM_PRICE_ID = process.env.STRIPE_PREMIUM_PRICE_ID || "";
const stripe = STRIPE_SECRET_KEY ? require("stripe")(STRIPE_SECRET_KEY) : null;

const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587");
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER || "noreply@pokebot.app";
const SMTP_ENABLED = !!(nodemailer && SMTP_HOST && SMTP_USER && SMTP_PASS);

if (!TELEGRAM_TOKEN)           console.error("🛑 TELEGRAM_TOKEN è obbligatorio.");
if (!process.env.DATABASE_URL) console.error("🛑 DATABASE_URL è obbligatorio.");
if (!EBAY_APP_ID || !EBAY_CLIENT_SECRET) console.warn("⚠️ EBAY_APP_ID/EBAY_CLIENT_SECRET non configurati — ricerca eBay disabilitata.");
if (!SMTP_ENABLED) console.warn("⚠️ SMTP non configurato — la verifica email è disabilitata (nuovi utenti auto-verificati).");

// ============================================================
// EMAIL
// ============================================================
async function sendVerificationEmail(email, firstName, token) {
  if (!SMTP_ENABLED) return false;
  const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  const link = `${baseUrl}/panel/api/auth/verify-email?token=${token}`;
  try {
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
    await transporter.sendMail({
      from: `"PokéBot" <${SMTP_FROM}>`,
      to: email,
      subject: "Verifica il tuo account PokéBot",
      html: `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;background:#050b1a;color:#eef2ff;border-radius:16px;overflow:hidden;border:1px solid rgba(0,212,255,0.2)">
        <div style="background:linear-gradient(135deg,#4c1d95,#1d4ed8);padding:28px 32px;text-align:center">
          <div style="font-size:2.5rem">🎮</div>
          <h1 style="font-size:1.4rem;font-weight:800;color:#fff;margin:.5rem 0 0">PokéBot</h1>
        </div>
        <div style="padding:32px">
          <p style="font-size:1rem;font-weight:600;margin-bottom:.75rem">Ciao ${firstName}! 👋</p>
          <p style="color:rgba(238,242,255,0.75);line-height:1.6;margin-bottom:1.5rem">Clicca il pulsante qui sotto per verificare il tuo indirizzo email e attivare il tuo account PokéBot.</p>
          <div style="text-align:center;margin:2rem 0">
            <a href="${link}" style="display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#4c1d95,#4f46e5);color:#fff;border-radius:12px;text-decoration:none;font-weight:700;font-size:.95rem">✅ Verifica Email</a>
          </div>
          <p style="font-size:.75rem;color:rgba(238,242,255,0.35);line-height:1.5">Il link è valido per 24 ore. Se non hai creato un account su PokéBot, ignora questa email.</p>
        </div>
      </div>`,
      text: `Ciao ${firstName}!\n\nVerifica il tuo account PokéBot:\n${link}\n\nIl link scade tra 24 ore.`,
    });
    console.log(`✅ Email di verifica inviata a ${email}`);
    return true;
  } catch (err) {
    console.error("❌ sendVerificationEmail:", err.message);
    return false;
  }
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
const bot = TELEGRAM_TOKEN
  ? new TelegramBot(TELEGRAM_TOKEN, { polling: false })
  : new Proxy({}, { get: () => () => Promise.resolve() });
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
const escapeTgMd = text => String(text).replace(/[_*`[]/g, "\\$&");

function pricePassesLimit(priceDisplay, priceMax) {
  if (priceMax === null || priceMax === undefined) return true;
  const n = parseFloat(String(priceDisplay).replace(",", ".").match(/[\d.]+/)?.[0]);
  return isNaN(n) || n <= priceMax;
}

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
// EBAY BROWSE API (OAuth client credentials)
// ============================================================
let ebayPausedUntil  = 0;
let ebayAccessToken  = null;
let ebayTokenExpiry  = 0;

async function getEbayToken() {
  if (ebayAccessToken && Date.now() < ebayTokenExpiry) return ebayAccessToken;
  const creds = Buffer.from(`${EBAY_APP_ID}:${EBAY_CLIENT_SECRET}`).toString("base64");
  const res = await axios.post(
    "https://api.ebay.com/identity/v1/oauth2/token",
    "grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope",
    {
      headers: {
        "Authorization": `Basic ${creds}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      timeout: 10000,
    }
  );
  ebayAccessToken = res.data.access_token;
  ebayTokenExpiry = Date.now() + (res.data.expires_in - 120) * 1000;
  console.log("🔑 eBay token ottenuto.");
  return ebayAccessToken;
}

async function searchEbay(keyword) {
  if (!EBAY_APP_ID || !EBAY_CLIENT_SECRET) return [];
  if (Date.now() < ebayPausedUntil) {
    console.log("  ⏸ eBay in pausa (rate limit) — skip");
    return [];
  }
  try {
    const token = await getEbayToken();
    const res = await axios.get("https://api.ebay.com/buy/browse/v1/item_summary/search", {
      params: { q: keyword, limit: 50, sort: "newlyListed" },
      headers: {
        "Authorization": `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": "EBAY_IT",
      },
      timeout: 15000,
    });
    return res.data?.itemSummaries || [];
  } catch (err) {
    const status = err.response?.status;
    const body = err.response?.data ? JSON.stringify(err.response.data).slice(0, 400) : err.message;
    if (status === 429) {
      ebayPausedUntil = Date.now() + 60 * 60 * 1000;
      console.warn(`⚠️ eBay rate limit — pausa 1h`);
    } else {
      console.error(`❌ Errore eBay "${keyword}": ${status || ""} ${body}`);
    }
    return [];
  }
}

// ============================================================
// SUBITO.IT SEARCH  (HTML scraping + __NEXT_DATA__)
// ============================================================
let subitoPausedUntil = 0;

async function searchSubito(keyword) {
  if (Date.now() < subitoPausedUntil) {
    console.log("  ⏸ Subito in pausa (rate limit) — skip");
    return [];
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await axios.get("https://www.subito.it/annunci-italia/vendita/usato/", {
        params: { q: keyword, o: 1 },
        headers: {
          "User-Agent": getRandomUA(),
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "it-IT,it;q=0.9",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "none",
        },
        timeout: 15000,
      });
      const m = res.data.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (!m) { console.warn(`⚠️ Subito: __NEXT_DATA__ non trovato per "${keyword}"`); return []; }
      const nd = JSON.parse(m[1]);
      return nd?.props?.pageProps?.initialState?.items?.originalList || [];
    } catch (err) {
      const status = err.response?.status;
      if (status === 429) {
        subitoPausedUntil = Date.now() + 30 * 60 * 1000;
        console.warn(`⚠️ Subito rate limit — pausa 30min`);
        return [];
      }
      if (status === 403 && attempt < 2) {
        await delay(randomDelay(5000, 10000));
        continue;
      }
      console.error(`❌ Errore Subito "${keyword}": ${status || ""} ${err.message}`);
      return [];
    }
  }
  return [];
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
      SELECT u.id, u.telegram_chat_id, u.vinted_enabled, u.ebay_enabled, u.subito_enabled,
             COALESCE(json_agg(json_build_object('search', k.search, 'price_max', k.price_max)) FILTER (WHERE k.search IS NOT NULL), '[]') AS keywords
      FROM users u
      INNER JOIN keywords k ON k.user_id = u.id
      GROUP BY u.id
    `);

    const users = usersRes.rows;
    if (users.length === 0) {
      console.log("ℹ️ Nessun utente con keyword configurate.");
      return;
    }

    // Raggruppa keyword → utenti (ogni keyword viene cercata una volta sola)
    const kwMap = new Map();
    for (const user of users) {
      for (const kw of user.keywords) {
        const kwSearch = kw.search;
        if (!kwMap.has(kwSearch)) kwMap.set(kwSearch, []);
        kwMap.get(kwSearch).push({ ...user, priceMax: kw.price_max ?? null });
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
            if (!pricePassesLimit(priceDisplay, u.priceMax)) continue;
            const ins = await pool.query(
              `INSERT INTO found_items (user_id, platform, title, price, link, keyword, image)
               VALUES ($1,'vinted',$2,$3,$4,$5,$6) ON CONFLICT (user_id,link) DO NOTHING RETURNING id`,
              [u.id, item.title, priceDisplay, link, keyword, item.photo?.url || null]
            );
            if (!ins.rows.length) continue;
            if (u.telegram_chat_id) {
              const caption = `🟣 *[VINTED]* Nuovo Articolo!\n🔎 Keyword: ${escapeTgMd(keyword)}\n\n📛 *${escapeTgMd(item.title)}*\n💰 *Prezzo:* ${priceDisplay}\n\n🔗 [Vedi Articolo](${link})`;
              await sendNotificationTo(u.telegram_chat_id, caption, item.photo?.url);
            }
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
          const link  = item.itemWebUrl;
          const title = item.title || "";
          if (!link) continue;
          const titleNorm = normalize(title);
          if (!titleMatchesAll(titleNorm, filterTerms)) continue;
          if (excludeTerms.some(t => titleNorm.includes(normalize(t)))) continue;
          const priceDisplay = item.price?.value ? `${item.price.value} ${item.price.currency || "EUR"}` : "N/D";
          const image = item.image?.imageUrl || item.thumbnailImages?.[0]?.imageUrl || null;
          for (const u of ebayUsers) {
            if (!pricePassesLimit(priceDisplay, u.priceMax)) continue;
            const ins = await pool.query(
              `INSERT INTO found_items (user_id, platform, title, price, link, keyword, image)
               VALUES ($1,'ebay',$2,$3,$4,$5,$6) ON CONFLICT (user_id,link) DO NOTHING RETURNING id`,
              [u.id, title, priceDisplay, link, keyword, image]
            );
            if (!ins.rows.length) continue;
            if (u.telegram_chat_id) {
              const caption = `🔵 *[EBAY]* Nuovo Articolo!\n🔎 Keyword: ${escapeTgMd(keyword)}\n\n📛 *${escapeTgMd(title)}*\n💰 *Prezzo:* ${priceDisplay}\n\n🔗 [Vedi Articolo](${link})`;
              await sendNotificationTo(u.telegram_chat_id, caption, image);
            }
            console.log(`  📨 [eBay] ${title} → user ${u.id}`);
          }
        }
      }

      // --- SUBITO ---
      const subitoUsers = kwUsers.filter(u => u.subito_enabled);
      if (subitoUsers.length > 0) {
        const items = await searchSubito(keyword);
        if (!items.length) console.log("  ℹ️ Subito: 0 risultati");
        for (const item of items) {
          const link  = item.urls?.default;
          const title = item.subject || "";
          if (!link || !title) continue;
          const titleNorm = normalize(title);
          if (!titleMatchesAll(titleNorm, filterTerms)) continue;
          if (excludeTerms.some(t => titleNorm.includes(normalize(t)))) continue;
          const priceDisplay = item.features?.["/price"]?.values?.[0]?.value || "N/D";
          const imageBase = item.images?.[0]?.cdnBaseUrl;
          const image = imageBase ? `${imageBase}?rule=phone_200` : null;
          for (const u of subitoUsers) {
            if (!pricePassesLimit(priceDisplay, u.priceMax)) continue;
            const ins = await pool.query(
              `INSERT INTO found_items (user_id, platform, title, price, link, keyword, image)
               VALUES ($1,'subito',$2,$3,$4,$5,$6) ON CONFLICT (user_id,link) DO NOTHING RETURNING id`,
              [u.id, title, priceDisplay, link, keyword, image]
            );
            if (!ins.rows.length) continue;
            if (u.telegram_chat_id) {
              const caption = `🟠 *[SUBITO]* Nuovo Articolo!\n🔎 Keyword: ${escapeTgMd(keyword)}\n\n📛 *${escapeTgMd(title)}*\n💰 *Prezzo:* ${priceDisplay}\n\n🔗 [Vedi Articolo](${link})`;
              await sendNotificationTo(u.telegram_chat_id, caption, image);
            }
            console.log(`  📨 [Subito] ${title} → user ${u.id}`);
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
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
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
    const hash    = await bcrypt.hash(password, 12);
    const verTok  = SMTP_ENABLED ? crypto.randomBytes(32).toString("hex") : null;
    const verExp  = SMTP_ENABLED ? new Date(Date.now() + 24 * 60 * 60 * 1000) : null;
    const result  = await pool.query(
      `INSERT INTO users (email, first_name, last_name, password_hash, email_verified, email_verification_token, email_verification_expires)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, email, first_name, last_name, plan`,
      [email.toLowerCase().trim(), firstName.trim(), lastName.trim(), hash, !SMTP_ENABLED, verTok, verExp]
    );
    const u = result.rows[0];
    if (SMTP_ENABLED) {
      await sendVerificationEmail(u.email, u.first_name, verTok);
      return res.json({ ok: true, needsVerification: true });
    }
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
    if (!user.email_verified) {
      return res.status(403).json({ ok: false, notVerified: true, email: user.email, error: "Email non verificata. Controlla la tua casella di posta." });
    }
    const token = jwt.sign({ userId: user.id, email: user.email, plan: user.plan }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ ok: true, token, user: { id: user.id, email: user.email, firstName: user.first_name, lastName: user.last_name, plan: user.plan } });
  } catch (err) {
    console.error("❌ Login:", err.message);
    res.status(500).json({ error: "Errore del server." });
  }
});

app.get("/panel/api/auth/verify-email", async (req, res) => {
  const { token } = req.query;
  if (!token) return res.redirect("/panel/login?verifyError=1");
  try {
    const r = await pool.query(
      "SELECT id FROM users WHERE email_verification_token = $1 AND email_verification_expires > NOW()",
      [token]
    );
    if (!r.rows.length) return res.redirect("/panel/login?verifyError=1");
    await pool.query(
      "UPDATE users SET email_verified = TRUE, email_verification_token = NULL, email_verification_expires = NULL WHERE id = $1",
      [r.rows[0].id]
    );
    res.redirect("/panel/login?verified=1");
  } catch (err) {
    console.error("❌ verify-email:", err.message);
    res.redirect("/panel/login?verifyError=1");
  }
});

app.post("/panel/api/auth/resend-verification", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email obbligatoria." });
  try {
    const r = await pool.query(
      "SELECT id, first_name, email_verified FROM users WHERE email = $1",
      [email.toLowerCase().trim()]
    );
    const user = r.rows[0];
    if (!user || user.email_verified) return res.json({ ok: true });
    const token   = crypto.randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await pool.query(
      "UPDATE users SET email_verification_token = $1, email_verification_expires = $2 WHERE id = $3",
      [token, expires, user.id]
    );
    await sendVerificationEmail(email.toLowerCase().trim(), user.first_name, token);
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ resend-verification:", err.message);
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
  try {
    await pool.query(
      "UPDATE users SET first_name=$1, last_name=$2, telegram_chat_id=$3 WHERE id=$4",
      [firstName.trim(), lastName.trim(), (telegramChatId || "").trim() || null, req.user.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ /api/profile PUT:", err.message);
    res.status(500).json({ error: "Errore del server." });
  }
});

// ── STATUS API ───────────────────────────────────────────────
app.get("/panel/api/status", requireAuth, async (req, res) => {
  try {
    const [kwRes, todayRes, userRes] = await Promise.all([
      pool.query("SELECT COUNT(*) FROM keywords WHERE user_id = $1", [req.user.userId]),
      pool.query("SELECT COUNT(*) FROM found_items WHERE user_id = $1 AND found_at >= CURRENT_DATE", [req.user.userId]),
      pool.query("SELECT vinted_enabled, ebay_enabled, subito_enabled, plan, telegram_chat_id FROM users WHERE id = $1", [req.user.userId]),
    ]);
    const u = userRes.rows[0] || {};
    res.json({
      isRunning:       botStats.isRunning,
      lastCheckTime:   botStats.lastCheckTime,
      keywords:        parseInt(kwRes.rows[0].count),
      itemsFoundToday: parseInt(todayRes.rows[0].count),
      vintedEnabled:   u.vinted_enabled  ?? true,
      ebayEnabled:     u.ebay_enabled    ?? true,
      subitoEnabled:   u.subito_enabled  ?? true,
      vintedConfigured: !!(VINTED_COOKIE_STRING && VINTED_CSRF_TOKEN),
      ebayConfigured:      !!EBAY_APP_ID,
      telegramConfigured:  !!(u.telegram_chat_id),
      plan:                u.plan || req.user.plan,
      planLimit:       PLAN_LIMITS[u.plan || req.user.plan] || 5,
    });
  } catch (err) {
    console.error("❌ /api/status:", err.message);
    res.status(500).json({ error: "Errore del server." });
  }
});

// ── KEYWORDS API ─────────────────────────────────────────────
app.get("/panel/api/keywords", requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT k.search, k.price_max, COALESCE(COUNT(f.id), 0)::int AS item_count,
             MAX(f.found_at) AS last_found_at
      FROM keywords k
      LEFT JOIN found_items f ON f.keyword = k.search AND f.user_id = k.user_id
      WHERE k.user_id = $1
      GROUP BY k.search, k.price_max, k.created_at
      ORDER BY k.created_at DESC
    `, [req.user.userId]);
    res.json({ keywords: r.rows });
  } catch (err) {
    console.error("❌ /api/keywords GET:", err.message);
    res.status(500).json({ error: "Errore del server." });
  }
});

app.post("/panel/api/keywords", requireAuth, async (req, res) => {
  const { search, price_max } = req.body;
  if (!search) return res.status(400).json({ error: "Campo 'search' obbligatorio." });
  const planRes = await pool.query("SELECT plan FROM users WHERE id = $1", [req.user.userId]);
  const plan = planRes.rows[0]?.plan || req.user.plan;
  const limit = PLAN_LIMITS[plan] || 5;
  const kwCount = await pool.query("SELECT COUNT(*) FROM keywords WHERE user_id = $1", [req.user.userId]);
  if (parseInt(kwCount.rows[0].count) >= limit) {
    return res.status(403).json({
      error: `Limite piano ${plan}: massimo ${limit} keywords. Fai l'upgrade del piano.`,
      limitReached: true,
    });
  }
  try {
    await pool.query(
      "INSERT INTO keywords (user_id, search, price_max) VALUES ($1,$2,$3)",
      [req.user.userId, search.toLowerCase().trim(), price_max || null]
    );
    res.json({ ok: true });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "Keyword già presente." });
    res.status(500).json({ error: "Errore server." });
  }
});

app.delete("/panel/api/keywords", requireAuth, async (req, res) => {
  const { search } = req.body;
  if (!search) return res.status(400).json({ error: "Campo 'search' obbligatorio." });
  try {
    const r = await pool.query("DELETE FROM keywords WHERE user_id = $1 AND search = $2", [req.user.userId, search]);
    if (r.rowCount > 0) return res.json({ ok: true });
    res.status(404).json({ error: "Keyword non trovata." });
  } catch (err) {
    console.error("❌ /api/keywords DELETE:", err.message);
    res.status(500).json({ error: "Errore del server." });
  }
});

app.patch("/panel/api/keywords", requireAuth, async (req, res) => {
  const { search, price_max } = req.body;
  if (!search) return res.status(400).json({ error: "Campo 'search' obbligatorio." });
  try {
    const r = await pool.query(
      "UPDATE keywords SET price_max = $1 WHERE user_id = $2 AND search = $3",
      [price_max !== undefined ? (price_max || null) : null, req.user.userId, search]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: "Keyword non trovata." });
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ /api/keywords PATCH:", err.message);
    res.status(500).json({ error: "Errore del server." });
  }
});

// ── ITEMS API ────────────────────────────────────────────────
app.get("/panel/api/items", requireAuth, async (req, res) => {
  try {
    const page     = Math.max(1, parseInt(req.query.page)  || 1);
    const limit    = Math.min(100, Math.max(5, parseInt(req.query.limit) || 15));
    const offset   = (page - 1) * limit;
    const platform = req.query.platform || null;
    const q        = req.query.q ? `%${req.query.q}%` : null;
    const sortKey  = req.query.sort === "price" ? "price" : "date";
    const sortDir  = req.query.dir  === "asc"   ? "ASC"   : "DESC";

    const conds  = ["user_id = $1"];
    const params = [req.user.userId];
    let i = 2;
    if (platform) { conds.push(`platform = $${i++}`);                                params.push(platform); }
    if (q)        { conds.push(`(title ILIKE $${i} OR keyword ILIKE $${i})`); params.push(q); i++; }
    if (req.query.kw) { conds.push(`keyword = $${i++}`); params.push(req.query.kw); }

    const where     = conds.join(" AND ");
    const orderExpr = sortKey === "price"
      ? `CAST(REGEXP_REPLACE(price, '[^0-9.]', '', 'g') AS NUMERIC) ${sortDir} NULLS LAST`
      : `found_at ${sortDir}`;

    const [itemsRes, countRes] = await Promise.all([
      pool.query(
        `SELECT platform, title, price, link, keyword, image, found_at AS "foundAt"
         FROM found_items WHERE ${where} ORDER BY ${orderExpr} LIMIT $${i} OFFSET $${i + 1}`,
        [...params, limit, offset]
      ),
      pool.query(`SELECT COUNT(*) FROM found_items WHERE ${where}`, params),
    ]);

    const total = parseInt(countRes.rows[0].count);
    res.json({ items: itemsRes.rows, total, page, limit, pages: Math.ceil(total / limit) || 1 });
  } catch (err) {
    console.error("❌ /api/items:", err.message);
    res.status(500).json({ error: "Errore del server." });
  }
});

app.delete("/panel/api/items", requireAuth, async (req, res) => {
  try {
    await pool.query("DELETE FROM found_items WHERE user_id = $1", [req.user.userId]);
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ /api/items DELETE:", err.message);
    res.status(500).json({ error: "Errore del server." });
  }
});

app.delete("/panel/api/items/one", requireAuth, async (req, res) => {
  const { link } = req.body;
  if (!link) return res.status(400).json({ error: "Campo 'link' obbligatorio." });
  try {
    const r = await pool.query("DELETE FROM found_items WHERE user_id = $1 AND link = $2", [req.user.userId, link]);
    if (r.rowCount > 0) return res.json({ ok: true });
    res.status(404).json({ error: "Articolo non trovato." });
  } catch (err) {
    console.error("❌ /api/items/one DELETE:", err.message);
    res.status(500).json({ error: "Errore del server." });
  }
});

app.get("/panel/api/stats/daily", requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT DATE(found_at) AS date, platform, COUNT(*) AS count
      FROM found_items
      WHERE user_id = $1 AND found_at >= NOW() - INTERVAL '7 days'
      GROUP BY DATE(found_at), platform
      ORDER BY date ASC
    `, [req.user.userId]);
    res.json({ stats: r.rows });
  } catch (err) {
    console.error("❌ /api/stats/daily:", err.message);
    res.status(500).json({ error: "Errore del server." });
  }
});

// ── PLATFORM TOGGLE ──────────────────────────────────────────
app.post("/panel/api/toggle/:platform", requireAuth, async (req, res) => {
  const p = req.params.platform;
  if (p !== "vinted" && p !== "ebay" && p !== "subito") return res.status(400).json({ error: "Platform non valida." });
  const col = p === "vinted" ? "vinted_enabled" : p === "ebay" ? "ebay_enabled" : "subito_enabled";
  try {
    const r = await pool.query(
      `UPDATE users SET ${col} = NOT ${col} WHERE id = $1 RETURNING ${col} AS enabled`,
      [req.user.userId]
    );
    if (!r.rows[0]) return res.status(404).json({ error: "Utente non trovato." });
    res.json({ enabled: r.rows[0].enabled });
  } catch (err) {
    console.error(`❌ /api/toggle/${p}:`, err.message);
    res.status(500).json({ error: "Errore del server." });
  }
});

// ── STRIPE ───────────────────────────────────────────────────
app.post("/panel/api/stripe/webhook", async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.sendStatus(200);
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("❌ Stripe webhook:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const { userId, plan } = session.metadata || {};
    if (userId && plan) {
      await pool.query(
        "UPDATE users SET plan = $1, stripe_subscription_id = $2 WHERE id = $3",
        [plan, session.subscription, parseInt(userId)]
      );
      console.log(`✅ Stripe: utente ${userId} → piano ${plan}`);
    }
  }

  if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object;
    await pool.query(
      "UPDATE users SET plan = 'free', stripe_subscription_id = NULL WHERE stripe_subscription_id = $1",
      [sub.id]
    );
    console.log(`⬇️ Stripe: subscription ${sub.id} cancellata → free`);
  }

  res.sendStatus(200);
});

app.post("/panel/api/stripe/checkout", requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: "Stripe non configurato." });
  const { plan } = req.body;
  const priceId = plan === "premium" ? STRIPE_PREMIUM_PRICE_ID : STRIPE_PRO_PRICE_ID;
  if (!priceId) return res.status(503).json({ error: "Price ID non configurato per questo piano." });

  try {
    const userRes = await pool.query("SELECT * FROM users WHERE id = $1", [req.user.userId]);
    const user = userRes.rows[0];
    if (!user) return res.status(404).json({ error: "Utente non trovato." });

    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name:  `${user.first_name} ${user.last_name}`,
        metadata: { userId: String(user.id) },
      });
      customerId = customer.id;
      await pool.query("UPDATE users SET stripe_customer_id = $1 WHERE id = $2", [customerId, user.id]);
    }

    const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    const session = await stripe.checkout.sessions.create({
      customer:    customerId,
      mode:        "subscription",
      line_items:  [{ price: priceId, quantity: 1 }],
      success_url: `${baseUrl}/panel/?upgraded=1`,
      cancel_url:  `${baseUrl}/pricing`,
      metadata:    { userId: String(user.id), plan },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Stripe checkout:", err.message);
    res.status(500).json({ error: "Errore creazione checkout." });
  }
});

app.post("/panel/api/stripe/portal", requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: "Stripe non configurato." });
  try {
    const userRes    = await pool.query("SELECT stripe_customer_id FROM users WHERE id = $1", [req.user.userId]);
    const customerId = userRes.rows[0]?.stripe_customer_id;
    if (!customerId) return res.status(400).json({ error: "Nessun abbonamento Stripe trovato." });

    const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    const session = await stripe.billingPortal.sessions.create({
      customer:   customerId,
      return_url: `${baseUrl}/pricing`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Stripe portal:", err.message);
    res.status(500).json({ error: "Errore apertura portal." });
  }
});

// ── RUN NOW ──────────────────────────────────────────────────
const runCooldowns = new Map(); // userId → lastRunTimestamp
const RUN_COOLDOWN_MS = 2 * 60 * 1000;

app.post("/panel/api/run", requireAuth, (req, res) => {
  const userId = req.user.userId;
  const lastRun = runCooldowns.get(userId) || 0;
  const cooldownLeft = Math.ceil((RUN_COOLDOWN_MS - (Date.now() - lastRun)) / 1000);
  if (cooldownLeft > 0) return res.json({ ok: false, message: `Attendi ancora ${cooldownLeft}s prima di riavviare.` });
  if (isRunning) return res.json({ ok: false, message: "Già in esecuzione." });
  runCooldowns.set(userId, Date.now());
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
  const r = await pool.query(
    "SELECT id, plan, vinted_enabled, ebay_enabled, subito_enabled FROM users WHERE telegram_chat_id = $1",
    [chatId.toString()]
  );
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
    `📊 *Stato Bot*\n\nVinted: ${user.vinted_enabled ? "✅ Attivo" : "⏸ Pausato"}\neBay: ${user.ebay_enabled ? "✅ Attivo" : "⏸ Pausato"}\nSubito: ${user.subito_enabled ? "✅ Attivo" : "⏸ Pausato"}\nUltimo controllo: ${lastCheck}\nTrovati oggi: ${todayRes.rows[0].count}\nKeyword: ${kwRes.rows[0].count}\nPiano: ${user.plan}`,
    { parse_mode: "Markdown" }
  );
});
