require("dotenv").config();
const axios               = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { addExtra }        = require("puppeteer-extra");
const puppeteerCore       = require("puppeteer-core");
const StealthPlugin       = require("puppeteer-extra-plugin-stealth");
const _chromiumMod        = require("@sparticuz/chromium");
const chromium            = _chromiumMod.default ?? _chromiumMod;
const puppeteer           = addExtra(puppeteerCore);
puppeteer.use(StealthPlugin());
let gotScraping; // caricato dinamicamente (ESM) all'avvio
const TelegramBot   = require("node-telegram-bot-api");
const express       = require("express");
const path          = require("path");
const fs            = require("fs");
const crypto        = require("crypto");
const bcrypt        = require("bcryptjs");
const jwt           = require("jsonwebtoken");
const nodemailer    = require("nodemailer");
const { pool, initDB, PLAN_LIMITS } = require("./db");

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

const REGISTRATION_CODE  = process.env.REGISTRATION_CODE || "";
const VINTED_PROXY_URL   = process.env.VINTED_PROXY_URL  || "";
const vintedProxyAgent   = VINTED_PROXY_URL ? new HttpsProxyAgent(VINTED_PROXY_URL) : null;
if (vintedProxyAgent) console.log("🔀 Vinted: proxy residenziale attivo.");

const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587");
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;

let smtpTransporter = null;
if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
  smtpTransporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  console.log(`✅ SMTP configurato: ${SMTP_HOST}:${SMTP_PORT}`);
} else {
  console.warn("⚠️ SMTP non configurato (SMTP_HOST/USER/PASS) — reset password disabilitato.");
}

if (!TELEGRAM_TOKEN)           console.error("🛑 TELEGRAM_TOKEN è obbligatorio.");
if (!process.env.DATABASE_URL) console.error("🛑 DATABASE_URL è obbligatorio.");
if (!EBAY_APP_ID || !EBAY_CLIENT_SECRET) console.warn("⚠️ EBAY_APP_ID/EBAY_CLIENT_SECRET non configurati — ricerca eBay disabilitata.");
if (!REGISTRATION_CODE) console.warn("⚠️ REGISTRATION_CODE non impostato — la registrazione è aperta a tutti.");

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
  "fan art", "fanart", "fun art", "repro", "riproduzione", "replica", "fake", "bootleg", "proxy",
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
let isRunning = false;

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

async function loadCookiesFromDB() {
  try {
    const r = await pool.query("SELECT key, value FROM bot_settings WHERE key IN ('vinted_cookie','vinted_anon_id','vinted_csrf')");
    for (const row of r.rows) {
      if (row.key === "vinted_cookie"  && row.value) VINTED_COOKIE_STRING = row.value;
      if (row.key === "vinted_anon_id" && row.value) VINTED_ANON_ID       = row.value;
      if (row.key === "vinted_csrf"    && row.value) VINTED_CSRF_TOKEN    = row.value;
    }
    if (VINTED_COOKIE_STRING) console.log("📦 Cookie Vinted caricati dal DB.");
  } catch (err) { console.error("❌ loadCookiesFromDB:", err.message); }
}

async function saveCookiesToDB() {
  try {
    await pool.query(`
      INSERT INTO bot_settings (key, value) VALUES
        ('vinted_cookie',  $1),
        ('vinted_anon_id', $2),
        ('vinted_csrf',    $3)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `, [VINTED_COOKIE_STRING, VINTED_ANON_ID, VINTED_CSRF_TOKEN]);
  } catch (err) { console.error("❌ saveCookiesToDB:", err.message); }
}

