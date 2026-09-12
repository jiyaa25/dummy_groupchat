const http = require("http");
const https = require("https");

class HealthManager {
    constructor(backendManager) {
        this.backendManager = backendManager;
        this.timeoutMs = parseInt(process.env.HEARTBEAT_TIMEOUT_MS || "3000", 10);
        this.pollIntervalMs = parseInt(process.env.HEALTH_CHECK_INTERVAL_MS || "1500", 10);
        this.timer = null;
    }

    start() {
        console.log(`[HealthManager] Active health monitoring started (Timeout: ${this.timeoutMs}ms, Poll: ${this.pollIntervalMs}ms)`);
        this.timer = setInterval(() => {
            this.checkAllBackends();
        }, this.pollIntervalMs);
        if (this.timer.unref) this.timer.unref();
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    checkAllBackends() {
        const now = Date.now();
        const timeoutMs = parseInt(process.env.HEARTBEAT_TIMEOUT_MS || this.timeoutMs, 10);
        const backends = this.backendManager.getBackendList();

        for (let backend of backends) {
            const age = now - backend.lastHeartbeat;

            if (backend.healthy && age > timeoutMs) {
                backend.healthy = false;
                console.warn(`[HealthManager] Backend ${backend.id} marked UNHEALTHY (Heartbeat missed for ${age}ms > ${timeoutMs}ms)`);
            }

            // Optional active polling check
            this.pollBackend(backend);
        }
    }

    pollBackend(backend) {
        try {
            const urlObj = new URL(backend.url + "/health");
            const isHttps = urlObj.protocol === "https:";
            const client = isHttps ? https : http;

            const req = client.request(urlObj, {
                method: "GET",
                timeout: 1000,
                rejectUnauthorized: false
            }, (res) => {
                if (res.statusCode === 200) {
                    if (!backend.healthy) {
                        backend.healthy = true;
                        backend.lastHeartbeat = Date.now();
                        backend.consecutiveFailures = 0;
                        console.log(`[HealthManager] Backend ${backend.id} recovered and marked HEALTHY`);
                    }
                } else {
                    this.recordFailure(backend, `HTTP status ${res.statusCode}`);
                }
                res.resume();
            });

            req.on("error", (err) => {
                this.recordFailure(backend, err.message);
            });

            req.on("timeout", () => {
                req.destroy();
                this.recordFailure(backend, "Timeout");
            });

            req.end();
        } catch (e) {
            this.recordFailure(backend, e.message);
        }
    }

    recordFailure(backend, errorMsg) {
        backend.consecutiveFailures = (backend.consecutiveFailures || 0) + 1;
        backend.failedRequests = (backend.failedRequests || 0) + 1;
        backend.activeRequests = Math.max(0, backend.activeRequests - 1);

        if (backend.healthy && backend.consecutiveFailures >= 2) {
            backend.healthy = false;
            console.warn(`[HealthManager] Passive failure detection: Backend ${backend.id} marked UNHEALTHY (${errorMsg})`);
        }
    }

    recordSuccess(backend, latencyMs) {
        backend.consecutiveFailures = 0;
        backend.completedRequests = (backend.completedRequests || 0) + 1;
        backend.activeRequests = Math.max(0, backend.activeRequests - 1);

        if (!backend.healthy) {
            backend.healthy = true;
            backend.lastHeartbeat = Date.now();
            console.log(`[HealthManager] Backend ${backend.id} active and restored to HEALTHY pool`);
        }
    }
}

module.exports = { HealthManager };
