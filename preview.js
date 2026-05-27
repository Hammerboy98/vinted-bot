/**
 * Preview server — solo UI, nessun DB / Telegram / eBay.
 * Avvia con:  node preview.js
 * Apri:       http://localhost:3001/panel/
 */
const express = require("express");
const path    = require("path");

const app  = express();
const PORT = 3001;

app.use(express.json());

// ── STATIC FILES ─────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public"), { index: false }));

// ── AUTO-LOGIN: imposta token finto e torna al pannello ───────
app.get(["/panel/login", "/panel/register"], (_req, res) => {
  res.send(`<!DOCTYPE html><html><body><script>
localStorage.setItem('panel_token','preview-token');
localStorage.setItem('panel_user',JSON.stringify({firstName:'Preview',lastName:'User',plan:'premium'}));
location.replace('/panel/');
</script></body></html>`);
});

// ── PANEL HTML ────────────────────────────────────────────────
app.get("/panel/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "panel.html"));
});

app.get("/pricing", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "pricing.html"));
});

// ── MOCK DATA ─────────────────────────────────────────────────
const KEYWORDS = [
  { id: 1, search: "charizard gold star",   item_count: 12 },
  { id: 2, search: "rayquaza gold star",    item_count: 8  },
  { id: 3, search: "umbreon gold star",     item_count: 3  },
  { id: 4, search: "espeon gold star",      item_count: 5  },
  { id: 5, search: "pikachu illustrator",   item_count: 1  },
  { id: 6, search: "lugia neo genesis psa", item_count: 0  },
];

const ITEMS = Array.from({ length: 52 }, (_, i) => {
  const kw = KEYWORDS[i % KEYWORDS.length];
  return {
    id:        i + 1,
    platform:  i % 3 === 0 ? "ebay" : "vinted",
    title:     ["Charizard Gold Star 100/101","Rayquaza Gold Star 107/107","Umbreon Gold Star 17/17",
                 "Espeon Gold Star 16/17","Pikachu Illustrator Promo","Lugia Neo Genesis PSA 10"][i % 6]
               + ` — esemplare ${i + 1}`,
    price:     `€${(Math.random() * 800 + 20).toFixed(2)}`,
    link:      `https://www.vinted.it/items/preview-${i + 1}`,
    keyword:   kw.search,
    image:     i % 4 === 0
               ? `https://images.pokemontcg.io/ex${((i % 3) + 1)}/${(i % 10) + 1}_hires.png`
               : null,
    foundAt:   new Date(Date.now() - i * 2700 * 1000).toISOString(),
  };
});

// ── API ENDPOINTS ─────────────────────────────────────────────
app.get("/panel/api/status", (_req, res) => res.json({
  isRunning:        false,
  vintedEnabled:    true,
  ebayEnabled:      true,
  vintedConfigured: true,
  ebayConfigured:   true,
  keywords:         KEYWORDS.length,
  itemsFoundToday:  9,
  lastCheckTime:    new Date(Date.now() - 4 * 60 * 1000).toISOString(),
  plan:             "premium",
  planLimit:        999,
}));

app.get("/panel/api/keywords", (_req, res) => res.json({ keywords: KEYWORDS }));

app.get("/panel/api/items", (req, res) => {
  const page     = Math.max(1, parseInt(req.query.page)  || 1);
  const limit    = Math.max(1, parseInt(req.query.limit) || 15);
  const platform = req.query.platform || "";
  const q        = (req.query.q  || "").toLowerCase();
  const kw       = (req.query.kw || "").toLowerCase();

  let filtered = ITEMS;
  if (platform) filtered = filtered.filter(it => it.platform === platform);
  if (q)        filtered = filtered.filter(it => it.title.toLowerCase().includes(q) || it.keyword.toLowerCase().includes(q));
  if (kw)       filtered = filtered.filter(it => it.keyword.toLowerCase() === kw);

  const sort = req.query.sort || "date";
  const dir  = req.query.dir  === "asc" ? 1 : -1;
  filtered = [...filtered].sort((a, b) => {
    if (sort === "price") {
      return dir * (parseFloat(a.price.replace("€","")) - parseFloat(b.price.replace("€","")));
    }
    return dir * (new Date(b.foundAt) - new Date(a.foundAt));
  });

  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / limit));
  const items = filtered.slice((page - 1) * limit, page * limit);
  res.json({ items, total, pages });
});

app.get("/panel/api/stats/daily", (_req, res) => {
  const stats = [];
  for (let i = 6; i >= 0; i--) {
    const dt = new Date();
    dt.setDate(dt.getDate() - i);
    const date = dt.toISOString().slice(0, 10);
    stats.push({ date, platform: "vinted", count: Math.floor(Math.random() * 18 + 2) });
    stats.push({ date, platform: "ebay",   count: Math.floor(Math.random() * 12 + 1) });
  }
  res.json({ stats });
});

app.get("/panel/api/profile", (_req, res) => res.json({
  firstName: "Preview", lastName: "User",
  email: "preview@local.dev", telegramChatId: "123456789", plan: "premium",
}));

// Write operations — risposta positiva senza fare nulla
app.post  ("/panel/api/toggle/:platform", (_req, res) => res.json({ enabled: true }));
app.post  ("/panel/api/run",              (_req, res) => res.json({ ok: true }));
app.post  ("/panel/api/keywords",         (_req, res) => res.json({ ok: true }));
app.delete("/panel/api/keywords",         (_req, res) => res.json({ ok: true }));
app.delete("/panel/api/items",            (_req, res) => res.json({ ok: true }));
app.put   ("/panel/api/profile",          (_req, res) => res.json({ ok: true }));

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🎨 Preview UI → http://localhost:${PORT}/panel/\n`);
  console.log("   Nessun DB · Nessun Telegram · Nessun eBay");
  console.log("   Dati mock: 52 articoli, 6 keyword, piano Premium\n");
});