// ============================================================
// UTILITIES
// ============================================================
const delay = ms => new Promise(r => setTimeout(r, ms));
const randomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1) + min);
const normalize = s => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const escapeTgMd = text => String(text).replace(/[_*`[]/g, "\\$&");
const escHtml    = text => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function pricePassesLimit(priceDisplay, priceMin, priceMax) {
  const n = parseFloat(String(priceDisplay).replace(",", ".").match(/[\d.]+/)?.[0]);
  if (isNaN(n)) return true;
  if (priceMax !== null && priceMax !== undefined && n > priceMax) return false;
  if (priceMin !== null && priceMin !== undefined && n < priceMin) return false;
  return true;
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
      await withTimeout(bot.sendPhoto(chatId, photoUrl, { caption, parse_mode: "HTML" }), 15000);
      return;
    } catch {}
  }
  try {
    await withTimeout(bot.sendMessage(chatId, caption, { parse_mode: "HTML" }), 15000);
  } catch (err) {
    console.error(`❌ sendNotification → chat ${chatId}:`, err.message);
  }
}

// ============================================================
// VINTED SESSION REFRESH
// ============================================================
let _refreshing = false;

// Legge la scadenza del JWT access_token_web dal cookie string
function getVintedTokenExpiry(cookieString) {
  if (!cookieString) return 0;
  const m = cookieString.match(/access_token_web=([A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+)/);
  if (!m) return 0;
  try {
    const payload = JSON.parse(Buffer.from(m[1].split(".")[1], "base64url").toString("utf8"));
    return (payload.exp || 0) * 1000;
  } catch { return 0; }
}

// Rinnova il token in anticipo se mancano meno di 10 minuti alla scadenza
async function proactiveTokenRefresh() {
  const expiry = getVintedTokenExpiry(VINTED_COOKIE_STRING);
  if (!expiry) return; // nessun token → il refresh scatterà sul primo 401
  const minsLeft = Math.round((expiry - Date.now()) / 60000);
  if (minsLeft > 10) return; // ancora valido, non serve
  console.log(`🔄 Token Vinted scade tra ${minsLeft} min — refresh proattivo...`);
  await refreshVintedSession();
}

async function refreshVintedSession() {
  if (_refreshing) return false;
  _refreshing = true;
  try {
    // 1° tentativo: Puppeteer (esegue JS, può risolvere la challenge)
    const ok = await _execRefreshPuppeteer();
    if (ok) return true;
    // 2° tentativo: HTTP con TLS spoof (got-scraping)
    return await _execRefresh();
  } finally {
    _refreshing = false;
  }
}

async function _execRefreshPuppeteer() {
  console.log("🔄 Refresh Vinted (Puppeteer)...");
  let browser;
  try {
    const executablePath = await chromium.executablePath();
    browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        "--disable-blink-features=AutomationControlled",
        "--lang=it-IT,it",
        "--window-size=1366,768",
      ],
      defaultViewport: { width: 1366, height: 768 },
      executablePath,
      headless: chromium.headless,
    });
    const page = await browser.newPage();
    await page.setUserAgent(getRandomUA());
    await page.setExtraHTTPHeaders({
      "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
    });
    await page.goto("https://www.vinted.it/", { waitUntil: "domcontentloaded", timeout: 60000 });

    // Polling sul cookie di sessione Vinted — fino a 30s per la challenge
    // Vinted ha migrato da _vinted_fr_session a access_token_web
    let sessionFound = false;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const cookies = await page.cookies();
      sessionFound = cookies.some(c => c.name === "access_token_web" || c.name === "_vinted_fr_session");
      if (sessionFound) break;
      await delay(2000);
    }
    if (!sessionFound) {
      console.warn("⚠️ Puppeteer: cookie di sessione Vinted non trovato dopo 30s.");
      return false;
    }
    const cookies = await page.cookies();
    const cookieParts = [];
    let newAnonId = null;
    for (const c of cookies) {
      cookieParts.push(`${c.name}=${c.value}`);
      if (c.name === "anon_id") newAnonId = c.value;
    }
    const newCsrfToken = await page.evaluate(() => {
      const meta = document.querySelector('meta[name="csrf-token"]');
      return meta ? meta.getAttribute("content") : null;
    }).catch(() => null);
    VINTED_COOKIE_STRING = cookieParts.join("; ").replace(/[^\x20-\x7E]/g, "").trim();
    if (newAnonId)    VINTED_ANON_ID   = newAnonId.replace(/[^\x20-\x7E]/g, "").trim();
    if (newCsrfToken) VINTED_CSRF_TOKEN = newCsrfToken.replace(/[^\x20-\x7E]/g, "").trim();
    await saveCookiesToDB();
    console.log("✅ Sessione Vinted aggiornata (Puppeteer).");
    return true;
  } catch (err) {
    console.error("❌ Puppeteer refresh error:", err.message);
    return false;
  } finally {
    if (browser) {
      const killTimer = setTimeout(() => {
        console.warn("⚠️ browser.close() timeout — forzo SIGKILL");
        try { browser.process()?.kill("SIGKILL"); } catch {}
      }, 12000);
      await browser.close().catch(() => {});
      clearTimeout(killTimer);
    }
  }
}

async function _execRefresh() {
  console.log("🔄 Refresh sessione Vinted (got-scraping + TLS spoof)...");
  const domains = ["www.vinted.it", "www.vinted.fr"];
  for (const domain of domains) {
    try {
      const cookieWithoutSession = (VINTED_COOKIE_STRING || "")
        .split(";").map(p => p.trim())
        .filter(p => !p.startsWith("_vinted_fr_session"))
        .join("; ");
      console.log(`  → tentativo su ${domain}`);

      if (!gotScraping) throw new Error("got-scraping non caricato");
      // Usa session-refresh (pagina leggera) invece della homepage completa (~1-2MB)
      const refreshUrl = `https://${domain}/session-refresh?ref_url=%2F`;
      const res = await gotScraping.get(refreshUrl, {
        headerGeneratorOptions: {
          browsers: [{ name: "chrome", minVersion: 120, maxVersion: 130 }],
          devices: ["desktop"],
          locales: ["it-IT", "it"],
          operatingSystems: ["windows"],
        },
        proxyUrl: VINTED_PROXY_URL || undefined,
        timeout: { request: 30000 },
        followRedirect: true,
        headers: {
          ...(cookieWithoutSession ? { cookie: cookieWithoutSession } : {}),
        },
      });

      // got-scraping: status e headers
      const status = res.statusCode;
      const rawCookies = [].concat(res.headers["set-cookie"] || []);
      const cookieMap = {};
      for (const raw of rawCookies) {
        const m = raw.match(/^([^=]+)=([^;]*)/);
        if (m) cookieMap[m[1].trim()] = m[2].trim();
      }

      console.log(`  ${domain} → HTTP ${status}, set-cookie: ${rawCookies.length}, session: ${!!cookieMap["_vinted_fr_session"]}`);

      if (!cookieMap["_vinted_fr_session"] && !cookieMap["access_token_web"]) {
        // session-refresh non ha restituito token: fallback sulla homepage
        console.warn(`⚠️ ${domain}: session-refresh senza token, provo homepage...`);
        const fallback = await gotScraping.get(`https://${domain}/`, {
          headerGeneratorOptions: { browsers: [{ name: "chrome", minVersion: 120, maxVersion: 130 }], devices: ["desktop"], locales: ["it-IT", "it"], operatingSystems: ["windows"] },
          proxyUrl: VINTED_PROXY_URL || undefined,
          timeout: { request: 30000 },
          followRedirect: true,
          headers: { ...(cookieWithoutSession ? { cookie: cookieWithoutSession } : {}) },
        });
        const fbCookies = [].concat(fallback.headers["set-cookie"] || []);
        for (const raw of fbCookies) { const m = raw.match(/^([^=]+)=([^;]*)/); if (m) cookieMap[m[1].trim()] = m[2].trim(); }
        if (!cookieMap["_vinted_fr_session"] && !cookieMap["access_token_web"]) {
          console.warn(`⚠️ ${domain}: cookie di sessione Vinted assente.`);
          continue;
        }
      }

      // Unisce con i cookie esistenti
      const existing = {};
      for (const part of (VINTED_COOKIE_STRING || "").split(";")) {
        const eq = part.indexOf("=");
        if (eq > 0) existing[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
      }
      const merged = { ...existing, ...cookieMap };
      VINTED_COOKIE_STRING = Object.entries(merged).map(([k, v]) => `${k}=${v}`).join("; ").replace(/[^\x20-\x7E]/g, "").trim();
      if (cookieMap["anon_id"]) VINTED_ANON_ID = cookieMap["anon_id"].replace(/[^\x20-\x7E]/g, "").trim();

      const html = typeof res.body === "string" ? res.body : "";
      const csrfMatch = html.match(/<meta[^>]+name="csrf-token"[^>]+content="([^"]+)"/);
      if (csrfMatch) VINTED_CSRF_TOKEN = csrfMatch[1].replace(/[^\x20-\x7E]/g, "").trim();

      await saveCookiesToDB();
      console.log(`✅ Sessione Vinted aggiornata (${domain}).`);
      return true;
    } catch (err) {
      const status = err.response?.statusCode ?? err.response?.status;
      const body = (err.response?.body ?? err.response?.data ?? "").toString().slice(0, 120).replace(/\s+/g, " ");
      console.error(`❌ refresh ${domain} → ${status || err.message} | ${body}`);
    }
  }
  return false;
}

