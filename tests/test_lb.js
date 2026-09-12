const assert = require("assert");
const { BackendManager } = require("../lb/backendManager");
const { calculateScore, normalizeMetrics } = require("../lb/scoring");

async function runLoadBalancerTests() {
    console.log("=== Running Dynamic Load Balancer & Routing Tests ===");

    // 1. Scoring Logic Test
    const b1 = { queueLength: 1, cpu: 20, memory: 30, activeRequests: 1, avgResponseTime: 50 };
    const b2 = { queueLength: 8, cpu: 80, memory: 70, activeRequests: 8, avgResponseTime: 300 };

    const score1 = calculateScore(b1);
    const score2 = calculateScore(b2);

    assert.ok(score1.score < score2.score, "Lower loaded backend must have lower score");
    console.log(`✓ Scoring verified: Light Load Score=${score1.score}, Heavy Load Score=${score2.score}`);

    // 2. Dynamic Routing Selection Test
    const bm = new BackendManager([
        { id: "SYS2", url: "http://172.17.0.63:3262" },
        { id: "SYS3", url: "http://172.17.0.64:3263" },
        { id: "SYS4", url: "http://172.17.0.65:3264" }
    ]);

    // Update metrics
    bm.updateMetrics("SYS2", { queueLength: 1, cpu: 20, memory: 30, activeRequests: 1, avgResponseTime: 40 });
    bm.updateMetrics("SYS3", { queueLength: 6, cpu: 75, memory: 60, activeRequests: 6, avgResponseTime: 200 });
    bm.updateMetrics("SYS4", { queueLength: 2, cpu: 35, memory: 40, activeRequests: 2, avgResponseTime: 60 });

    const selected1 = bm.getNextBackend("POST", "/message");
    assert.strictEqual(selected1.id, "SYS2", "SYS2 has lowest score and must be selected");
    console.log("✓ Dynamic Routing correctly selects least loaded backend (SYS2)");

    // 3. Overload Threshold Switching Test (Threshold >= 70)
    bm.updateMetrics("SYS2", { queueLength: 8, cpu: 85, memory: 75, activeRequests: 8, avgResponseTime: 350 }); // Score > 70 -> Overloaded
    const selectedAfterOverload = bm.getNextBackend("POST", "/message");
    assert.strictEqual(selectedAfterOverload.id, "SYS4", "Traffic must switch away from overloaded SYS2 to SYS4");
    console.log("✓ Overload threshold switches traffic to next suitable healthy backend (SYS4)");

    // 4. Hysteresis Test (Recovery <= 55)
    const sys2Obj = bm.getBackendById("SYS2");
    assert.strictEqual(sys2Obj.isOverloaded, true, "SYS2 should currently be in overloaded state");

    // Reduce SYS2 load slightly (yields score ~64.5, which is below overload threshold 70 but above recovery threshold 55)
    bm.updateMetrics("SYS2", { queueLength: 7, cpu: 70, memory: 60, activeRequests: 7, avgResponseTime: 200 });
    assert.strictEqual(sys2Obj.isOverloaded, true, "Hysteresis: SYS2 should remain overloaded until score <= 55");

    // Reduce SYS2 load further (yields score ~13.7 <= 55)
    bm.updateMetrics("SYS2", { queueLength: 1, cpu: 20, memory: 30, activeRequests: 1, avgResponseTime: 30 });
    assert.strictEqual(sys2Obj.isOverloaded, false, "SYS2 successfully recovers when score drops <= 55");
    console.log("✓ Hysteresis prevents thrashing and cleanly recovers backend below threshold");

    // 5. All-Backends-Overloaded Fallback Test
    bm.updateMetrics("SYS2", { queueLength: 9, cpu: 90, memory: 85, activeRequests: 9, avgResponseTime: 400 }); // Score ~85
    bm.updateMetrics("SYS3", { queueLength: 7, cpu: 75, memory: 70, activeRequests: 7, avgResponseTime: 320 }); // Score ~72
    bm.updateMetrics("SYS4", { queueLength: 8, cpu: 80, memory: 80, activeRequests: 8, avgResponseTime: 360 }); // Score ~80

    const fallbackSelected = bm.getNextBackend("GET", "/feed");
    assert.strictEqual(fallbackSelected.id, "SYS3", "When all backends are overloaded, least overloaded healthy backend (SYS3) must be selected");
    console.log("✓ All-Backends-Overloaded fallback selects least loaded healthy backend (SYS3)");

    // 6. Unhealthy / Dead Backend Detection Test
    const sys3Obj = bm.getBackendById("SYS3");
    sys3Obj.healthy = false; // Mark dead
    const sys4Obj = bm.getBackendById("SYS4");
    sys4Obj.healthy = false;
    const sys2ObjRef = bm.getBackendById("SYS2");
    sys2ObjRef.healthy = false;

    const noHealthy = bm.getNextBackend("GET", "/feed");
    assert.strictEqual(noHealthy, null, "When no healthy backends exist, router returns null to trigger 503");
    console.log("✓ Unhealthy backend detection and 503 trigger verified");

    console.log("✓ ALL LOAD BALANCER & ROUTING TESTS PASSED!\n");
}

if (require.main === module) {
    runLoadBalancerTests().catch(err => {
        console.error("LB test failed:", err);
        process.exit(1);
    });
}

module.exports = { runLoadBalancerTests };
