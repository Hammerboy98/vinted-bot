// Aggiorna DATABASE_URL su Render via API
const https = require('https');

const API_KEY = 'rnd_9OqltWItnNcvAqBvR8AeXUKOIalJ';
const SERVICE_ID = 'srv-d4fj25muk2gs73fd48jg';
const NEW_DB_URL = 'postgresql://neondb_owner:npg_Lkt5TgHrWYE3@ep-misty-breeze-a2ah2cad.eu-central-1.aws.neon.tech/neondb?sslmode=require';

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.render.com',
      path,
      method,
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(buf) }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  // GET env vars attuali
  const get = await request('GET', `/v1/services/${SERVICE_ID}/env-vars`);
  if (get.status !== 200) { console.error('GET fallito:', get.body); process.exit(1); }

  // Sostituisci DATABASE_URL, mantieni tutto il resto
  const envVars = get.body.map(item => ({
    key: item.envVar.key,
    value: item.envVar.key === 'DATABASE_URL' ? NEW_DB_URL : item.envVar.value
  }));

  // PUT aggiornato
  const put = await request('PUT', `/v1/services/${SERVICE_ID}/env-vars`, envVars);
  if (put.status !== 200) { console.error('PUT fallito:', put.body); process.exit(1); }

  const dbVar = put.body.find(x => x.envVar.key === 'DATABASE_URL');
  console.log('DATABASE_URL aggiornato:', dbVar.envVar.value.substring(0, 60) + '...');
  console.log('Totale env var: ' + put.body.length);
  console.log('Render fara il redeploy automatico.');
}

main().catch(e => { console.error(e.message); process.exit(1); });
