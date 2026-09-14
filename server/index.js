const express = require("express");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { Server } = require("socket.io");
require("./env");

// Global Crash Prevention
process.on("uncaughtException", (err) => {
    console.error("[Backend UncaughtException]", err.message, err.stack);
});
process.on("unhandledRejection", (reason, promise) => {
    console.error("[Backend UnhandledRejection]", reason);
});

const db = require("./db");
const { verifySignature } = require("./crypto");
const { backendMetrics } = require("./metrics");
const { HeartbeatClient } = require("./heartbeat");
const { saveMessage, getAllDecryptedMessages, getMessagesAfterId, initMessageCache, getCacheSize, getFeedJson } = require("./messageService");

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(express.static(path.join(__dirname, "../public")));

const PORT = parseInt(process.env.PORT || "3000", 10);
const INSTANCE_NAME = process.env.INSTANCE_NAME || "SYS2";
const LB_URL = process.env.LB_URL || "http://172.17.0.62:3000";
const USE_HTTPS = process.env.ENABLE_HTTPS === "true";

// Request Tracking Middleware for Performance Scoring
app.use((req, res, next) => {
    if (req.path === "/health" || req.path === "/metrics" || req.path === "/api/heartbeat") {
        return next();
    }
    const startTime = backendMetrics.startRequest();
    res.on("finish", () => {
        const isSuccess = res.statusCode < 400;
        backendMetrics.finishRequest(startTime, isSuccess);
    });
    next();
});

// ==========================================
// 1. Health & Telemetry Routes
// ==========================================
app.get("/health", (req, res) => {
    res.status(200).json({
        status: "healthy",
        backend: INSTANCE_NAME,
        cachedMessages: getCacheSize(),
        timestamp: new Date().toISOString()
    });
});

app.get("/metrics", (req, res) => {
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
app.post("/message", async (req, res) => {
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
        if (msgStr.trim().length === 0) {
            return res.status(400).json({
                status: "error",
                error: "Field 'msg' must not be empty"
            });
        }

        const result = await saveMessage({
            roomId: "LOBBY",
            sender: sender.trim(),
            text: msgStr,
            originNode: INSTANCE_NAME,
            messageId: messageId
        });

        const savedMsg = result.message;

        if (result.inserted) {
            lastProcessedId = Math.max(lastProcessedId, parseInt(savedMsg.id, 10) || 0);
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
 * Instant delivery: pre-serialized JSON served directly from memory.
 */
app.get("/feed", (req, res) => {
    try {
        const payload = getFeedJson();
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        return res.status(200).send(payload);
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

// Optimize HTTP server socket parameters for high concurrency
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.maxConnections = 50000;

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
            lastProcessedId = Math.max(lastProcessedId, parseInt(row.id, 10) || 0);
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

        if (roomUsers.size >= 4) {
            return socket.emit("room_error", "Room is full.");
        }
        const exists = [...roomUsers.values()].some(u => u.username.toLowerCase() === username.toLowerCase());
        if (exists) {
            return socket.emit("room_error", "Username already taken.");
        }

        socket.username = username;
        roomUsers.set(socket.id, { username: username, publicKey: data.publicKey });
        socket.join("LOBBY");

        socket.emit("room_joined", {
            username: username,
            users: [...roomUsers.values()].map(u => u.username),
            capacity: 4
        });

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

        const isValid = Boolean(userData.publicKey && data.signature && verifySignature(text, data.signature, userData.publicKey));
        if (!isValid) {
            return socket.emit("room_error", "Message signature verification failed.");
        }

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

            lastProcessedId = Math.max(lastProcessedId, parseInt(result.message.id, 10) || 0);

            // Emit only when this request actually inserted the message.
            // A retry with the same message_id is acknowledged by the DB but must
            // never create a second real-time copy for connected clients.
            if (result.inserted) {
                io.to("LOBBY").emit("chat_message", {
                    username: socket.username,
                    message: text,
                    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                    verified: isValid,
                    message_id: result.message.message_id
                });
            }
        } catch (err) {
            console.error(`[${INSTANCE_NAME}] Socket chat_message insert error:`, err.message);
        }
    });

    socket.on("typing_start", () => {
        if (socket.username) socket.to("LOBBY").emit("user_typing", socket.username);
    });

    socket.on("typing_stop", () => {
        if (socket.username) socket.to("LOBBY").emit("user_stopped_typing", socket.username);
    });

    const handleLeave = () => {
        if (!socket.username) return;
        roomUsers.delete(socket.id);
        io.to("LOBBY").emit("room_users_update", {
            users: [...roomUsers.values()].map(u => u.username),
            capacity: 4
        });
        socket.to("LOBBY").emit("user_left", socket.username);
        socket.username = null;
    };

    socket.on("leave_room", handleLeave);
    socket.on("disconnect", handleLeave);
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
            lastProcessedId = parseInt(res.rows[0].max, 10) || 0;
        }
    } catch (e) {
        console.warn(`[${INSTANCE_NAME}] Could not query initial MAX(id):`, e.message);
    }

    // Initialize ultra-fast in-memory message cache
    try {
        const count = await initMessageCache();
        console.log(`[${INSTANCE_NAME}] In-memory cache loaded with ${count} messages`);
    } catch (e) {
        console.warn(`[${INSTANCE_NAME}] Could not pre-populate cache:`, e.message);
    }

    // Start DB Sync interval
    setInterval(syncLoop, 500);

    // Start server listener
    server.listen(PORT, "0.0.0.0", () => {
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
