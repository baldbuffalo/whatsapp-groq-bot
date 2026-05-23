import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import P from 'pino';
import dotenv from 'dotenv';

dotenv.config();

const BOT_NAME = process.env.BOT_NAME || "chatgpt";
const PREFIX   = process.env.PREFIX   || "!ai";

async function askAI(prompt) {
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [
          {
            role: "system",
            content: "You are a helpful AI assistant inside WhatsApp. Keep replies short and useful."
          },
          { role: "user", content: prompt }
        ]
      })
    });

    const data = await res.json();

    if (!res.ok) {
      console.error("GROQ API ERROR:", JSON.stringify(data));
      return "AI failed — please try again.";
    }

    return data?.choices?.[0]?.message?.content || "No response from model.";
  } catch (err) {
    console.error("AI ERROR:", err);
    return "AI failed — please try again.";
  }
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth');

  const sock = makeWASocket({
    auth: state,
    logger: P({ level: "silent" }),
    printQRInTerminal: true,
    browser: ["WhatsApp AI Bot", "Chrome", "1.0.0"]
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      console.log(`✅ Bot connected: ${BOT_NAME}`);
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log(`❌ Connection closed (code ${code}). Reconnecting: ${shouldReconnect}`);
      if (shouldReconnect) startBot();
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    try {
      const msg = messages[0];
      if (!msg?.message) return;

      // Ignore messages sent by the bot itself
      if (msg.key.fromMe) return;

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        "";

      if (!text) return;

      const lower = text.toLowerCase();
      const isCommand =
        lower.startsWith(PREFIX.toLowerCase()) ||
        lower.includes(BOT_NAME.toLowerCase());

      if (!isCommand) return;

      const prompt = text
        .replace(new RegExp(`^${PREFIX}`, "i"), "")
        .replace(new RegExp(BOT_NAME, "gi"), "")
        .trim();

      if (!prompt) return;

      console.log(`💬 Prompt: ${prompt}`);

      const reply = await askAI(prompt);

      await sock.sendMessage(msg.key.remoteJid, { text: reply });
    } catch (err) {
      console.error("MSG ERROR:", err);
    }
  });

  console.log("🚀 Bot starting… waiting for QR scan…");
}

startBot();

// Keep GitHub Actions alive
setInterval(() => console.log("⏳ alive…"), 60_000);
