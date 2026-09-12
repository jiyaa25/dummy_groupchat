require("dotenv").config();
const express = require("express");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const httpProxy = require("http-proxy");
const cors = require("cors");
const os = require("os");

const { BackendManager } = require("./backendManager");
const { HealthManager } = require("./healthManager");

const app = express();
const PORT = parseInt(process.env.LB_PORT || process.env.PORT || "3261", 10);
const USE_HTTPS = process.env.ENABLE_HTTPS === "true" || process.env.HTTPS === "true";

const backendManager = new BackendManager();
const healthManager = new HealthManager(backendManager);
healthManager.start();

// LB Telemetry
const lbStartTime = Date.now();
let totalRequests = 0;
let totalErrors = 0;
let latencies = [];

// Create reverse proxy
const proxy = httpProxy.createProxyServer({
    ws: true,
    changeOrigin: true,
    secure: false, // Allow self-signed certs
    timeout: 5000,
    proxyTimeout: 5000
});

// Middleware
app.use(cors());

// Automatically re-stream body if it was parsed
proxy.on('proxyReq', (proxyReq, req, res, options) => {
    if (req.body && Object.keys(req.body).length > 0) {
        const bodyData = JSON.stringify(req.body);
        proxyReq.setHeader('Content-Type', 'application/json');
        proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
        proxyReq.write(bodyData);
    }
});

// ==========================================
// 1. Load Balancer Administrative Endpoints
// ==========================================

/**
 * POST /api/heartbeat
 * Receives metrics telemetry pushes from backends.
 */
app.post(['/api/heartbeat', '/heartbeat'], express.json(), (req, res) => {
    try {
        const payload = req.body || {};
        const backendId = payload.backend || req.headers['x-backend-id'];
        if (backendId) {
            backendManager.updateMetrics(backendId, payload);
        }
        return res.status(200).json({ status: "acknowledged" });
    } catch (e) {
        return res.status(400).json({ error: e.message });
    }
});

/**
 * GET /lb/status
 * Returns current status of all managed backends.
 */
app.get('/lb/status', (req, res) => {
    const list = backendManager.getBackendList().map(b => ({
        id: b.id,
        url: b.url,
        healthy: b.healthy,
        score: b.score,
        isOverloaded: b.isOverloaded,
        queue: b.queueLength,
        cpu: `${b.cpu}%`,
        memory: `${b.memory}%`,
        activeRequests: b.activeRequests,
        avgResponseTime: `${b.avgResponseTime}ms`,
        routed: b.routingCount,
        completed: b.completedRequests,
        failed: b.failedRequests
    }));
    return res.status(200).json({
        loadBalancer: "Sys1",
        uptimeSeconds: Math.floor((Date.now() - lbStartTime) / 1000),
        backends: list
    });
});

/**
 * GET /lb/metrics
 * Returns comprehensive metrics for all 4 systems (Sys1 LB + Sys2/Sys3/Sys4 backends).
 */
app.get('/lb/metrics', (req, res) => {
    const mem = process.memoryUsage();
    const totalSysMem = os.totalmem();

    // Calculate latency percentiles
    const sortedLatencies = [...latencies].sort((a, b) => a - b);
    const p50 = sortedLatencies.length > 0 ? sortedLatencies[Math.floor(sortedLatencies.length * 0.50)] : 0;
    const p95 = sortedLatencies.length > 0 ? sortedLatencies[Math.floor(sortedLatencies.length * 0.95)] : 0;
    const p99 = sortedLatencies.length > 0 ? sortedLatencies[Math.floor(sortedLatencies.length * 0.99)] : 0;
    const avgLatency = sortedLatencies.length > 0
        ? parseFloat((sortedLatencies.reduce((a, b) => a + b, 0) / sortedLatencies.length).toFixed(2))
        : 0;

    const lbMetrics = {
        system: "SYS1 (Load Balancer)",
        port: PORT,
        uptimeSeconds: Math.floor((Date.now() - lbStartTime) / 1000),
        totalRequests: totalRequests,
        totalErrors: totalErrors,
        errorRate: totalRequests > 0 ? parseFloat(((totalErrors / totalRequests) * 100).toFixed(2)) : 0,
        avgResponseTimeMs: avgLatency,
        p50ResponseTimeMs: p50,
        p95ResponseTimeMs: p95,
        p99ResponseTimeMs: p99,
        memoryUsageMB: parseFloat((mem.rss / 1024 / 1024).toFixed(2)),
        memoryPercent: parseFloat(((mem.rss / totalSysMem) * 100).toFixed(2))
    };

    const backendMetrics = backendManager.getBackendList().map(b => ({
        system: b.id,
        url: b.url,
        healthy: b.healthy,
        isOverloaded: b.isOverloaded,
        score: b.score,
        scoreBreakdown: b.scoreBreakdown,
        queueLength: b.queueLength,
        cpuPercent: b.cpu,
        memoryPercent: b.memory,
        activeRequests: b.activeRequests,
        avgResponseTimeMs: b.avgResponseTime,
        routedRequests: b.routingCount,
        completedRequests: b.completedRequests,
        failedRequests: b.failedRequests
    }));

    return res.status(200).json({
        timestamp: new Date().toISOString(),
        sys1_lb: lbMetrics,
        backends: backendMetrics
    });
});

