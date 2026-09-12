require("dotenv").config();
const express = require("express");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const { Server } = require("socket.io");

const db = require("./db");
const { encrypt, decrypt, verifySignature } = require("./crypto");
const { saveMessage, getAllDecryptedMessages, getMessagesAfterId } = require("./messageService");
const { backendMetrics, metricsMiddleware } = require("./metrics");
const { HeartbeatClient } = require("./heartbeat");

const app = express();
const PORT = parseInt(process.env.PORT || "3262", 10);
const INSTANCE_NAME = process.env.INSTANCE_NAME || "SYS2";
const LB_URL = process.env.LB_URL || "http://10.1.75.79:3261";
const USE_HTTPS = process.env.ENABLE_HTTPS === "true" || process.env.HTTPS === "true";

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(metricsMiddleware);
app.use(express.static(path.join(__dirname, "../public")));

// ==========================================
// 1. Health & Metrics Routes
// ==========================================
app.get('/health', (req, res) => {
    res.status(200).json({
        status: "ok",
        backend: INSTANCE_NAME,
        timestamp: new Date().toISOString()
    });
});

app.get('/metrics', (req, res) => {
    res.status(200).json(backendMetrics.getMetricsSnapshot(INSTANCE_NAME));
});

// ==========================================
// 2. Canonical Assignment REST API
// ==========================================

/**
 * POST /message
 * Required inputs:
 *  - "client-name" (or client_name, username, sender)
 *  - "msg" (or message, text)
 *  - optional "message_id"
 */
app.post('/message', async (req, res) => {
    try {
        const body = req.body || {};
        const sender = body["client-name"] || body.client_name || body.username || body.sender;
        const msg = body.msg !== undefined ? body.msg : (body.message !== undefined ? body.message : body.text);
        const messageId = body.message_id || body.messageId || null;

        if (!sender || typeof sender !== "string" || !sender.trim()) {
            return res.status(400).json({
                status: "error",
                error: "Missing required field 'client-name'"
            });
        }
        if (msg === undefined || msg === null) {
            return res.status(400).json({
                status: "error",
                error: "Missing required field 'msg'"
            });
        }

        const msgStr = String(msg);
        const result = await saveMessage({
            roomId: "LOBBY",
            sender: sender.trim(),
            text: msgStr,
            originNode: INSTANCE_NAME,
            messageId: messageId
        });

        const savedMsg = result.message;

        // If newly inserted, broadcast to connected Socket.IO clients on this node
        if (result.inserted) {
            lastProcessedId = Math.max(lastProcessedId, savedMsg.id || 0);
            io.to("LOBBY").emit("chat_message", {
                username: savedMsg.sender,
                message: savedMsg.text,
                timestamp: new Date(savedMsg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                verified: true,
                message_id: savedMsg.message_id
            });
        }

        return res.status(200).json({
            status: "success",
            message_id: savedMsg.message_id,
            "client-name": savedMsg.sender,
            msg: savedMsg.text,
            timestamp: savedMsg.timestamp,
            duplicate: result.duplicate,
            origin_node: savedMsg.origin_node
        });
    } catch (err) {
        console.error(`[${INSTANCE_NAME}] POST /message error:`, err.message);
        return res.status(500).json({
            status: "error",
            error: err.message
        });
    }
});

/**
 * GET /feed
 * Retrieves all stored messages in chronological order.
 */
app.get('/feed', async (req, res) => {
    try {
        const messages = await getAllDecryptedMessages();
        return res.status(200).json({
            status: "success",
            count: messages.length,
            messages: messages
        });
    } catch (err) {
        console.error(`[${INSTANCE_NAME}] GET /feed error:`, err.message);
        return res.status(500).json({
            status: "error",
            error: err.message
        });
    }
});

// ==========================================
// 3. Server Instantiation (HTTP / HTTPS)
// ==========================================
let server;
const keyPath = path.join(__dirname, "../key.pem");
const certPath = path.join(__dirname, "../cert.pem");

if (USE_HTTPS && fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    const options = {
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath)
    };
    server = https.createServer(options, app);
    console.log(`[${INSTANCE_NAME}] Running in HTTPS mode`);
} else {
    server = http.createServer(app);
    console.log(`[${INSTANCE_NAME}] Running in HTTP mode`);
}

