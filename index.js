import makeWASocket, { useMultiFileAuthState } from '@whiskeysockets/baileys';
import P from 'pino';
import dotenv from 'dotenv';

dotenv.config();

const BOT_NAME = process.env.BOT_NAME || "chatgpt";
const PREFIX = process.env.PREFIX || "!ai";

async function askAI(prompt) {
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: "llama-3.1-70b-versatile",
        messages: [
          {
            role: "system",
            content: "You are ChatGPT inside WhatsApp. Keep replies short and useful."
          },
          {
            role: "user",
            content: prompt
          }
        ]
      })
    });

    const data = await res.json();
    return data?.choices?.[0]?.message?.content || "No response";
  } catch (err) {
    console.log("AI ERROR:", err);
    return "AI failed";
  }
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth');

  const sock = makeWASocket({
    auth: state,
    logger: P({ level: "silent" }),
    printQRInTerminal: true,
    browser: ["ChatGPT Bot", "Chrome", "1.0.0"]
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, qr } = update;

    console.log("🔄 connection:", connection);

    if (qr) {
      console.log("\n====================");
      console.log("📱 SCAN QR BELOW:");
      console.log(qr);
      console.log("====================\n");
    }

    if (connection === "open") {
      console.log("✅ Bot connected:", BOT_NAME);
    }

    if (connection === "close") {
      console.log("❌ Connection closed");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    try {
      const msg = messages[0];
      if (!msg.message) return;

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text;

      if (!text) return;

      const isCommand =
        text.startsWith(PREFIX) ||
        text.toLowerCase().includes(BOT_NAME);

      if (!isCommand) return;

      const prompt = text
        .replace(PREFIX, "")
        .replace(new RegExp(BOT_NAME, "gi"), "")
        .trim();

      if (!prompt) return;

      console.log("💬 Prompt:", prompt);

      const reply = await askAI(prompt);

      await sock.sendMessage(msg.key.remoteJid, {
        text: reply
      });

    } catch (err) {
      console.log("MSG ERROR:", err);
    }
  });

  console.log("🚀 Bot starting... waiting for QR...");
}

// start bot
startBot();

// 🔥 CRITICAL: keep GitHub Actions alive
setInterval(() => {
  console.log("⏳ alive...");
}, 60000);
