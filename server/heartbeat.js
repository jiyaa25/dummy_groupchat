const http = require("http");
const https = require("https");
const { backendMetrics } = require("./metrics");

class HeartbeatClient {
    constructor(instanceName, lbUrl, intervalMs = 1000) {
        this.instanceName = instanceName;
        this.lbUrl = lbUrl || process.env.LB_URL || "http://10.1.75.79:3261";
        this.intervalMs = parseInt(process.env.HEARTBEAT_INTERVAL_MS || intervalMs, 10);
        this.timer = null;
        this.isRunning = false;
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        console.log(`[Heartbeat] Starting heartbeat client for ${this.instanceName} -> ${this.lbUrl} (${this.intervalMs}ms)`);
        
        // Initial immediate send
        this.sendHeartbeat();
        this.timer = setInterval(() => {
            this.sendHeartbeat();
        }, this.intervalMs);
        if (this.timer.unref) this.timer.unref();
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.isRunning = false;
    }

    sendHeartbeat() {
        try {
            const metrics = backendMetrics.getMetricsSnapshot(this.instanceName);
            const payload = JSON.stringify(metrics);

            const urlObj = new URL("/api/heartbeat", this.lbUrl);
            const isHttps = urlObj.protocol === "https:";
            const client = isHttps ? https : http;

            const req = client.request(urlObj, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(payload)
                },
                timeout: 1500,
                rejectUnauthorized: false
            }, (res) => {
                res.resume(); // consume response body
            });

            req.on("error", (err) => {
                // Non-fatal: LB might be starting up or under test
            });

            req.on("timeout", () => {
                req.destroy();
            });

            req.write(payload);
            req.end();
        } catch (err) {
            // Non-fatal error protection
        }
    }
}

module.exports = {
    HeartbeatClient
};