// ============================================================
// VINTED SEARCH
// ============================================================
function setVintedPause(hours, reason) {
  if (Date.now() < vintedPausedUntil) return; // già in pausa, non ri-notificare
  vintedPausedUntil = Date.now() + hours * 60 * 60 * 1000;
  console.warn(`🔴 Vinted pausa globale ${hours}h — ${reason}`);
  if (CHAT_ID) {
    bot.sendMessage(CHAT_ID,
      `🔴 <b>Vinted bloccato</b> — ${escHtml(reason)}\n\n` +
      `Il refresh automatico non riesce (Cloudflare blocca l'IP del server).\n\n` +
      `<b>Per ripristinare manualmente:</b>\n` +
      `1. Apri <a href="https://vinted.it">vinted.it</a> nel browser\n` +
      `2. Premi <b>F12</b> → tab <b>Network</b> → ricarica la pagina\n` +
      `3. Clicca su una richiesta → cerca l'header <code>Cookie</code>\n` +
      `4. Invia al bot: <code>/setcookies IL_VALORE_COOKIE</code>\n\n` +
      `Poi nella stessa richiesta copia <code>X-CSRF-Token</code> e invia:\n` +
      `<code>/setcsrf IL_TOKEN</code>`,
      { parse_mode: "HTML", disable_web_page_preview: true }
    ).catch(() => {});
  }
}

