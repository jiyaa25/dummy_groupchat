const os = require("os");

class BackendMetricsTracker {
    constructor() {
        this.activeRequests = 0;
        this.completedRequests = 0;
        this.failedRequests = 0;
        this.totalResponseTimeMs = 0;
        this.avgResponseTimeMs = 0;
        this.recentLatencies = [];
        this.maxHistory = 100;
        
        // CPU measurement state
        this.lastCpuUsage = process.cpuUsage();
        this.lastCpuTime = Date.now();
        this.currentCpuPercent = 0;

        // Periodic CPU updater (every 500ms)
        this.cpuInterval = setInterval(() => {
            this.updateCpuUsage();
        }, 500);
        if (this.cpuInterval.unref) this.cpuInterval.unref();
    }

    updateCpuUsage() {
        const currentUsage = process.cpuUsage(this.lastCpuUsage);
        const now = Date.now();
        const elapsedMs = now - this.lastCpuTime;

        if (elapsedMs > 0) {
            // total cpu microseconds used divided by elapsed microseconds, normalized across CPUs
            const totalMicroseconds = currentUsage.user + currentUsage.system;
            const cpus = os.cpus().length || 1;
            const cpuPercent = (totalMicroseconds / (elapsedMs * 1000 * cpus)) * 100;
            this.currentCpuPercent = Math.min(100, Math.max(0, parseFloat(cpuPercent.toFixed(2))));
        }

        this.lastCpuUsage = process.cpuUsage();
        this.lastCpuTime = now;
    }

    getMemoryUsage() {
        const mem = process.memoryUsage();
        const totalSysMem = os.totalmem();
        const memPercent = (mem.rss / totalSysMem) * 100;
        return {
            heapUsedMB: parseFloat((mem.heapUsed / 1024 / 1024).toFixed(2)),
            rssMB: parseFloat((mem.rss / 1024 / 1024).toFixed(2)),
            memPercent: parseFloat(memPercent.toFixed(2))
        };
    }

    getQueueLength() {
        // Application-level queue: active concurrent in-flight processing requests
        return this.activeRequests;
    }

    startRequest() {
        this.activeRequests++;
        return Date.now();
    }

    finishRequest(startTime, isSuccess = true) {
        this.activeRequests = Math.max(0, this.activeRequests - 1);
        const duration = Math.max(1, Date.now() - startTime);

        if (isSuccess) {
            this.completedRequests++;
            this.totalResponseTimeMs += duration;
            // Exponential moving average: 80% old, 20% new
            if (this.avgResponseTimeMs === 0) {
                this.avgResponseTimeMs = duration;
            } else {
                this.avgResponseTimeMs = 0.8 * this.avgResponseTimeMs + 0.2 * duration;
            }
        } else {
            this.failedRequests++;
        }

        this.recentLatencies.push(duration);
        if (this.recentLatencies.length > this.maxHistory) {
            this.recentLatencies.shift();
        }

        return duration;
    }

    getMetricsSnapshot(instanceName = "SYS2") {
        this.updateCpuUsage();
        const mem = this.getMemoryUsage();
        const queueLength = this.getQueueLength();

        return {
            backend: instanceName,
            timestamp: new Date().toISOString(),
            status: "healthy",
            queueLength: queueLength,
            cpu: this.currentCpuPercent,
            memory: mem.memPercent,
            heapMB: mem.heapUsedMB,
            rssMB: mem.rssMB,
            activeRequests: this.activeRequests,
            completedRequests: this.completedRequests,
            failedRequests: this.failedRequests,
            avgResponseTime: parseFloat(this.avgResponseTimeMs.toFixed(2)),
            recentLatencies: [...this.recentLatencies]
        };
    }
}

const backendMetrics = new BackendMetricsTracker();

// Express middleware to automatically track request timing & active requests
function metricsMiddleware(req, res, next) {
    // Avoid tracking health/metrics polling itself to keep routing telemetry clean
    if (req.path === '/health' || req.path === '/metrics' || req.path === '/heartbeat') {
        return next();
    }

    const start = backendMetrics.startRequest();
    res.on('finish', () => {
        const isSuccess = res.statusCode < 500;
        backendMetrics.finishRequest(start, isSuccess);
    });
    res.on('close', () => {
        if (!res.writableEnded) {
            backendMetrics.finishRequest(start, false);
        }
    });
    next();
}

module.exports = {
    backendMetrics,
    metricsMiddleware
};
