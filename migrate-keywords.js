/**
 * migrate-keywords.js
 * Importa keywords.json nel DB per un utente specifico.
 *
 * Uso:
 *   node migrate-keywords.js <email> [--upgrade-to-premium]
 *
 * Esempio:
 *   node migrate-keywords.js mario@esempio.it --upgrade-to-premium
 */

require("dotenv").config();
const fs   = require("fs");
const path = require("path");
const { pool, initDB } = require("./db");

async function main() {
  const email   = process.argv[2];
  const upgrade = process.argv.includes("--upgrade-to-premium");

  if (!email) {
    console.error("❌  Uso: node migrate-keywords.js <email> [--upgrade-to-premium]");
    process.exit(1);
  }

  if (!process.env.DATABASE_URL) {
    console.error("❌  DATABASE_URL non trovato. Crea un file .env con DATABASE_URL=postgres://...");
    process.exit(1);
  }

  await initDB();

  // Trova l'utente
  const userRes = await pool.query("SELECT id, email, plan FROM users WHERE email = $1", [email.toLowerCase().trim()]);
  if (!userRes.rows.length) {
    console.error(`❌  Utente "${email}" non trovato nel DB. Registrati prima dal pannello web.`);
    await pool.end();
    process.exit(1);
  }
  const user = userRes.rows[0];
  console.log(`✅  Utente trovato: ${user.email} (piano: ${user.plan})`);

  // Upgrade opzionale a premium
  if (upgrade && user.plan !== "premium") {
    await pool.query("UPDATE users SET plan = 'premium' WHERE id = $1", [user.id]);
    console.log("⬆️   Piano aggiornato a premium.");
    user.plan = "premium";
  } else if (!upgrade && user.plan === "free") {
    console.warn("⚠️   L'utente è sul piano free (limite 5). Le keyword in eccesso verranno inserite lo stesso");
    console.warn("     (lo script bypassa i limiti API). Considera --upgrade-to-premium.\n");
  }

  // Carica keywords.json
  const kwFile = path.join(__dirname, "keywords.json");
  if (!fs.existsSync(kwFile)) {
    console.error("❌  keywords.json non trovato nella root del progetto.");
    await pool.end();
    process.exit(1);
  }
  const { keywords } = JSON.parse(fs.readFileSync(kwFile, "utf8"));
  console.log(`📋  keywords.json contiene ${keywords.length} keyword.\n`);

  let inserted = 0, skipped = 0, errors = 0;

  for (const { search } of keywords) {
    if (!search) continue;
    const normalized = search.toLowerCase().trim();
    try {
      const r = await pool.query(
        "INSERT INTO keywords (user_id, search) VALUES ($1, $2) ON CONFLICT (user_id, search) DO NOTHING",
        [user.id, normalized]
      );
      if (r.rowCount > 0) {
        inserted++;
        console.log(`  ✓ ${normalized}`);
      } else {
        skipped++;
        console.log(`  · già presente: ${normalized}`);
      }
    } catch (err) {
      errors++;
      console.error(`  ✗ ERRORE "${normalized}":`, err.message);
    }
  }

  console.log(`\n── Migrazione completata ──────────────────────`);
  console.log(`   Inserite : ${inserted}`);
  console.log(`   Già presenti : ${skipped}`);
  console.log(`   Errori : ${errors}`);
  console.log(`   Piano utente : ${user.plan}`);
  console.log(`───────────────────────────────────────────────`);

  await pool.end();
}

main().catch(err => {
  console.error("❌  Errore fatale:", err.message);
  process.exit(1);
});
