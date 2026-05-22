import express from "express";
import http from "http";
import { Server } from "socket.io";
import makeWASocket, { useMultiFileAuthState } from "@whiskeysockets/baileys";
import P from "pino";
import QRCode from "qrcode";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.get("/", (req, res) => {
  res.send(`
    <html>
      <body style="text-align:center;font-family:sans-serif;">
        <h2>WhatsApp Bot QR</h2>
        <img id="qr" width="300"/>
        <script src="/socket.io/socket.io.js"></script>
        <script>
          const socket = io();
          socket.on("qr", (data) => {
            document.getElementById("qr").src = data;
          });
        </script>
      </body>
    </html>
  `);
});

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth");

  const sock = makeWASocket({
    auth: state,
    logger: P({ level: "silent" })
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { qr, connection } = update;

    if (qr) {
      const img = await QRCode.toDataURL(qr);
      io.emit("qr", img);
      console.log("QR sent to browser");
    }

    if (connection === "open") {
      console.log("Bot connected");
    }
  });
}

startBot();

server.listen(3000, () => {
  console.log("Open http://localhost:3000");
});
