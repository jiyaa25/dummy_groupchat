const assert = require("assert");
const http = require("http");
const { app } = require("../server/index");

async function runApiTests() {
    console.log("=== Running Canonical REST API Tests ===");

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    async function makeRequest(path, options = {}) {
        return new Promise((resolve, reject) => {
            const urlObj = new URL(path, baseUrl);
            const req = http.request(urlObj, {
                method: options.method || "GET",
                headers: options.headers || {}
            }, (res) => {
                let data = "";
                res.on("data", chunk => data += chunk);
                res.on("end", () => {
                    try {
                        const json = JSON.parse(data);
                        resolve({ status: res.statusCode, body: json });
                    } catch (e) {
                        resolve({ status: res.statusCode, body: data });
                    }
                });
            });
            req.on("error", reject);
            if (options.body) {
                req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
            }
            req.end();
        });
    }

    try {
        // 1. Test GET /health
        const healthRes = await makeRequest("/health");
        assert.strictEqual(healthRes.status, 200);
        assert.strictEqual(healthRes.body.status, "ok");
        console.log("✓ GET /health returns 200 OK");

        // 2. Test GET /metrics
        const metricsRes = await makeRequest("/metrics");
        assert.strictEqual(metricsRes.status, 200);
        assert.ok(metricsRes.body.cpu !== undefined, "Metrics must include CPU utilization");
        assert.ok(metricsRes.body.queueLength !== undefined, "Metrics must include queue length");
        console.log("✓ GET /metrics returns real-time telemetry snapshot");

        // 3. Test POST /message with canonical field names ("client-name", "msg")
        const postRes = await makeRequest("/message", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: {
                "client-name": "Bob",
                "msg": "Test message from canonical API"
            }
        });
        assert.strictEqual(postRes.status, 200);
        assert.strictEqual(postRes.body.status, "success");
        assert.ok(postRes.body.message_id, "Response must include unique message_id");
        assert.strictEqual(postRes.body["client-name"], "Bob");
        assert.strictEqual(postRes.body.msg, "Test message from canonical API");
        console.log("✓ POST /message succeeds with canonical fields ('client-name', 'msg')");

        // 4. Test POST /message with missing required field
        const invalidPost = await makeRequest("/message", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: { "client-name": "Bob" } // missing msg
        });
        assert.strictEqual(invalidPost.status, 400);
        console.log("✓ POST /message validates input and rejects missing 'msg' with 400");

        // 5. Test GET /feed
        const feedRes = await makeRequest("/feed");
        assert.strictEqual(feedRes.status, 200);
        assert.strictEqual(feedRes.body.status, "success");
        assert.ok(Array.isArray(feedRes.body.messages), "Feed must return an array of messages");
        assert.ok(feedRes.body.messages.length > 0, "Feed must contain inserted message");
        const found = feedRes.body.messages.find(m => m.msg === "Test message from canonical API");
        assert.ok(found, "Decrypted message must appear in GET /feed");
        console.log("✓ GET /feed retrieves all stored and decrypted messages");

        console.log("✓ ALL CANONICAL REST API TESTS PASSED!\n");
    } finally {
        server.close();
    }
}

if (require.main === module) {
    runApiTests().catch(err => {
        console.error("API test failed:", err);
        process.exit(1);
    });
}

module.exports = { runApiTests };
