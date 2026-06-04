/**
 * Rinnova i cookie Vinted nel DB e su Render.
 * Esegui con: node push-cookie.js
 *
 * Usa got-scraping dal tuo PC (IP residenziale, non bloccato)
 * per ottenere access_token_web fresco, poi lo salva nel DB
 * e notifica Render via /admin/vinted-cookie.
 *
 * Non serve incollare nulla — basta lanciarlo.
 */

require("dotenv").config();
const axios  = require("axios");
const { pool } = require("./db");

const RENDER_URL   = process.env.RENDER_EXTERNAL_URL || "https://vinted-bot-1-iuzk.onrender.com";
const ADMIN_SECRET = process.env.JWT_SECRET || "pokebot-jwt-secret-change-me";

// Cookie IP-dipendenti: non mandarli a Render perché causano 403
const EXCLUDE_KEYS = new Set(["datadome", "cto_bundle", "cto_dna_bundle", "cto_bidid"]);

async function getFreshSession() {
  const { gotScraping } = await import("got-scraping");
  for (const domain of ["www.vinted.it", "www.vinted.fr"]) {
    try {
      const res = await gotScraping.get(`https://${domain}/`, {
        headerGeneratorOptions: {
          browsers: [{ name: "chrome", minVersion: 120, maxVersion: 130 }],
          devices: ["desktop"],
          locales: ["it-IT", "it"],
          operatingSystems: ["windows"],
        },
        timeout: { request: 30000 },
        followRedirect: true,
      });
      const map = {};
      for (const raw of [].concat(res.headers["set-cookie"] || [])) {
        const m = raw.match(/^([^=]+)=([^;]*)/);
        if (m) map[m[1].trim()] = m[2].trim();
      }
      if (!map["access_token_web"]) {
        console.warn(`  ${domain}: access_token_web assente, provo il prossimo...`);
        continue;
      }
      // Rimuove cookie IP-dipendenti
      for (const k of Object.keys(map)) {
        if (EXCLUDE_KEYS.has(k)) delete map[k];
      }
      return {
        cookie: Object.entries(map).map(([k, v]) => `${k}=${v}`).join("; ").replace(/[^\x20-\x7E]/g, "").trim(),
        anonId: map["anon_id"] || "",
      };
    } catch (e) {
      console.warn(`  Errore su ${domain}:`, e.message?.slice(0, 100));
    }
  }
  return null;
}

async function main() {
  console.log("🔄 Rinnovo cookie Vinted...\n");

  // 1. Sessione fresca via got-scraping
  console.log("1. got-scraping...");
  const session = await getFreshSession();
  if (!session) {
    console.error("❌ Impossibile ottenere sessione. Controlla la connessione.");
    await pool.end();
    return;
  }
  console.log(`   access_token_web: len=${session.cookie.length}`);
  console.log(`   anon_id: ${session.anonId}`);

  // 2. Test locale
  console.log("\n2. Test ricerca locale...");
  try {
    const res = await axios.get("https://www.vinted.it/api/v2/catalog/items", {
      params: { search_text: "pokemon", per_page: 3, order: "newest_first" },
      timeout: 15000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "it-IT,it;q=0.9",
        "Referer": "https://www.vinted.it/",
        "X-Money-Object": "true",
        "Cookie": session.cookie,
        ...(session.anonId ? { "X-Anon-Id": session.anonId } : {}),
      },
    });
    console.log(`   ✅ OK — ${(res.data.items || []).length} risultati`);
  } catch (e) {
    console.error(`   ❌ ${e.response?.status}:`, JSON.stringify(e.response?.data)?.slice(0, 200) || e.message);
    await pool.end();
    return;
  }

  // 3. Salva nel DB
  console.log("\n3. Salvo nel DB...");
  await pool.query(
    `INSERT INTO bot_settings (key, value) VALUES ('vinted_cookie',$1),('vinted_anon_id',$2),('vinted_csrf',$3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [session.cookie, session.anonId, ""]
  );
  console.log("   ✅ Salvato.");

  // 4. Notifica Render
  console.log(`\n4. Notifico Render (${RENDER_URL})...`);
  try {
    const r = await axios.post(`${RENDER_URL}/admin/vinted-cookie`,
      { cookie: session.cookie, anon_id: session.anonId, csrf: "" },
      { headers: { "Content-Type": "application/json", "x-admin-secret": ADMIN_SECRET }, timeout: 15000 }
    );
    console.log("   ✅", r.data.message);
    console.log("\n🎉 Tutto fatto. Vinted è sbloccato su Render.");
  } catch (e) {
    const status = e.response?.status;
    if (status === 404) {
      console.warn("   ⚠️ Endpoint non ancora disponibile su Render (deploy in corso?).");
      console.warn("   I cookie sono nel DB — verranno caricati al prossimo avvio del bot.");
    } else {
      console.error("   ❌ Render:", status, e.response?.data?.error || e.message);
    }
  }

  await pool.end();
}

main().catch(console.error);
