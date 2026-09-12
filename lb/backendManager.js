const { calculateScore, OVERLOAD_THRESHOLD, RECOVERY_THRESHOLD } = require("./scoring");

class BackendManager {
    constructor(backendConfigs = []) {
        this.backends = new Map();
        this.initBackends(backendConfigs);
    }

    initBackends(configs) {
        let defaultConfigs = configs;
        if (!defaultConfigs || defaultConfigs.length === 0) {
            const raw = process.env.BACKENDS || "";
            if (raw.trim()) {
                defaultConfigs = raw.split(",").map((u, i) => ({
                    id: `SYS${i + 2}`,
                    url: u.trim()
                }));
            } else {
                defaultConfigs = [
                    { id: "SYS2", url: process.env.BACKEND_1_URL || "http://172.17.0.63:3262" },
                    { id: "SYS3", url: process.env.BACKEND_2_URL || "http://172.17.0.64:3263" },
                    { id: "SYS4", url: process.env.BACKEND_3_URL || "http://172.17.0.65:3264" }
                ];
            }
        }

        for (let cfg of defaultConfigs) {
            this.backends.set(cfg.id, {
                id: cfg.id,
                url: cfg.url.replace(/\/$/, ""),
                healthy: true,
                lastHeartbeat: Date.now(),
                queueLength: 0,
                cpu: 0,
                memory: 0,
                activeRequests: 0,
                avgResponseTime: 0,
                completedRequests: 0,
                failedRequests: 0,
                consecutiveFailures: 0,
                routingCount: 0,
                score: 0,
                scoreBreakdown: {},
                isOverloaded: false
            });
        }
    }

    getBackendList() {
        return Array.from(this.backends.values());
    }

    getBackendById(id) {
        return this.backends.get(id);
    }

    getBackendByUrl(url) {
        const cleanUrl = url.replace(/\/$/, "");
        for (let b of this.backends.values()) {
            if (b.url === cleanUrl) return b;
        }
        return null;
    }

    updateMetrics(idOrUrl, metrics) {
        let backend = this.backends.get(idOrUrl) || this.getBackendByUrl(idOrUrl);
        if (!backend) {
            // Find by matching backend name inside metrics payload
            if (metrics.backend && this.backends.has(metrics.backend)) {
                backend = this.backends.get(metrics.backend);
            }
        }
        if (!backend) return;

        backend.lastHeartbeat = Date.now();
        backend.healthy = true;
        backend.consecutiveFailures = 0;
        backend.queueLength = metrics.queueLength !== undefined ? metrics.queueLength : backend.queueLength;
        backend.cpu = metrics.cpu !== undefined ? metrics.cpu : backend.cpu;
        backend.memory = metrics.memory !== undefined ? metrics.memory : backend.memory;
        backend.activeRequests = metrics.activeRequests !== undefined ? metrics.activeRequests : backend.activeRequests;
        backend.avgResponseTime = metrics.avgResponseTime !== undefined ? metrics.avgResponseTime : backend.avgResponseTime;
        if (metrics.completedRequests !== undefined) backend.completedRequests = metrics.completedRequests;
        if (metrics.failedRequests !== undefined) backend.failedRequests = metrics.failedRequests;

        // Recalculate dynamic score
        const { score, breakdown } = calculateScore(backend);
        backend.score = score;
        backend.scoreBreakdown = breakdown;

        // Overload threshold state machine with hysteresis
        const currentOverloadThreshold = parseFloat(process.env.OVERLOAD_THRESHOLD || OVERLOAD_THRESHOLD);
        const currentRecoveryThreshold = parseFloat(process.env.RECOVERY_THRESHOLD || RECOVERY_THRESHOLD);

        if (backend.isOverloaded) {
            if (backend.score <= currentRecoveryThreshold) {
                backend.isOverloaded = false;
                console.log(`[LB] ${backend.id} recovered from overload (Score: ${backend.score} <= ${currentRecoveryThreshold})`);
            }
        } else {
            if (backend.score >= currentOverloadThreshold) {
                backend.isOverloaded = true;
                console.log(`[LB] ${backend.id} marked OVERLOADED (Score: ${backend.score} >= ${currentOverloadThreshold})`);
            }
        }
    }

    getNextBackend(reqMethod = "GET", reqPath = "/") {
        const now = Date.now();
        const timeoutMs = parseInt(process.env.HEARTBEAT_TIMEOUT_MS || "3000", 10);
        const list = this.getBackendList();

        // 1. Filter healthy backends (with active heartbeats)
        const healthyBackends = list.filter(b => {
            const isFresh = (now - b.lastHeartbeat) <= timeoutMs;
            return b.healthy && isFresh;
        });

        if (healthyBackends.length === 0) {
            return null; // Triggers 503
        }

        // Recalculate scores for all healthy backends
        for (let b of healthyBackends) {
            const { score, breakdown } = calculateScore(b);
            b.score = score;
            b.scoreBreakdown = breakdown;
        }

        // 2. Separate into non-overloaded and overloaded candidates
        const nonOverloaded = healthyBackends.filter(b => !b.isOverloaded);

        let selected = null;
        let reason = "";

        if (nonOverloaded.length > 0) {
            // Sort by score ascending (lowest score is best)
            nonOverloaded.sort((a, b) => a.score - b.score);
            selected = nonOverloaded[0];
            reason = "lowest healthy score";
        } else {
            // 3. Fallback: All healthy backends are overloaded -> pick least overloaded
            healthyBackends.sort((a, b) => a.score - b.score);
            selected = healthyBackends[0];
            reason = "all backends overloaded; selected least overloaded fallback";
        }

        if (selected) {
            selected.routingCount++;
            selected.activeRequests++;

            // Detailed routing log as specified in Assignment Requirement 18
            console.log(`[LB] ${reqMethod} ${reqPath} -> Selected: ${selected.id} (Queue: ${selected.queueLength}, CPU: ${selected.cpu}%, Mem: ${selected.memory}%, Active: ${selected.activeRequests}, AvgRT: ${selected.avgResponseTime}ms, Score: ${selected.score}, Reason: ${reason})`);
        }

        return selected;
    }
}

module.exports = { BackendManager };