async function searchVinted(keyword) {
  if (Date.now() < vintedPausedUntil) {
    const remaining = Math.ceil((vintedPausedUntil - Date.now()) / 60000);
    console.log(`  ⏸ Vinted in pausa — ancora ${remaining} min`);
    return [];
  }

  const makeRequest = (extraHeaders) => axios.get("https://www.vinted.it/api/v2/catalog/items", {
    params: { search_text: keyword, per_page: 5, order: "newest_first" },
    timeout: 12000,
    httpsAgent: vintedProxyAgent || undefined,
    headers: {
      "User-Agent": getRandomUA(),
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
      "Accept-Encoding": "gzip, deflate, br",
      Referer: "https://www.vinted.it/",
      Connection: "keep-alive",
      "X-Money-Object": "true",
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Dest": "empty",
      "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      ...extraHeaders,
    },
  });

  // Tentativo 1: con sessione corrente
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await makeRequest(VINTED_COOKIE_STRING ? {
        Cookie: VINTED_COOKIE_STRING,
        "X-Anon-Id": VINTED_ANON_ID,
        "X-CSRF-Token": VINTED_CSRF_TOKEN,
      } : {});
      return res.data.items || [];
    } catch (err) {
      const status = err.response?.status;
      if (status === 429) {
        if (attempt < 3) {
          const backoff = Math.min(300000, 30000 * Math.pow(2, attempt - 1));
          console.warn(`⏳ 429 rate limit Vinted, attendo ${backoff / 1000}s...`);
          await delay(backoff);
          continue;
        }
        setVintedPause(1, "rate limit 429 esaurito");
        return [];
      }
      if ((status === 401 || status === 403) && attempt < 3) {
        console.warn(`⚠️ ${status} Vinted "${keyword}" — refresh (Puppeteer)...`);
        const ok = await refreshVintedSession();
        if (!ok) break; // refresh fallito → prova varianti anonime
        continue;
      }
      if (status === 401 || status === 403) break;
      console.error(`❌ Errore Vinted "${keyword}":`, err.message);
      return [];
    }
  }

  // Tentativo 2: solo anon_id (sessione scaduta)
  if (VINTED_ANON_ID) {
    try {
      const res = await makeRequest({ "X-Anon-Id": VINTED_ANON_ID });
      console.log("  ✅ Vinted risponde in modalità anon");
      return res.data.items || [];
    } catch {}
  }

  // Tentativo 3: completamente anonimo
  try {
    const res = await makeRequest({});
    console.log("  ✅ Vinted risponde in modalità anonima");
    return res.data.items || [];
  } catch (err) {
    const status = err.response?.status;
    console.warn(`⚠️ Vinted anonimo → ${status || err.message}`);
  }

  setVintedPause(2, "sessione scaduta, refresh fallito, accesso anonimo bloccato");
  return [];
}

// ============================================================
// EBAY BROWSE API (OAuth client credentials)
// ============================================================
let vintedPausedUntil = 0;

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
      const is = nd?.props?.pageProps?.initialState || {};
      const list =
        is?.items?.originalList ||
        is?.items?.list ||
        is?.items?.ads ||
        is?.listing?.originalList ||
        is?.listing?.list ||
        is?.listing?.ads ||
        is?.ads?.originalList ||
        is?.ads?.list ||
        (Array.isArray(is?.ads) ? is.ads : null) ||
        is?.results?.originalList ||
        is?.results?.list ||
        (Array.isArray(is?.results) ? is.results : null) ||
        nd?.props?.pageProps?.ads ||
        nd?.props?.pageProps?.items ||
        [];
      if (!list.length) {
        const hasKnownPath = !!(is?.items?.originalList);
        if (hasKnownPath) {
          // Struttura corretta — Subito non ha annunci per questa keyword
          console.log(`  ℹ️ Subito: 0 risultati per "${keyword}" (nessun annuncio su Subito)`);
        } else {
          // Struttura cambiata — serve diagnostica
          const pp = nd?.props?.pageProps || {};
          const isItems = is?.items || {};
          console.warn(
            `⚠️ Subito: struttura __NEXT_DATA__ cambiata per "${keyword}".` +
            `\n  pageProps keys:          [${Object.keys(pp).join(", ")}]` +
            `\n  initialState keys:       [${Object.keys(is).join(", ")}]` +
            `\n  initialState.items keys: [${Object.keys(isItems).join(", ")}]`
          );
        }
      }
      return list;
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
// DB CLEANUP — elimina found_items > 30 giorni
// ============================================================
async function cleanupOldItems() {
  try {
    const res = await pool.query(
      `DELETE FROM found_items WHERE found_at < NOW() - INTERVAL '30 days'`
    );
    const deleted = res.rowCount || 0;
    if (deleted > 0) console.log(`🧹 Cleanup DB: eliminati ${deleted} articoli > 30 giorni.`);
  } catch (err) {
    console.error("❌ cleanupOldItems:", err.message);
  }
}