// ==========================================
// 2. Dynamic Reverse Proxy Handler
// ==========================================
app.use((req, res) => {
    totalRequests++;
    const startTime = Date.now();

    // Select backend based on Least Queue + Performance Score + Overload Threshold
    const backend = backendManager.getNextBackend(req.method, req.path);

    if (!backend) {
        totalErrors++;
        return res.status(503).json({
            status: "error",
            error: "503 Service Unavailable: No healthy backend nodes available."
        });
    }

    // Prepare proxy options
    const targetUrl = backend.url;

    // Set standard proxy headers
    req.headers["x-forwarded-for"] = req.ip || req.connection.remoteAddress;
    req.headers["x-forwarded-proto"] = req.protocol;
    req.headers["x-forwarded-host"] = req.headers.host;
    req.headers["x-routed-backend"] = backend.id;

    // Forward request
    proxy.web(req, res, { target: targetUrl }, (err) => {
        // Proxy error handler (Passive failure detection)
        healthManager.recordFailure(backend, err.message);
        totalErrors++;
        console.error(`[LB] Proxy error to ${backend.id} (${targetUrl}):`, err.message);

        // Safe retry mechanism for idempotent operations
        if (!res.headersSent) {
            const retryBackend = backendManager.getNextBackend(req.method, req.path);
            if (retryBackend && retryBackend.id !== backend.id) {
                console.log(`[LB] Retrying ${req.method} ${req.path} -> ${retryBackend.id}`);
                proxy.web(req, res, { target: retryBackend.url }, (retryErr) => {
                    healthManager.recordFailure(retryBackend, retryErr.message);
                    if (!res.headersSent) {
                        res.status(502).json({
                            status: "error",
                            error: "Bad Gateway: All retry attempts failed."
                        });
                    }
                });
                return;
            }

            res.status(502).json({
                status: "error",
                error: `Bad Gateway: Target backend ${backend.id} failed.`
            });
        }
    });

    res.on("finish", () => {
        const duration = Date.now() - startTime;
        latencies.push(duration);
        if (latencies.length > 500) latencies.shift();

        if (res.statusCode < 500) {
            healthManager.recordSuccess(backend, duration);
        } else {
            healthManager.recordFailure(backend, `HTTP ${res.statusCode}`);
        }
    });
});

// ==========================================
// 3. Server Listener & WebSocket Upgrade
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
    console.log(`[Sys1 LB] Running on HTTPS port ${PORT}`);
} else {
    server = http.createServer(app);
    console.log(`[Sys1 LB] Running on HTTP port ${PORT}`);
}

// Handle WebSocket upgrade for Socket.IO
server.on("upgrade", (req, socket, head) => {
    const backend = backendManager.getNextBackend("WS", req.url);
    if (!backend) {
        socket.destroy();
        return;
    }

    proxy.ws(req, socket, head, { target: backend.url }, (err) => {
        console.error(`[LB] WebSocket proxy error to ${backend.id}:`, err.message);
        healthManager.recordFailure(backend, err.message);
        socket.destroy();
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`====================================================`);
    console.log(`[Sys1] Dynamic Load Balancer listening on port ${PORT}`);
    console.log(`Routing Algorithm: Least Queue + Performance Aware Score`);
    console.log(`Endpoints: POST /message | GET /feed | GET /lb/metrics | GET /lb/status`);
    console.log(`====================================================`);
});

module.exports = { app, server, backendManager };
