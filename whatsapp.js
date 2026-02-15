import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";

export class WhatsAppClient {
  constructor() {
    this.sock = null;
    this.messageCallback = null;
    this._reconnectAttempts = 0;
    this._maxReconnectDelay = 30000;
    this._sentIds = new Set(); // track messages sent by the bot
  }

  async connect() {
    const { state, saveCreds } = await useMultiFileAuthState("auth");

    return new Promise((resolve, reject) => {
      this.sock = makeWASocket({
        auth: state,
      });

      this.sock.ev.on("creds.update", saveCreds);

      this.sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          console.log("[whatsapp] Scan this QR code with WhatsApp:");
          qrcode.generate(qr, { small: true });
        }

        if (connection === "open") {
          this._reconnectAttempts = 0;
          console.log("[whatsapp] Connected");
          resolve();
        }

        if (connection === "close") {
          const statusCode =
            lastDisconnect?.error?.output?.statusCode;

          if (statusCode === DisconnectReason.loggedOut) {
            console.error(
              "[whatsapp] Logged out. Delete the auth/ folder and restart to re-scan QR."
            );
            reject(new Error("Logged out"));
            return;
          }

          const delay = Math.min(
            1000 * 2 ** this._reconnectAttempts,
            this._maxReconnectDelay
          );
          this._reconnectAttempts++;
          console.log(
            `[whatsapp] Disconnected (code=${statusCode}). Reconnecting in ${delay}ms...`
          );
          setTimeout(() => this._reconnect(saveCreds), delay);
        }
      });

      this.sock.ev.on("messages.upsert", ({ messages }) => {
        this._handleUpsert(messages);
      });
    });
  }

  _handleUpsert(messages) {
    if (!this.messageCallback) return;

    for (const msg of messages) {
      const id = msg.key.id;

      // Skip messages the bot itself sent (prevents infinite loop)
      if (this._sentIds.has(id)) {
        this._sentIds.delete(id);
        continue;
      }

      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text;

      if (!text) continue;

      const quotedStanzaId =
        msg.message?.extendedTextMessage?.contextInfo?.stanzaId || null;

      const jid = msg.key.remoteJid;
      // For messages sent by the account owner (fromMe), the sender is
      // the account itself, identified by remoteJid of the "Message Yourself"
      // chat or participant. Pass fromMe so the router can auth correctly.
      Promise.resolve(
        this.messageCallback(jid, text, quotedStanzaId, msg, msg.key.fromMe)
      ).catch((err) => {
        console.error("[whatsapp] Message handler error:", err);
      });
    }
  }

  async _reconnect(saveCreds) {
    try {
      const { state, saveCreds: newSaveCreds } =
        await useMultiFileAuthState("auth");

      this.sock = makeWASocket({
        auth: state,
      });

      this.sock.ev.on("creds.update", newSaveCreds);

      this.sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          console.log("[whatsapp] Scan this QR code with WhatsApp:");
          qrcode.generate(qr, { small: true });
        }

        if (connection === "open") {
          this._reconnectAttempts = 0;
          console.log("[whatsapp] Reconnected");
        }

        if (connection === "close") {
          const statusCode =
            lastDisconnect?.error?.output?.statusCode;

          if (statusCode === DisconnectReason.loggedOut) {
            console.error("[whatsapp] Logged out during reconnect.");
            return;
          }

          const delay = Math.min(
            1000 * 2 ** this._reconnectAttempts,
            this._maxReconnectDelay
          );
          this._reconnectAttempts++;
          console.log(
            `[whatsapp] Reconnect failed. Retrying in ${delay}ms...`
          );
          setTimeout(() => this._reconnect(saveCreds), delay);
        }
      });

      this.sock.ev.on("messages.upsert", ({ messages }) => {
        this._handleUpsert(messages);
      });
    } catch (err) {
      console.error("[whatsapp] Reconnect error:", err.message);
    }
  }

  onMessage(callback) {
    this.messageCallback = callback;
  }

  async sendText(jid, text) {
    const sent = await this.sock.sendMessage(jid, { text });
    this._sentIds.add(sent.key.id);
    return sent.key.id;
  }

  async sendImage(jid, imageBuffer, caption) {
    const sent = await this.sock.sendMessage(jid, {
      image: imageBuffer,
      caption,
    });
    this._sentIds.add(sent.key.id);
    return sent.key.id;
  }

  async sendChunked(jid, text, maxLen = 4000) {
    const ids = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        ids.push(await this.sendText(jid, remaining));
        break;
      }

      let splitAt = remaining.lastIndexOf("\n", maxLen);
      if (splitAt < maxLen * 0.5) {
        splitAt = maxLen;
      }

      ids.push(await this.sendText(jid, remaining.slice(0, splitAt)));
      remaining = remaining.slice(splitAt).trimStart();
    }

    return ids;
  }

  get userJid() {
    const id = this.sock?.user?.id;
    if (!id) return null;
    // Baileys user.id may include :device suffix (e.g. "1234:5@s.whatsapp.net")
    // Normalize to plain JID for comparison with remoteJid
    return id.replace(/:\d+@/, "@");
  }

  disconnect() {
    if (this.sock) {
      this.sock.end();
      this.sock = null;
    }
  }
}
