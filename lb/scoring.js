require("dotenv").config();

// Configurable weights (sum to 1.0 by default)
const QUEUE_WEIGHT = parseFloat(process.env.QUEUE_WEIGHT || "0.40");
const CPU_WEIGHT = parseFloat(process.env.CPU_WEIGHT || "0.20");
const MEMORY_WEIGHT = parseFloat(process.env.MEMORY_WEIGHT || "0.10");
const ACTIVE_REQUEST_WEIGHT = parseFloat(process.env.ACTIVE_REQUEST_WEIGHT || "0.15");
const RESPONSE_TIME_WEIGHT = parseFloat(process.env.RESPONSE_TIME_WEIGHT || "0.15");

// Configurable thresholds for dynamic overload switching and hysteresis
const OVERLOAD_THRESHOLD = parseFloat(process.env.OVERLOAD_THRESHOLD || "70.0");
const RECOVERY_THRESHOLD = parseFloat(process.env.RECOVERY_THRESHOLD || "55.0");

/**
 * Normalizes metrics to a 0-100 scale:
 * - Queue: 0-10+ queued jobs mapped to 0-100
 * - CPU: 0-100%
 * - Memory: 0-100%
 * - Active Requests: 0-10+ requests mapped to 0-100
 * - Avg Response Time: 0-500ms mapped to 0-100 (capped at 100)
 */
function normalizeMetrics(metrics) {
    const queueLength = Math.max(0, metrics.queueLength || 0);
    const cpu = Math.max(0, Math.min(100, metrics.cpu || 0));
    const memory = Math.max(0, Math.min(100, metrics.memory || 0));
    const activeRequests = Math.max(0, metrics.activeRequests || 0);
    const avgResponseTime = Math.max(0, metrics.avgResponseTime || 0);

    const normQueue = Math.min(100, queueLength * 10);
    const normCpu = cpu;
    const normMem = memory;
    const normActive = Math.min(100, activeRequests * 10);
    const normRt = Math.min(100, (avgResponseTime / 500) * 100);

    return {
        normQueue,
        normCpu,
        normMem,
        normActive,
        normRt
    };
}

/**
 * Computes composite performance score.
 * Lower score = better, less loaded backend.
 * @param {object} backend Backend metrics object
 * @returns {{ score: number, breakdown: object }}
 */
function calculateScore(backend) {
    const norm = normalizeMetrics(backend);

    const score = 
        (QUEUE_WEIGHT * norm.normQueue) +
        (CPU_WEIGHT * norm.normCpu) +
        (MEMORY_WEIGHT * norm.normMem) +
        (ACTIVE_REQUEST_WEIGHT * norm.normActive) +
        (RESPONSE_TIME_WEIGHT * norm.normRt);

    const finalScore = parseFloat(Math.max(0, Math.min(100, score)).toFixed(2));

    return {
        score: finalScore,
        breakdown: {
            queueContribution: parseFloat((QUEUE_WEIGHT * norm.normQueue).toFixed(2)),
            cpuContribution: parseFloat((CPU_WEIGHT * norm.normCpu).toFixed(2)),
            memoryContribution: parseFloat((MEMORY_WEIGHT * norm.normMem).toFixed(2)),
            activeContribution: parseFloat((ACTIVE_REQUEST_WEIGHT * norm.normActive).toFixed(2)),
            rtContribution: parseFloat((RESPONSE_TIME_WEIGHT * norm.normRt).toFixed(2))
        }
    };
}

module.exports = {
    calculateScore,
    normalizeMetrics,
    QUEUE_WEIGHT,
    CPU_WEIGHT,
    MEMORY_WEIGHT,
    ACTIVE_REQUEST_WEIGHT,
    RESPONSE_TIME_WEIGHT,
    OVERLOAD_THRESHOLD,
    RECOVERY_THRESHOLD
};
