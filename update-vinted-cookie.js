/**
 * Aggiorna i cookie Vinted su Render senza riavviare il bot.
 *
 * USO:
 *   1. Vai su https://www.vinted.it (accedi al tuo account)
 *   2. DevTools → Network → cerca una richiesta a /api/v2/catalog/items
 *   3. Clic destro → "Copy as fetch" oppure guarda Headers → Cookie
 *   4. Incolla il valore di Cookie sotto come COOKIE=
 *   5. node update-vinted-cookie.js
 */

require("dotenv").config();
const axios = require("axios");

// ─── INCOLLA QUI I TUOI DATI ───────────────────────────────────
const COOKIE = ``;   // <-- incolla qui il valore del cookie (tra i backtick)
const ANON_ID = "";  // <-- valore di X-Anon-Id (oppure del cookie anon_id)
const CSRF    = "";  // <-- valore di X-CSRF-Token (opzionale)
// ───────────────────────────────────────────────────────────────

const RENDER_URL  = process.env.RENDER_EXTERNAL_URL || "https://vinted-bot-1-iuzk.onrender.com";
const ADMIN_SECRET = process.env.JWT_SECRET || "pokebot-jwt-secret-change-me";

if (!COOKIE.trim()) {
  console.error("❌ Devi incollare il cookie in COOKIE= prima di eseguire lo script.");
  process.exit(1);
}

async function main() {
  console.log(`→ Invio cookie a ${RENDER_URL}/admin/vinted-cookie ...`);
  try {
    const res = await axios.post(
      `${RENDER_URL}/admin/vinted-cookie`,
      { cookie: COOKIE.trim(), anon_id: ANON_ID.trim(), csrf: CSRF.trim() },
      {
        headers: {
          "Content-Type": "application/json",
          "x-admin-secret": ADMIN_SECRET,
        },
        timeout: 15000,
      }
    );
    console.log("✅", res.data.message);
  } catch (err) {
    const status = err.response?.status;
    const msg    = err.response?.data?.error || err.message;
    console.error(`❌ Errore ${status || ""}: ${msg}`);
  }
}

main();
