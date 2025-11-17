const axios = require("axios");
const cheerio = require("cheerio");
const TelegramBot = require("node-telegram-bot-api");
const express = require("express");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
// PASSO CHIAVE: Carica le variabili dal file .env
require("dotenv").config();

// Leggi le variabili da process.env
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

// ============================================
// AGGIUNGI QUI IL LOG PER VEDERE COSA VIENE LETTO
// ============================================
console.log("Token letto da .env:", process.env.TELEGRAM_TOKEN);
console.log("Chat ID letto da .env:", CHAT_ID);
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

try {
  bot.sendMessage(CHAT_ID, "🤖 Il Vinted Notifier è attivo e vivo!");
  console.log("✅ Messaggio di test inviato su Telegram.");
} catch (e) {
  console.error("❌ ERRORE CRITICO TEST TELEGRAM:", e.message);
}

const KEYWORDS = [
  "Pokemon Crystal",
  "Pokemon Goldstar ",
  "Pokemon holo Mint ",
  "Lotto Pokemon vintage",
  "charizard",
  "Scarpe Nike",
];
let notifiedLinks = new Set();

async function checkVinted() {
  try {
    for (let keyword of KEYWORDS) {
      const url =
        "https://www.vinted.it/vetements?search_text=" +
        encodeURIComponent(keyword);
      const response = await axios.get(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        },
      });
      const $ = cheerio.load(response.data);

      $('a[href*="/items/"]').each((i, el) => {
        const link = "https://www.vinted.it" + $(el).attr("href").split("?")[0];
        const title = $(el).find("h3").text().toLowerCase();

        if (title.includes(keyword.toLowerCase()) && !notifiedLinks.has(link)) {
          notifiedLinks.add(link);
          bot.sendMessage(
            CHAT_ID,
            `🛍️ *Trovato articolo!* \n${title}\n🔗 ${link}`,
            { parse_mode: "Markdown" }
          );
          console.log("✅ Notificato:", title);
        }
      });
      await delay(1000);
    }
  } catch (error) {
    console.error("❌ Errore nel controllo Vinted:", error.message);
  }
}

// Pulisce link vecchi ogni 12 ore
setInterval(() => {
  notifiedLinks.clear();
  console.log("🔄 Pulito il set dei link notificati");
}, 12 * 60 * 60 * 1000);

// Controlla ogni 15 minuti
setInterval(checkVinted, 15 * 60 * 1000);
checkVinted(); // primo controllo all'avvio

const app = express();
// Render usa la variabile PORT per indicare su quale porta ascoltare
const port = process.env.PORT || 3000;

// Endpoint di stato per soddisfare Render
app.get("/", (req, res) => {
  res.send("Vinted Notifier is running in the background.");
});

// Avvia il server
app.listen(port, () => {
  console.log(`Web server listening on port ${port}`);
});
