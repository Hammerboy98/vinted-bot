// Esporta tutti i dati dal DB attuale in export.json
const { Client } = require('pg');
require('dotenv').config();

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const users       = (await client.query('SELECT * FROM users ORDER BY id')).rows;
  const keywords    = (await client.query('SELECT * FROM keywords ORDER BY id')).rows;
  const found_items = (await client.query('SELECT * FROM found_items ORDER BY id')).rows;
  const bot_settings = (await client.query('SELECT * FROM bot_settings')).rows;

  await client.end();

  const data = { users, keywords, found_items, bot_settings };
  require('fs').writeFileSync('export.json', JSON.stringify(data, null, 2));

  console.log(`Esportati: ${users.length} utenti, ${keywords.length} keyword, ${found_items.length} items, ${bot_settings.length} impostazioni`);
  console.log('Salvato in export.json');
}

main().catch(e => { console.error(e.message); process.exit(1); });
