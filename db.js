const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
  max: 15,
  idleTimeoutMillis: 60000,
  connectionTimeoutMillis: 15000,
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id               SERIAL PRIMARY KEY,
        email            VARCHAR(255) UNIQUE NOT NULL,
        first_name       VARCHAR(100) NOT NULL,
        last_name        VARCHAR(100) NOT NULL,
        password_hash    VARCHAR(255) NOT NULL,
        telegram_chat_id VARCHAR(100),
        vinted_enabled   BOOLEAN NOT NULL DEFAULT TRUE,
        ebay_enabled     BOOLEAN NOT NULL DEFAULT TRUE,
        plan             VARCHAR(20) NOT NULL DEFAULT 'free',
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS keywords (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        search     VARCHAR(500) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(user_id, search)
      );
      CREATE TABLE IF NOT EXISTS found_items (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        platform   VARCHAR(20) NOT NULL,
        title      TEXT NOT NULL,
        price      VARCHAR(100),
        link       TEXT NOT NULL,
        keyword    VARCHAR(500),
        image      TEXT,
        found_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(user_id, link)
      );
      CREATE INDEX IF NOT EXISTS idx_keywords_user    ON keywords(user_id);
      CREATE INDEX IF NOT EXISTS idx_found_items_user ON found_items(user_id, found_at DESC);
    `);
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id     VARCHAR(100) UNIQUE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id VARCHAR(100);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS subito_enabled         BOOLEAN NOT NULL DEFAULT TRUE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token            VARCHAR(64);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires    TIMESTAMPTZ;
      ALTER TABLE keywords ADD COLUMN IF NOT EXISTS price_max           NUMERIC DEFAULT NULL;
      ALTER TABLE keywords ADD COLUMN IF NOT EXISTS price_min           NUMERIC DEFAULT NULL;
      ALTER TABLE keywords ADD COLUMN IF NOT EXISTS active              BOOLEAN NOT NULL DEFAULT TRUE;
    `);
    // Rimuovi duplicati e garantisci il vincolo unique su found_items(user_id, link)
    // (necessario se la tabella era stata creata senza il vincolo in precedenza)
    await client.query(`
      WITH dups AS (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id, link ORDER BY found_at DESC) AS rn
        FROM found_items
      )
      DELETE FROM found_items WHERE id IN (SELECT id FROM dups WHERE rn > 1)
    `);
    try {
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_found_items_uniq_link ON found_items(user_id, link)
      `);
    } catch (err) {
      console.warn("⚠️ idx_found_items_uniq_link:", err.message);
    }
    console.log("✅ Database schema inizializzato.");
  } finally {
    client.release();
  }
}

// free: 5, pro: 25, premium: illimitato (999)
const PLAN_LIMITS = { free: 5, pro: 25, premium: 999 };

module.exports = { pool, initDB, PLAN_LIMITS };
