// Importa i dati da export.json nel nuovo DB (Neon)
// Uso: NEW_DATABASE_URL="postgresql://..." node db-import.js
const { Client } = require('pg');

async function main() {
  const url = process.env.NEW_DATABASE_URL;
  if (!url) { console.error('Manca NEW_DATABASE_URL'); process.exit(1); }

  const data = JSON.parse(require('fs').readFileSync('export.json', 'utf8'));
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();

  // Schema
  await client.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      first_name VARCHAR(100) NOT NULL,
      last_name VARCHAR(100) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      telegram_chat_id VARCHAR(100),
      vinted_enabled BOOLEAN DEFAULT TRUE,
      ebay_enabled BOOLEAN DEFAULT TRUE,
      plan VARCHAR(20) DEFAULT 'free',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      stripe_customer_id VARCHAR(100) UNIQUE,
      stripe_subscription_id VARCHAR(100),
      subito_enabled BOOLEAN DEFAULT TRUE,
      reset_token VARCHAR(64),
      reset_token_expires TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS keywords (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      search VARCHAR(500) NOT NULL,
      price_max NUMERIC DEFAULT NULL,
      price_min NUMERIC DEFAULT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, search)
    );
    CREATE TABLE IF NOT EXISTS found_items (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      platform VARCHAR(20) NOT NULL,
      title TEXT NOT NULL,
      price VARCHAR(100),
      link TEXT NOT NULL,
      keyword VARCHAR(500),
      image TEXT,
      found_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS bot_settings (
      key VARCHAR(100) PRIMARY KEY,
      value TEXT
    );
  `);

  // Utenti
  for (const u of data.users) {
    await client.query(`
      INSERT INTO users (id, email, first_name, last_name, password_hash, telegram_chat_id,
        vinted_enabled, ebay_enabled, plan, created_at, stripe_customer_id,
        stripe_subscription_id, subito_enabled, reset_token, reset_token_expires)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT (id) DO NOTHING
    `, [u.id, u.email, u.first_name, u.last_name, u.password_hash, u.telegram_chat_id,
        u.vinted_enabled, u.ebay_enabled, u.plan, u.created_at, u.stripe_customer_id,
        u.stripe_subscription_id, u.subito_enabled, u.reset_token, u.reset_token_expires]);
  }

  // Keyword
  for (const k of data.keywords) {
    await client.query(`
      INSERT INTO keywords (id, user_id, search, price_max, price_min, active, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (id) DO NOTHING
    `, [k.id, k.user_id, k.search, k.price_max, k.price_min, k.active, k.created_at]);
  }

  // Found items
  for (const f of data.found_items) {
    await client.query(`
      INSERT INTO found_items (id, user_id, platform, title, price, link, keyword, image, found_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (id) DO NOTHING
    `, [f.id, f.user_id, f.platform, f.title, f.price, f.link, f.keyword, f.image, f.found_at]);
  }

  // Bot settings
  for (const s of data.bot_settings) {
    await client.query(`
      INSERT INTO bot_settings (key, value) VALUES ($1,$2)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `, [s.key, s.value]);
  }

  // Ripristina sequenze SERIAL
  await client.query(`SELECT setval('users_id_seq', COALESCE((SELECT MAX(id) FROM users), 1))`);
  await client.query(`SELECT setval('keywords_id_seq', COALESCE((SELECT MAX(id) FROM keywords), 1))`);
  await client.query(`SELECT setval('found_items_id_seq', COALESCE((SELECT MAX(id) FROM found_items), 1))`);

  // Indici
  await client.query(`CREATE INDEX IF NOT EXISTS idx_keywords_user ON keywords(user_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_keywords_user_active ON keywords(user_id, active)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_found_items_user ON found_items(user_id, found_at DESC)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_found_items_found_at ON found_items(found_at)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_found_items_platform ON found_items(platform, found_at DESC)`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_found_items_uniq_link ON found_items(user_id, link)`);

  await client.end();

  console.log(`Importati: ${data.users.length} utenti, ${data.keywords.length} keyword, ${data.found_items.length} items, ${data.bot_settings.length} impostazioni`);
  console.log('Migrazione completata!');
}

main().catch(e => { console.error(e.message); process.exit(1); });
