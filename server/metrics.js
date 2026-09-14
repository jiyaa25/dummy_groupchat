require("./env");
const os = require('os');

const MAX_SAMPLES = 120;
let activeRequests = 0;
let completedRequests = 0;
let failedRequests = 0;
const responseTimes = [];

function startRequest() {
    activeRequests++;
    return process.hrtime.bigint();
}

function finishRequest(startTime, success) {
    activeRequests = Math.max(0, activeRequests - 1);
    completedRequests++;
    if (!success) failedRequests++;
    if (startTime) {
        const elapsedMs = Number(process.hrtime.bigint() - startTime) / 1e6;
        responseTimes.push(elapsedMs);
        if (responseTimes.length > MAX_SAMPLES) responseTimes.shift();
    }
}

function average(values) {
    if (!values.length) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
}

let previousCpu = null;
let previousCpuWall = null;

function getCpuPercent() {
    const cpus = os.cpus();
    let idle = 0;
    let total = 0;
    for (const cpu of cpus) {
        idle += cpu.times.idle;
        total += Object.values(cpu.times).reduce((a, b) => a + b, 0);
    }
    const now = { idle, total };
    const nowWall = Date.now();
    if (!previousCpu) { previousCpu = now; previousCpuWall = nowWall; return 0; }
    const idleDelta = now.idle - previousCpu.idle;
    const totalDelta = now.total - previousCpu.total;
    previousCpu = now; previousCpuWall = nowWall;
    return totalDelta > 0 ? Math.min(100, Math.max(0, (1 - idleDelta / totalDelta) * 100)) : 0;
}

function getMetricsSnapshot(instanceName) {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const memory = totalMem > 0 ? ((totalMem - freeMem) / totalMem) * 100 : 0;
    const avgResponseTime = average(responseTimes);

    return {
        backend: instanceName,
        status: 'healthy',
        queueLength: activeRequests,
        cpu: Number(getCpuPercent().toFixed(2)),
        memory: Number(memory.toFixed(2)),
        activeRequests,
        avgResponseTime: Number(avgResponseTime.toFixed(2)),
        completedRequests,
        failedRequests,
        timestamp: Date.now()
    };
}

module.exports = { backendMetrics: { startRequest, finishRequest, getMetricsSnapshot } };
