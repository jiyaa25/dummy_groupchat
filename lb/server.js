const express = require('express');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const os = require('os');
const fs = require('fs');
const path = require('path');
require('./env');

process.on('uncaughtException', err => console.error('[LB UncaughtException]', err));
process.on('unhandledRejection', err => console.error('[LB UnhandledRejection]', err));

const { BackendManager } = require('./backendManager');
const { HealthManager } = require('./healthManager');

const app = express();
const PORT = parseInt(process.env.LB_PORT || process.env.PORT || '3000', 10);
const USE_HTTPS = process.env.ENABLE_HTTPS === 'true';
const backendManager = new BackendManager();
const healthManager = new HealthManager(backendManager);
healthManager.start();

let totalRequests = 0;
let totalErrors = 0;
const latencies = [];
const lbStartTime = Date.now();
let lastCpuUsage = process.cpuUsage();
let lastCpuWall = process.hrtime.bigint();
function getLbCpuPercent() {
    const nowUsage = process.cpuUsage();
    const nowWall = process.hrtime.bigint();
    const cpuMicros = (nowUsage.user - lastCpuUsage.user) + (nowUsage.system - lastCpuUsage.system);
    const wallMicros = Number(nowWall - lastCpuWall) / 1000;
    lastCpuUsage = nowUsage; lastCpuWall = nowWall;
    return wallMicros > 0 ? Number(Math.min(100, Math.max(0, cpuMicros / wallMicros / os.cpus().length * 100)).toFixed(2)) : 0;
}

app.get(['/lb/health', '/health'], (req, res) => res.status(200).json({
    status: 'healthy', system: 'SYS1 (Load Balancer)', port: PORT, timestamp: new Date().toISOString()
}));

app.use('/api/heartbeat', express.json({ limit: '64kb' }));
app.use('/heartbeat', express.json({ limit: '64kb' }));
app.post(['/api/heartbeat', '/heartbeat'], (req, res) => {
    const payload = req.body || {};
    const backendId = payload.backend || req.headers['x-backend-id'];
    if (backendId) backendManager.updateMetrics(backendId, payload);
    res.status(200).json({ status: 'acknowledged' });
});

app.get('/lb/status', (req, res) => res.json({
    loadBalancer: 'SYS1',
    uptimeSeconds: Math.floor((Date.now() - lbStartTime) / 1000),
    backends: backendManager.getBackendList().map(b => ({
        id: b.id, url: b.url, healthy: b.healthy, score: b.score,
        isOverloaded: b.isOverloaded, queue: b.queueLength, cpu: `${b.cpu}%`,
        memory: `${b.memory}%`, activeRequests: b.activeRequests,
        inFlightRequests: b.inFlightRequests, avgResponseTime: `${b.avgResponseTime}ms`,
        routed: b.routingCount, completed: b.completedRequests, failed: b.failedRequests
    }))
}));

app.get('/lb/metrics', (req, res) => {
    const mem = process.memoryUsage();
    const totalMem = os.totalmem();
    const sorted = [...latencies].sort((a, b) => a - b);
    const percentile = p => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;
    const avg = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;
    res.json({
        timestamp: new Date().toISOString(),
        sys1_lb: {
            system: 'SYS1 (Load Balancer)', port: PORT,
            uptimeSeconds: Math.floor((Date.now() - lbStartTime) / 1000),
            totalRequests, totalErrors,
            errorRate: totalRequests ? Number((totalErrors / totalRequests * 100).toFixed(2)) : 0,
            avgResponseTimeMs: Number(avg.toFixed(2)), p50ResponseTimeMs: percentile(.5),
            p95ResponseTimeMs: percentile(.95), p99ResponseTimeMs: percentile(.99),
            memoryUsageMB: Number((mem.rss / 1024 / 1024).toFixed(2)),
            memoryPercent: Number((mem.rss / totalMem * 100).toFixed(2)),
            cpuPercent: getLbCpuPercent()
        },
        backends: backendManager.getBackendList().map(b => ({
            system: b.id, url: b.url, healthy: b.healthy, isOverloaded: b.isOverloaded,
            score: b.score, scoreBreakdown: b.scoreBreakdown, queueLength: b.queueLength,
            cpuPercent: b.cpu, memoryPercent: b.memory, activeRequests: b.activeRequests,
            inFlightRequests: b.inFlightRequests, avgResponseTimeMs: b.avgResponseTime,
            routedRequests: b.routingCount, completedRequests: b.completedRequests,
            failedRequests: b.failedRequests
        }))
    });
});

function parseTarget(baseUrl, requestPath) {
    const u = new URL(baseUrl);
    u.pathname = requestPath;
    u.search = '';
    return u;
}

