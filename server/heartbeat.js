const http = require('http');
const https = require('https');

class HeartbeatClient {
    constructor(instanceName, lbUrl) {
        this.instanceName = instanceName;
        this.lbUrl = String(lbUrl || '').replace(/\/$/, '');
        this.intervalMs = parseInt(process.env.HEARTBEAT_INTERVAL_MS || '1000', 10);
        this.timer = null;
    }

    send() {
        if (!this.lbUrl) return;
        let url;
        try { url = new URL(`${this.lbUrl}/api/heartbeat`); } catch (_) { return; }

        const body = JSON.stringify(require('./metrics').backendMetrics.getMetricsSnapshot(this.instanceName));
        const client = url.protocol === 'https:' ? https : http;
        const req = client.request(url, {
            method: 'POST',
            timeout: Math.max(500, Math.min(this.intervalMs, 2000)),
            rejectUnauthorized: false,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                'X-Backend-ID': this.instanceName
            }
        }, res => res.resume());
        req.on('error', () => {});
        req.on('timeout', () => req.destroy());
        req.end(body);
    }

    start() {
        this.send();
        this.timer = setInterval(() => this.send(), this.intervalMs);
        if (this.timer.unref) this.timer.unref();
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }
}

module.exports = { HeartbeatClient };
