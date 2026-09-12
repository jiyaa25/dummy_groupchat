const { spawn } = require("child_process");
const http = require("http");
const path = require("path");

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function startProcess(scriptPath, env = {}) {
    const proc = spawn(process.execPath, [scriptPath], {
        env: { ...process.env, ...env },
        stdio: "pipe"
    });
    proc.stdout.on("data", d => process.stdout.write(`[${env.INSTANCE_NAME || 'PROC'}] ${d}`));
    proc.stderr.on("data", d => process.stderr.write(`[${env.INSTANCE_NAME || 'PROC'} ERR] ${d}`));
    return proc;
}

function httpReq(urlStr, options = {}, body = null) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(urlStr);
        const req = http.request(urlObj, options, (res) => {
            let data = "";
            res.on("data", c => data += c);
            res.on("end", () => {
                try {
                    resolve({ status: res.statusCode, body: JSON.parse(data) });
                } catch (e) {
                    resolve({ status: res.statusCode, body: data });
                }
            });
        });
        req.on("error", reject);
        if (body) {
            req.write(typeof body === 'string' ? body : JSON.stringify(body));
        }
        req.end();
    });
}

async function runLiveE2E() {
    console.log("==========================================================");
    console.log("   DISTRIBUTED LIVE 4-SYSTEM END-TO-END VERIFICATION");
    console.log("==========================================================");

    const procs = [];
    try {
        console.log("1. Starting Sys2 (:3262), Sys3 (:3263), Sys4 (:3264)...");
        procs.push(startProcess(path.join(__dirname, "../server/index.js"), { INSTANCE_NAME: "SYS2", PORT: "3262" }));
        procs.push(startProcess(path.join(__dirname, "../server/index.js"), { INSTANCE_NAME: "SYS3", PORT: "3263" }));
        procs.push(startProcess(path.join(__dirname, "../server/index.js"), { INSTANCE_NAME: "SYS4", PORT: "3264" }));

        await sleep(1500);

        console.log("2. Starting Sys1 Load Balancer (:3261)...");
        procs.push(startProcess(path.join(__dirname, "../lb/server.js"), {
            LB_PORT: "3261",
            BACKEND_1_URL: "http://172.17.0.63:3262",
            BACKEND_2_URL: "http://172.17.0.64:3263",
            BACKEND_3_URL: "http://172.17.0.65:3264"
        }));

        await sleep(2000);

        console.log("3. Testing POST /message through Sys1 Load Balancer (:3261)...");
        const msg1 = await httpReq("http://10.1.75.79:3261/message", {
            method: "POST",
            headers: { "Content-Type": "application/json" }
        }, {
            "client-name": "Alice",
            "msg": "Hello from Alice through Sys1 LB!"
        });
        console.log("POST /message result:", msg1);
        if (msg1.status !== 200 || msg1.body.status !== "success") {
            throw new Error(`POST /message failed with status ${msg1.status}`);
        }

        console.log("4. Testing GET /feed through Sys1 Load Balancer (:3261)...");
        const feedRes = await httpReq("http://10.1.75.79:3261/feed");
        console.log("GET /feed result: Count =", feedRes.body.count);
        if (feedRes.status !== 200 || !Array.isArray(feedRes.body.messages)) {
            throw new Error(`GET /feed failed with status ${feedRes.status}`);
        }

        console.log("5. Testing GET /lb/status and GET /lb/metrics...");
        const statusRes = await httpReq("http://10.1.75.79:3261/lb/status");
        console.log("LB Status backends count:", statusRes.body.backends.length);

        const metricsRes = await httpReq("http://10.1.75.79:3261/lb/metrics");
        console.log("Sys1 LB Metrics total requests:", metricsRes.body.sys1_lb.totalRequests);

        console.log("\n✓ LIVE 4-SYSTEM END-TO-END VERIFICATION SUCCEEDED!");
    } finally {
        console.log("Cleaning up server processes...");
        for (let p of procs) {
            try { p.kill(); } catch (e) {}
        }
    }
}

if (require.main === module) {
    runLiveE2E().catch(err => {
        console.error("Live E2E error:", err);
        process.exit(1);
    });
}