function forwardHttp(req, res, backend, bodyBuffer, done) {
    const target = parseTarget(backend.url, req.originalUrl || req.url);
    const isHttps = target.protocol === 'https:';
    const client = isHttps ? https : http;
    const headers = { ...req.headers, host: target.host, 'x-routed-backend': backend.id };
    headers['x-forwarded-for'] = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    headers['x-forwarded-proto'] = req.headers['x-forwarded-proto'] || 'http';
    headers['x-forwarded-host'] = req.headers.host || '';
    if (bodyBuffer) headers['content-length'] = bodyBuffer.length;

    const options = {
        protocol: target.protocol, hostname: target.hostname, port: target.port,
        path: target.pathname + target.search, method: req.method, headers,
        rejectUnauthorized: false, timeout: 15000
    };
    const upstream = client.request(options, upstreamRes => {
        res.statusCode = upstreamRes.statusCode || 502;
        for (const [key, value] of Object.entries(upstreamRes.headers)) {
            if (value !== undefined) res.setHeader(key, value);
        }
        upstreamRes.pipe(res);
        upstreamRes.on('end', () => done(null, upstreamRes.statusCode || 502));
    });
    upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('error', err => done(err));
    if (bodyBuffer && bodyBuffer.length) upstream.write(bodyBuffer);
    else if (!['GET', 'HEAD'].includes(req.method)) req.pipe(upstream);
    upstream.end();
}

function captureBody(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.path === '/api/heartbeat' || req.path === '/heartbeat') return next();
    const chunks = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => { req.rawBody = Buffer.concat(chunks); next(); });
    req.on('error', next);
}
app.use(captureBody);

app.use((req, res) => {
    totalRequests++;
    const started = Date.now();
    const backend = backendManager.getNextBackend(req.method, req.path);
    if (!backend) {
        totalErrors++;
        return res.status(503).json({ status: 'error', error: 'No healthy backend nodes available.' });
    }

    let released = false;
    const release = () => { if (!released) { released = true; backendManager.releaseBackend(backend); } };
    const finish = (err, statusCode) => {
        if (err) {
            healthManager.recordFailure(backend, err.message);
            totalErrors++;
            if (!res.headersSent) res.status(502).json({ status: 'error', error: 'Bad Gateway: backend request failed.' });
        } else {
            if (statusCode >= 500) { totalErrors++; healthManager.recordFailure(backend, `HTTP ${statusCode}`); }
            else healthManager.recordSuccess(backend, Date.now() - started);
        }
    };

    forwardHttp(req, res, backend, req.rawBody, (err, statusCode) => {
        release();
        const ms = Date.now() - started;
        latencies.push(ms); if (latencies.length > 500) latencies.shift();
        finish(err, statusCode);
    });

    res.on('close', release);
});

function proxyWebSocket(req, clientSocket, head, backend) {
    const target = new URL(backend.url);
    const connectOptions = { host: target.hostname, port: Number(target.port || (target.protocol === 'https:' ? 443 : 80)) };
    const upstream = target.protocol === 'https:' ? tls.connect({ ...connectOptions, rejectUnauthorized: false }) : net.connect(connectOptions);
    let connected = false;
    const onConnected = () => {
        if (connected) return;
        connected = true;
        const headers = Object.entries(req.headers).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('\r\n');
        const pathWithQuery = req.url || '/';
        upstream.write(`${req.method || 'GET'} ${pathWithQuery} HTTP/1.1\r\n${headers}\r\n\r\n`);
        if (head && head.length) upstream.write(head);
        clientSocket.pipe(upstream).pipe(clientSocket);
        backend.wsConnections = (backend.wsConnections || 0) + 1;
        clientSocket.on('close', () => {
            backend.wsConnections = Math.max(0, (backend.wsConnections || 1) - 1);
        });
    };
    upstream.once('connect', onConnected);
    upstream.once('secureConnect', onConnected);
    upstream.on('error', err => {
        healthManager.recordFailure(backend, err.message);
        clientSocket.destroy();
    });
}

let server;
const keyPath = path.join(__dirname, '../key.pem');
const certPath = path.join(__dirname, '../cert.pem');
if (USE_HTTPS && fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    server = https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, app);
} else {
    server = http.createServer(app);
}
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.maxConnections = 50000;

server.on('upgrade', (req, socket, head) => {
    const backend = backendManager.getNextBackend('WS', req.url);
    if (!backend) return socket.destroy();
    // WebSocket connections are long-lived; do not let them permanently inflate
    // the normal HTTP in-flight counter.
    backend.inFlightRequests = Math.max(0, backend.inFlightRequests - 1);
    proxyWebSocket(req, socket, head, backend);
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`[SYS1] Dynamic Load Balancer listening on port ${PORT}`);
    console.log('Endpoints: POST /message | GET /feed | GET /lb/metrics | GET /lb/status | GET /lb/health');
});

module.exports = { app, server, backendManager };
