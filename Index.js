import makeWASocket, { useMultiFileAuthState } from '@whiskeysockets/baileys';
import P from 'pino';
import dotenv from 'dotenv';

dotenv.config();

const BOT_NAME = process.env.BOT_NAME || "chatgpt";
const PREFIX = process.env.PREFIX || "!ai";

async function askAI(prompt) {
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
          content: "You are ChatGPT inside a WhatsApp group. Keep answers short and helpful."
        },
        {
          role: "user",
          content: prompt
        }
      ]
    })
  });

  const data = await res.json();
  return data.choices?.[0]?.message?.content || "No response";
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth');

  const sock = makeWASocket({
    auth: state,
    logger: P({ level: "silent" }),
    printQRInTerminal: true
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    if (update.connection === "open") {
      console.log("✅ Bot connected as", BOT_NAME);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
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

    const reply = await askAI(prompt);

    await sock.sendMessage(msg.key.remoteJid, {
      text: reply
    });
  });
}

startBot();
