const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const script = process.argv[2];
const logFile = process.argv[3] || "/home/student/app.log";

if (!script) {
    console.error("Usage: node daemon.js <script-path> [log-file]");
    process.exit(1);
}

const absScript = path.resolve(script);
const logFd = fs.openSync(logFile, "a");

function startProcess() {
    const child = spawn(process.execPath, [absScript], {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["ignore", logFd, logFd]
    });

    console.log(`[Supervisor] Started child PID ${child.pid} for ${absScript}`);

    child.on("exit", (code, signal) => {
        const msg = `[Supervisor] Process ${absScript} (PID ${child.pid}) exited with code ${code} signal ${signal}. Restarting in 1s...\n`;
        try { fs.writeSync(logFd, msg); } catch (e) {}
        setTimeout(startProcess, 1000);
    });

    return child;
}

startProcess();
