import express from "express";
import http from "http";
import { Server } from "socket.io";
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys";
import P from "pino";
import QRCode from "qrcode";
import dotenv from "dotenv";

dotenv.config();

const BOT_NAME = process.env.BOT_NAME || "chatgpt";
const PREFIX = process.env.PREFIX || "!ai";
const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Cache latest QR + state so late-joining browsers catch up
let lastQR = null;
let botConnectedName = null;

io.on("connection", (socket) => {
  if (botConnectedName) {
    socket.emit("connected", botConnectedName);
  } else if (lastQR) {
    socket.emit("qr", lastQR);
  }
});

// ── UI ────────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>WhatsApp Bot</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      background: #0d1117;
      color: #e6edf3;
      font-family: 'Segoe UI', sans-serif;
      gap: 24px;
      padding: 32px;
    }
    h1 { font-size: 1.6rem; font-weight: 600; }
    #status {
      font-size: 0.95rem;
      color: #8b949e;
      min-height: 24px;
    }
    #status.connected { color: #3fb950; }
    #qr-wrap {
      background: #fff;
      border-radius: 16px;
      padding: 16px;
      display: none;
    }
    #qr { display: block; }
    #tick {
      display: none;
      font-size: 4rem;
    }
  </style>
</head>
<body>
  <h1>📱 WhatsApp Bot</h1>
  <p id="status">Waiting for QR code…</p>
  <div id="qr-wrap"><img id="qr" width="260" height="260" alt="QR Code"/></div>
  <div id="tick">✅</div>

  <script src="/socket.io/socket.io.js"></script>
  <script>
    const socket = io();
    const status  = document.getElementById("status");
    const qrWrap  = document.getElementById("qr-wrap");
    const qrImg   = document.getElementById("qr");
    const tick    = document.getElementById("tick");

    socket.on("qr", (data) => {
      qrImg.src = data;
      qrWrap.style.display = "block";
      tick.style.display   = "none";
      status.textContent   = "Scan with WhatsApp → Linked Devices → Link a Device";
      status.className     = "";
    });

    socket.on("connected", (name) => {
      qrWrap.style.display = "none";
      tick.style.display   = "block";
      status.textContent   = "Bot connected as " + name;
      status.className     = "connected";
    });

    socket.on("disconnected", () => {
      tick.style.display   = "none";
      qrWrap.style.display = "none";
      status.textContent   = "Disconnected — reconnecting…";
      status.className     = "";
    });
  </script>
</body>
</html>`);
});

// ── AI ────────────────────────────────────────────────────────────────────────
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
          { role: "system", content: "You are ChatGPT. Talk like a real person — casual, natural, like texting a friend. Use short sentences. Match the user's energy and tone. If they're chill, be chill. If they send an emoji, respond naturally like a human would, not by explaining the emoji. Don't use bullet points or formal structure unless specifically asked. Never reveal that you are built on Llama or any other model." },
          { role: "user", content: prompt }
        ]
      })
    });

    const data = await res.json();

    if (!res.ok) {
      console.error("GROQ API ERROR:", JSON.stringify(data));
      return "AI failed — please try again.";
    }

    return data?.choices?.[0]?.message?.content || "No response";
  } catch (err) {
    console.error("AI ERROR:", err);
    return "AI failed — please try again.";
  }
}

// ── Sent message ID tracking (for reply detection) ────────────────────────────
const sentMessageIds = new Set();
const MAX_TRACKED = 200;

function trackSentId(id) {
  if (!id) return;
  sentMessageIds.add(id);
  if (sentMessageIds.size > MAX_TRACKED) {
    sentMessageIds.delete(sentMessageIds.values().next().value);
  }
}

// ── Bot ───────────────────────────────────────────────────────────────────────
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth");

  const sock = makeWASocket({
    auth: state,
    logger: P({ level: "silent" }),
    // do NOT set printQRInTerminal — we serve it via the web page
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { qr, connection, lastDisconnect } = update;

    if (qr) {
      const img = await QRCode.toDataURL(qr);
      lastQR = img;
      botConnectedName = null;
      io.emit("qr", img);
      console.log(`QR ready — open http://localhost:${PORT}`);
    }

    if (connection === "open") {
      const botJid  = sock.user?.id || "unknown";
      const botName = sock.user?.name || BOT_NAME;
      console.log(`✅ Bot connected: ${botName} (${botJid})`);
      lastQR = null;
      botConnectedName = botName;
      io.emit("connected", botName);
    }

    if (connection === "close") {
      botConnectedName = null;
      io.emit("disconnected");
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log(`❌ Connection closed (code ${code}). Reconnecting: ${shouldReconnect}`);
      if (shouldReconnect) startBot();
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    // only handle newly received messages, not history sync
    if (type !== "notify") return;

    try {
      const msg = messages[0];
      if (!msg?.message) return;

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        "";

      if (!text) return;

      // ── Reply detection ───────────────────────────────────────────────────
      const contextInfo = msg.message.extendedTextMessage?.contextInfo;
      const quotedId    = contextInfo?.stanzaId;
      const isReplyToBot = quotedId && sentMessageIds.has(quotedId);

      // ── Trigger check ─────────────────────────────────────────────────────
      const lower = text.toLowerCase();
      const isCommand =
        lower.startsWith(PREFIX.toLowerCase()) ||
        lower.startsWith(BOT_NAME.toLowerCase()) ||
        isReplyToBot;

      if (!isCommand) return;

      // ── Build prompt (strip trigger, include quoted context if present) ───
      let userText = text
        .replace(new RegExp(`^${PREFIX}`, "i"), "")
        .replace(new RegExp(`^${BOT_NAME}`, "i"), "")
        .trim();

      // Attach the quoted message as context so the AI can read it
      const quotedText =
        contextInfo?.quotedMessage?.conversation ||
        contextInfo?.quotedMessage?.extendedTextMessage?.text ||
        "";

      const prompt = quotedText
        ? `[Quoted message: "${quotedText}"]\n${userText || "What is this?"}`
        : userText;

      if (!prompt) return;

      console.log(`💬 [${msg.key.remoteJid}] ${prompt}`);

      const reply = await askAI(prompt);

      const sent = await sock.sendMessage(msg.key.remoteJid, { text: reply });
      trackSentId(sent?.key?.id);
    } catch (err) {
      console.error("MSG ERROR:", err);
    }
  });
}

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`🚀 Server running → http://localhost:${PORT}`);
});

startBot();