// ============================================================
// MAIN CHECK LOOP — multi-utente
// ============================================================
async function checkAll() {
  if (isRunning) {
    const stuckMs = Date.now() - (checkAll._startedAt || 0);
    // Timeout dinamico: almeno 30 min + 20s per ogni keyword attiva
    const dynamicTimeout = Math.max(30 * 60 * 1000, (checkAll._kwCount || 50) * 20 * 1000);
    if (stuckMs > dynamicTimeout) {
      console.warn(`⚠️ isRunning bloccato da oltre ${Math.round(stuckMs / 60000)} min — reset forzato.`);
      isRunning = false; botStats.isRunning = false;
    } else return;
  }
  isRunning = true; botStats.isRunning = true;
  checkAll._startedAt = Date.now();
  console.log("🔍 Avvio ciclo controllo...");

  try {
    const usersRes = await pool.query(`
      SELECT u.id, u.telegram_chat_id, u.vinted_enabled, u.ebay_enabled, u.subito_enabled,
             COALESCE(json_agg(json_build_object('search', k.search, 'price_max', k.price_max, 'price_min', k.price_min)) FILTER (WHERE k.search IS NOT NULL), '[]') AS keywords
      FROM users u
      INNER JOIN keywords k ON k.user_id = u.id AND k.active = TRUE
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
        kwMap.get(kwSearch).push({ ...user, priceMax: kw.price_max ?? null, priceMin: kw.price_min ?? null });
      }
    }
    checkAll._kwCount = kwMap.size;
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
            if (!pricePassesLimit(priceDisplay, u.priceMin, u.priceMax)) continue;
            const ins = await pool.query(
              `INSERT INTO found_items (user_id, platform, title, price, link, keyword, image)
               VALUES ($1,'vinted',$2,$3,$4,$5,$6) ON CONFLICT (user_id,link) DO NOTHING RETURNING id`,
              [u.id, item.title, priceDisplay, link, keyword, item.photo?.url || null]
            );
            if (!ins.rows.length) continue;
            if (u.telegram_chat_id) {
              const caption = `🟣 <b>[VINTED]</b> Nuovo Articolo!\n🔎 Keyword: ${escHtml(keyword)}\n\n📛 <b>${escHtml(item.title)}</b>\n💰 <b>Prezzo:</b> ${escHtml(priceDisplay)}\n\n🔗 <a href="${escHtml(link)}">Vedi Articolo</a>`;
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
          // Normalizza l'URL eBay togliendo i parametri di tracking che cambiano ogni ciclo
          const link  = item.itemWebUrl ? item.itemWebUrl.split("?")[0] : null;
          const title = item.title || "";
          if (!link) continue;
          const titleNorm = normalize(title);
          if (!titleMatchesAll(titleNorm, filterTerms)) continue;
          if (excludeTerms.some(t => titleNorm.includes(normalize(t)))) continue;
          const priceDisplay = item.price?.value ? `${item.price.value} ${item.price.currency || "EUR"}` : "N/D";
          const image = item.image?.imageUrl || item.thumbnailImages?.[0]?.imageUrl || null;
          for (const u of ebayUsers) {
            if (!pricePassesLimit(priceDisplay, u.priceMin, u.priceMax)) continue;
            const ins = await pool.query(
              `INSERT INTO found_items (user_id, platform, title, price, link, keyword, image)
               VALUES ($1,'ebay',$2,$3,$4,$5,$6) ON CONFLICT (user_id,link) DO NOTHING RETURNING id`,
              [u.id, title, priceDisplay, link, keyword, image]
            );
            if (!ins.rows.length) continue;
            if (u.telegram_chat_id) {
              const caption = `🔵 <b>[EBAY]</b> Nuovo Articolo!\n🔎 Keyword: ${escHtml(keyword)}\n\n📛 <b>${escHtml(title)}</b>\n💰 <b>Prezzo:</b> ${escHtml(priceDisplay)}\n\n🔗 <a href="${escHtml(link)}">Vedi Articolo</a>`;
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
          const rawLink = item.urls?.default || item.url || null;
          const link  = rawLink ? rawLink.split("?")[0] : null;
          const title = item.subject || item.title || "";
          if (!link || !title) continue;
          const titleNorm = normalize(title);
          if (!titleMatchesAll(titleNorm, filterTerms)) continue;
          if (excludeTerms.some(t => titleNorm.includes(normalize(t)))) continue;
          const priceDisplay = item.features?.["/price"]?.values?.[0]?.value
            || item.price
            || "N/D";
          const imageBase = item.images?.[0]?.cdnBaseUrl || item.images?.[0]?.scale?.[0]?.url;
          // Normalizza URL protocol-relative (//...) e aggiungi rule=phone_200 se serve
          let image = null;
          if (imageBase) {
            const absBase = imageBase.startsWith("//") ? "https:" + imageBase : imageBase;
            if (absBase.startsWith("http")) {
              image = absBase.includes("?") ? absBase : absBase + "?rule=phone_200";
            } else {
              console.log(`  🖼️ Subito img URL inatteso: ${imageBase.slice(0, 80)}`);
            }
          }
          for (const u of subitoUsers) {
            if (!pricePassesLimit(priceDisplay, u.priceMin, u.priceMax)) continue;
            const ins = await pool.query(
              `INSERT INTO found_items (user_id, platform, title, price, link, keyword, image)
               VALUES ($1,'subito',$2,$3,$4,$5,$6) ON CONFLICT (user_id,link) DO NOTHING RETURNING id`,
              [u.id, title, priceDisplay, link, keyword, image]
            );
            if (!ins.rows.length) continue;
            if (u.telegram_chat_id) {
              const caption = `🟠 <b>[SUBITO]</b> Nuovo Articolo!\n🔎 Keyword: ${escHtml(keyword)}\n\n📛 <b>${escHtml(title)}</b>\n💰 <b>Prezzo:</b> ${escHtml(priceDisplay)}\n\n🔗 <a href="${escHtml(link)}">Vedi Articolo</a>`;
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
    ({ gotScraping } = await import("got-scraping"));
    console.log("✅ got-scraping caricato.");
  } catch (err) {
    console.warn("⚠️ got-scraping non disponibile:", err.message);
  }
  try {
    await initDB();
  } catch (err) {
    console.error("❌ DB init fallito:", err.message);
    process.exit(1);
  }
  await loadCookiesFromDB();
  await cleanupOldItems();
  setInterval(cleanupOldItems, 24 * 60 * 60 * 1000); // ogni 24h
  if (CHAT_ID) {
    bot.sendMessage(CHAT_ID, "🤖 *PokéBot v3 Avviato!* Sistema multi-utente attivo.", { parse_mode: "Markdown" })
       .catch(err => console.error("❌ Avvio:", err.message));
  }
  await proactiveTokenRefresh();
  await checkAll();
  while (true) {
    console.log("--- Prossimo ciclo tra 40 minuti. ---");
    await delay(2400000);
    try {
      await proactiveTokenRefresh();
      await checkAll();
    } catch (err) {
      console.error("❌ ERRORE FATALE loop:", err.message);
      isRunning = false;
      botStats.isRunning = false;
      if (CHAT_ID) bot.sendMessage(CHAT_ID, `🚨 *ERRORE FATALE loop*\n\`${err.message}\`\nRiprovo tra 60s.`, { parse_mode: "Markdown" }).catch(() => {});
      await delay(60000);
    }
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
app.get("/panel/login",          (_, res) => res.sendFile(path.join(__dirname, "public", "login.html")));
app.get("/panel/logout",         (_, res) => res.sendFile(path.join(__dirname, "public", "login.html")));
app.get("/panel/register",       (_, res) => res.sendFile(path.join(__dirname, "public", "register.html")));
app.get("/panel/reset-password", (_, res) => res.sendFile(path.join(__dirname, "public", "reset-password.html")));
app.get(["/panel", "/panel/"],   (_, res) => res.sendFile(path.join(__dirname, "public", "panel.html")));
app.get("/pricing",              (_, res) => res.sendFile(path.join(__dirname, "public", "pricing.html")));

// ── AUTH API ─────────────────────────────────────────────────
app.post("/panel/api/auth/register", async (req, res) => {
  const { email, firstName, lastName, password, inviteCode } = req.body;
  if (!email || !firstName || !lastName || !password)
    return res.status(400).json({ error: "Tutti i campi sono obbligatori." });
  if (password.length < 8)
    return res.status(400).json({ error: "La password deve avere almeno 8 caratteri." });
  if (REGISTRATION_CODE && inviteCode !== REGISTRATION_CODE)
    return res.status(403).json({ error: "Codice invito non valido." });
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

app.post("/panel/api/auth/forgot-password", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email obbligatoria." });
  try {
    const r = await pool.query("SELECT id, email, first_name FROM users WHERE email = $1", [email.toLowerCase().trim()]);
    // Always respond OK to prevent email enumeration
    if (!r.rows[0]) return res.json({ ok: true });
    const user = r.rows[0];
    const token   = crypto.randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + 60 * 60 * 1000);
    await pool.query("UPDATE users SET reset_token = $1, reset_token_expires = $2 WHERE id = $3", [token, expires, user.id]);
    const baseUrl  = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    const resetUrl = `${baseUrl}/panel/reset-password?token=${token}`;
    if (!smtpTransporter) {
      console.log(`🔑 [DEV] Reset link per ${email}: ${resetUrl}`);
      return res.json({ ok: true });
    }
    await smtpTransporter.sendMail({
      from: SMTP_FROM,
      to: user.email,
      subject: "PokéBot — Reset Password",
      html: `<div style="font-family:system-ui;max-width:520px;margin:0 auto;padding:2rem;background:#050b1a;color:#eef2ff;border-radius:16px;border:1px solid rgba(0,212,255,.15)">
        <h2 style="color:#00d4ff;margin-bottom:1rem;font-size:1.3rem">🔐 Reset della password</h2>
        <p style="margin-bottom:.75rem">Ciao <strong>${user.first_name}</strong>,</p>
        <p style="color:rgba(238,242,255,.7);line-height:1.6;margin-bottom:1.5rem">Hai richiesto il reset della password per il tuo account PokéBot. Clicca sul pulsante qui sotto — il link è valido per <strong style="color:#eef2ff">1 ora</strong>.</p>
        <a href="${resetUrl}" style="display:inline-block;background:linear-gradient(135deg,#5b21b6,#7c3aed);color:#fff;padding:.85rem 1.75rem;border-radius:11px;text-decoration:none;font-weight:700;font-size:1rem;margin-bottom:1.5rem">Reimposta password →</a>
        <p style="font-size:.78rem;color:rgba(238,242,255,.35);border-top:1px solid rgba(255,255,255,.06);padding-top:1rem;margin-top:.5rem">Se non hai richiesto il reset, ignora questa email. Il tuo account è al sicuro.</p>
      </div>`,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ forgot-password:", err.message);
    res.status(500).json({ error: "Errore del server. Riprova." });
  }
});

app.post("/panel/api/auth/reset-password", async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: "Dati mancanti." });
  if (password.length < 8) return res.status(400).json({ error: "La password deve avere almeno 8 caratteri." });
  try {
    const r = await pool.query(
      "SELECT id FROM users WHERE reset_token = $1 AND reset_token_expires > NOW()",
      [token]
    );
    if (!r.rows[0]) return res.status(400).json({ error: "Link non valido o scaduto. Richiedine uno nuovo." });
    const hash = await bcrypt.hash(password, 12);
    await pool.query(
      "UPDATE users SET password_hash = $1, reset_token = NULL, reset_token_expires = NULL WHERE id = $2",
      [hash, r.rows[0].id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ reset-password:", err.message);
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
      SELECT k.search, k.price_max, k.price_min, k.active,
             COALESCE(COUNT(f.id), 0)::int AS item_count,
             MAX(f.found_at) AS last_found_at
      FROM keywords k
      LEFT JOIN found_items f ON f.keyword = k.search AND f.user_id = k.user_id
      WHERE k.user_id = $1
      GROUP BY k.search, k.price_max, k.price_min, k.active, k.created_at
      ORDER BY k.created_at DESC
    `, [req.user.userId]);
    res.json({ keywords: r.rows });
  } catch (err) {
    console.error("❌ /api/keywords GET:", err.message);
    res.status(500).json({ error: "Errore del server." });
  }
});

app.post("/panel/api/keywords", requireAuth, async (req, res) => {
  const { search, price_max, price_min } = req.body;
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
      "INSERT INTO keywords (user_id, search, price_max, price_min) VALUES ($1,$2,$3,$4)",
      [req.user.userId, search.toLowerCase().trim(), price_max || null, price_min || null]
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
  const { search, price_max, price_min, active } = req.body;
  if (!search) return res.status(400).json({ error: "Campo 'search' obbligatorio." });
  const setClauses = [];
  const values = [];
  let idx = 1;
  if (price_max !== undefined) { setClauses.push(`price_max = $${idx++}`); values.push(price_max !== null ? (parseFloat(price_max) || null) : null); }
  if (price_min !== undefined) { setClauses.push(`price_min = $${idx++}`); values.push(price_min !== null ? (parseFloat(price_min) || null) : null); }
  if (active !== undefined) { setClauses.push(`active = $${idx++}`); values.push(active === true || active === "true"); }
  if (!setClauses.length) return res.status(400).json({ error: "Nessun campo da aggiornare." });
  values.push(req.user.userId, search);
  try {
    const r = await pool.query(
      `UPDATE keywords SET ${setClauses.join(", ")} WHERE user_id = $${idx++} AND search = $${idx}`,
      values
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

// ── ADMIN: VINTED COOKIE REFRESH ─────────────────────────────
app.post("/admin/vinted-cookie", async (req, res) => {
  const secret = req.headers["x-admin-secret"] || "";
  if (!secret || secret !== JWT_SECRET) {
    return res.status(401).json({ error: "Non autorizzato." });
  }
  const { cookie, anon_id, csrf } = req.body;
  if (!cookie) return res.status(400).json({ error: "Campo 'cookie' obbligatorio." });

  const clean = s => (s || "").replace(/[^\x20-\x7E]/g, "").trim();
  VINTED_COOKIE_STRING = clean(cookie);
  VINTED_ANON_ID       = clean(anon_id);
  VINTED_CSRF_TOKEN    = clean(csrf);
  vintedPausedUntil    = 0; // sblocca subito le ricerche

  try {
    await saveCookiesToDB();
    console.log("🔑 Cookie Vinted aggiornati via endpoint admin.");
    res.json({ ok: true, message: "Cookie salvati. Vinted sbloccato." });
  } catch (err) {
    console.error("❌ /admin/vinted-cookie:", err.message);
    res.status(500).json({ error: "Errore salvataggio DB." });
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

// ── IMAGE PROXY (Vinted CDN hotlink protection) ───────────────
app.get("/panel/api/img-proxy", async (req, res) => {
  const url = req.query.url;
  let parsed;
  try { parsed = new URL(url || ""); } catch { return res.status(400).end(); }

  // Solo HTTPS — blocca IP privati per prevenire SSRF
  if (parsed.protocol !== "https:") return res.status(400).end();
  const host = parsed.hostname.toLowerCase();
  if (/^(localhost$|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(host))
    return res.status(400).end();

  // Whitelist flessibile: qualsiasi subdomain di vinted o subito
  const isVinted = host.includes("vinted");
  const isSubito = host.includes("subito");
  if (!isVinted && !isSubito) return res.status(400).end();

  try {
    const imgRes = await axios.get(url, {
      responseType: "arraybuffer",
      headers: {
        "User-Agent": getRandomUA(),
        "Referer": isSubito ? "https://www.subito.it/" : "https://www.vinted.it/",
        "Accept": "image/webp,image/apng,image/*,*/*;q=0.8",
        ...(isSubito ? {} : (VINTED_COOKIE_STRING ? { Cookie: VINTED_COOKIE_STRING } : {})),
      },
      timeout: 10000,
    });
    res.set("Content-Type", imgRes.headers["content-type"] || "image/jpeg");
    res.set("Cache-Control", "public, max-age=86400");
    res.send(Buffer.from(imgRes.data));
  } catch (err) {
    console.log(`  🖼️ img-proxy errore (${host}): ${err.message}`);
    res.status(404).end();
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

// ── HEALTH ───────────────────────────────────────────────────
app.get("/health", async (_, res) => {
  let dbOk = false;
  let userCount = 0;
  let kwCount = 0;
  let foundCount = 0;
  try {
    const [uRes, kRes, fRes] = await Promise.all([
      pool.query("SELECT COUNT(*) FROM users"),
      pool.query("SELECT COUNT(*) FROM keywords WHERE active = TRUE"),
      pool.query("SELECT COUNT(*) FROM found_items WHERE found_at > NOW() - INTERVAL '24 hours'"),
    ]);
    userCount  = parseInt(uRes.rows[0].count);
    kwCount    = parseInt(kRes.rows[0].count);
    foundCount = parseInt(fRes.rows[0].count);
    dbOk = true;
  } catch {}
  res.json({
    status: "ok",
    uptime_s: Math.round(process.uptime()),
    db: dbOk ? "ok" : "error",
    vinted_paused: vintedPausedUntil > Date.now(),
    cycle_running: isRunning,
    last_check: botStats.lastCheckTime || null,
    users: userCount,
    active_keywords: kwCount,
    found_last_24h: foundCount,
    proxy: !!VINTED_PROXY_URL,
  });
});

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
  const vintedStatus = Date.now() < vintedPausedUntil
    ? `⏸ Pausa (${Math.ceil((vintedPausedUntil - Date.now()) / 60000)} min)`
    : (user.vinted_enabled ? "✅ Attivo" : "⏸ Disabilitato");
  bot.sendMessage(chatId,
    `📊 *Stato Bot*\n\nVinted: ${vintedStatus}\neBay: ${user.ebay_enabled ? "✅ Attivo" : "⏸ Pausato"}\nSubito: ${user.subito_enabled ? "✅ Attivo" : "⏸ Pausato"}\nUltimo controllo: ${lastCheck}\nTrovati oggi: ${todayRes.rows[0].count}\nKeyword: ${kwRes.rows[0].count}\nPiano: ${user.plan}`,
    { parse_mode: "Markdown" }
  );
});

// ── COMANDI ADMIN (solo CHAT_ID) ─────────────────────────────
bot.onText(/\/setcookies (.+)/s, async (msg, match) => {
  if (msg.chat.id.toString() !== CHAT_ID) return;
  VINTED_COOKIE_STRING = match[1].trim().replace(/[^\x20-\x7E]/g, "").trim();
  const anonMatch = VINTED_COOKIE_STRING.match(/(?:^|;\s*)anon_id=([^;]+)/);
  if (anonMatch) VINTED_ANON_ID = anonMatch[1].trim();
  vintedPausedUntil = 0;
  await saveCookiesToDB();
  bot.sendMessage(msg.chat.id,
    `✅ Cookie Vinted aggiornati.\nAnon ID: ${VINTED_ANON_ID || "non trovato"}\n\nOra invia: <code>/setcsrf TOKEN</code>`,
    { parse_mode: "HTML" }
  );
});

bot.onText(/\/setcsrf (.+)/, async (msg, match) => {
  if (msg.chat.id.toString() !== CHAT_ID) return;
  VINTED_CSRF_TOKEN = match[1].trim().replace(/[^\x20-\x7E]/g, "").trim();
  vintedPausedUntil = 0;
  await saveCookiesToDB();
  bot.sendMessage(msg.chat.id, "✅ CSRF token aggiornato. Vinted riprende al prossimo ciclo.");
});

bot.onText(/\/resetvinted/, msg => {
  if (msg.chat.id.toString() !== CHAT_ID) return;
  vintedPausedUntil = 0;
  bot.sendMessage(msg.chat.id, "✅ Pausa Vinted rimossa. Riprende al prossimo ciclo.");
});