const io = new Server(server, {
    cors: { origin: "*" }
});

// ==========================================
// 4. Inter-instance Sync Loop (500ms polling)
// ==========================================
let lastProcessedId = 0;

async function syncLoop() {
    try {
        const newRows = await getMessagesAfterId(lastProcessedId);
        for (let row of newRows) {
            lastProcessedId = Math.max(lastProcessedId, row.id);
            // Broadcast if originating from another backend node
            if (row.origin_node !== INSTANCE_NAME) {
                io.to("LOBBY").emit("chat_message", {
                    username: row.sender,
                    message: row.decryptedContent,
                    timestamp: new Date(row.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                    verified: true,
                    message_id: row.message_id
                });
            }
        }
    } catch (e) {
        // Non-fatal sync polling catch
    }
}

// ==========================================
// 5. Socket.IO Real-time Logic
// ==========================================
const roomUsers = new Map();

io.on("connection", (socket) => {
    socket.on("join_room", async (data) => {
        const username = String(data.username || "").trim();
        if (!username) return;

        socket.username = username;
        roomUsers.set(socket.id, { username: username, publicKey: data.publicKey });
        socket.join("LOBBY");

        // Send confirmation and current user list
        socket.emit("room_joined", {
            username: username,
            users: [...roomUsers.values()].map(u => u.username),
            capacity: 4
        });

        // Send recent chat history
        try {
            const all = await getAllDecryptedMessages();
            const recent = all.slice(-20).map(m => ({
                username: m.sender,
                message: m.msg,
                timestamp: new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                verified: true,
                message_id: m.message_id
            }));
            socket.emit("message_history", recent);
        } catch (e) {}

        io.to("LOBBY").emit("system_log", `${username} joined via ${INSTANCE_NAME}`);
        io.to("LOBBY").emit("room_users_update", {
            users: [...roomUsers.values()].map(u => u.username),
            capacity: 4
        });
    });

    socket.on("chat_message", async (data) => {
        if (!socket.username) return;
        const userData = roomUsers.get(socket.id);
        if (!userData) return;

        const text = String(data.message || "").trim();
        if (!text) return;

        const isValid = userData.publicKey && data.signature
            ? verifySignature(text, data.signature, userData.publicKey)
            : true;

        try {
            const result = await saveMessage({
                roomId: "LOBBY",
                sender: socket.username,
                text: text,
                signature: data.signature,
                publicKey: userData.publicKey,
                originNode: INSTANCE_NAME,
                messageId: data.message_id || null
            });

            lastProcessedId = Math.max(lastProcessedId, result.message.id || 0);

            io.to("LOBBY").emit("chat_message", {
                username: socket.username,
                message: text,
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                verified: isValid,
                message_id: result.message.message_id
            });
        } catch (err) {
            console.error(`[${INSTANCE_NAME}] Socket chat_message insert error:`, err.message);
        }
    });

    socket.on("disconnect", () => {
        if (socket.username) {
            roomUsers.delete(socket.id);
            io.to("LOBBY").emit("room_users_update", {
                users: [...roomUsers.values()].map(u => u.username),
                capacity: 4
            });
        }
    });
});

// ==========================================
// 6. Bootstrap Server & Heartbeat Client
// ==========================================
async function start() {
    await db.initDb();

    // Query initial max id
    try {
        const res = await db.query("SELECT MAX(id) FROM messages");
        if (res.rows && res.rows[0]) {
            lastProcessedId = res.rows[0].max || 0;
        }
    } catch (e) {}

    // Start DB Sync interval
    setInterval(syncLoop, 500);

    // Start server listener
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`[${INSTANCE_NAME}] Backend server listening on port ${PORT}`);
        
        // Start sending heartbeats to Sys1 LB
        const heartbeat = new HeartbeatClient(INSTANCE_NAME, LB_URL);
        heartbeat.start();
    });
}

if (require.main === module) {
    start().catch(err => {
        console.error(`[${INSTANCE_NAME}] Fatal startup error:`, err);
    });
}

module.exports = { app, server };
