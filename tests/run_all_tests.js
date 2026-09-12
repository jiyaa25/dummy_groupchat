const { runApiTests } = require("./test_api");
const { runIdempotencyTests } = require("./test_idempotency");
const { runLoadBalancerTests } = require("./test_lb");

async function main() {
    console.log("==========================================================");
    console.log("   DISTRIBUTED SYSTEMS PHASE 2 - FULL TEST VERIFICATION");
    console.log("==========================================================\n");

    try {
        // Run Cryptography Tests
        require("./test_crypto");

        // Run Idempotency Tests
        await runIdempotencyTests();

        // Run REST API Tests
        await runApiTests();

        // Run Dynamic Load Balancer Tests
        await runLoadBalancerTests();

        console.log("==========================================================");
        console.log("   ✓ ALL TEST SUITES COMPLETED SUCCESSFULLY!");
        console.log("==========================================================");
        process.exit(0);
    } catch (err) {
        console.error("❌ TEST FAILURE:", err);
        process.exit(1);
    }
}

main();
