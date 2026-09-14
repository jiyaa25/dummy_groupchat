#!/usr/bin/env node
/**
 * Load Generator — Distributed Group Chat (Phase 2)
 * ===================================================
 * Simulates multiple concurrent users sending POST /message and GET /feed.
 *
 * Usage:
 *   node load_generator.js [options]
 *
 * Options:
 *   --url       LB base URL              (default: http://172.17.0.62:3000)
 *   --users     Number of concurrent     (default: 10)
 *   --duration  Test duration in seconds (default: 60)
 *   --minDelay  Min ms between messages  (default: 100)
 *   --maxDelay  Max ms between messages  (default: 2000)
 *   --minLen    Min message text length  (default: 10)
 *   --maxLen    Max message text length  (default: 200)
 *   --feedRatio Fraction of reqs = GET /feed (default: 0.2)
 *   --output    Write JSON report to file (optional)
 *
 * Example:
 *   node load_generator.js --url http://172.17.0.62:3000 --users 20 --duration 30
 */

'use strict';

const http  = require('http');
const https = require('https');
const { randomBytes } = require('crypto');

// ─── CLI Argument Parser ──────────────────────────────────────────────────────
function parseArgs() {
    const args = process.argv.slice(2);
    const opts = {
        url:       'http://172.17.0.62:3000',
        users:     10,
        duration:  60,
        minDelay:  100,
        maxDelay:  2000,
        minLen:    10,
        maxLen:    200,
        feedRatio: 0.2,
        output:    null,
        metricsInterval: 1000,
    };
    for (let i = 0; i < args.length; i += 2) {
        const key = args[i].replace('--', '');
        const val = args[i + 1];
        if (key in opts) {
            opts[key] = isNaN(Number(val)) ? val : Number(val);
        }
    }
    return opts;
}

// ─── Random Helpers ───────────────────────────────────────────────────────────
function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randMessage(minLen, maxLen) {
    const len    = randInt(minLen, maxLen);
    const chars  = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 !?.,';
    let msg = '';
    for (let i = 0; i < len; i++) {
        msg += chars[Math.floor(Math.random() * chars.length)];
    }
    return msg;
}

function randUsername(id) {
    return `User${id}_${randomBytes(3).toString('hex')}`;
}

function generateUUID() {
    return randomBytes(16).toString('hex').replace(
        /^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5'
    );
}

// ─── HTTP Request ─────────────────────────────────────────────────────────────
function makeRequest(opts) {
    return new Promise((resolve) => {
        const startTime = Date.now();
        const parsed    = new URL(opts.url);
        const lib       = parsed.protocol === 'https:' ? https : http;

        const reqOpts = {
            hostname: parsed.hostname,
            port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path:     parsed.pathname + (parsed.search || ''),
            method:   opts.method || 'GET',
            headers:  opts.headers || {},
            rejectUnauthorized: false,
            timeout: 10000,
        };

        const req = lib.request(reqOpts, (res) => {
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => {
                resolve({
                    ok:         res.statusCode >= 200 && res.statusCode < 300,
                    status:     res.statusCode,
                    latencyMs:  Date.now() - startTime,
                    body,
                });
            });
        });

        req.on('error', (err) => {
            resolve({
                ok:        false,
                status:    0,
                latencyMs: Date.now() - startTime,
                error:     err.message,
            });
        });

        req.on('timeout', () => {
            req.destroy();
            resolve({
                ok:        false,
                status:    0,
                latencyMs: Date.now() - startTime,
                error:     'timeout',
            });
        });

        if (opts.body) {
            req.write(opts.body);
        }
        req.end();
    });
}

async function postMessage(baseUrl, username, message, msgId) {
    const body = JSON.stringify({
        'client-name': username,
        'msg':         message,
        'message_id':  msgId || generateUUID(),
    });
    return makeRequest({
        url:     `${baseUrl}/message`,
        method:  'POST',
        headers: {
            'Content-Type':   'application/json',
            'Content-Length': Buffer.byteLength(body),
        },
        body,
    });
}

async function getFeed(baseUrl) {
    return makeRequest({
        url:    `${baseUrl}/feed`,
        method: 'GET',
    });
}

// ─── Stats Accumulator ────────────────────────────────────────────────────────
class Stats {
    constructor() {
        this.latencies    = [];
        this.totalReqs    = 0;
        this.successReqs  = 0;
        this.errorReqs    = 0;
        this.postCount    = 0;
        this.feedCount    = 0;
        this.startTime    = Date.now();
        this.samples      = [];
    }

    record(result, type) {
        this.totalReqs++;
        this.latencies.push(result.latencyMs);
        if (type === 'post') this.postCount++;
        else                  this.feedCount++;

        if (result.ok) {
            this.successReqs++;
        } else {
            this.errorReqs++;
        }
    }

    percentile(p) {
        if (this.latencies.length === 0) return 0;
        const sorted = [...this.latencies].sort((a, b) => a - b);
        const idx    = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
        return sorted[idx];
    }

    avg() {
        if (this.latencies.length === 0) return 0;
        return Math.round(this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length);
    }

    throughput() {
        const elapsed = (Date.now() - this.startTime) / 1000;
        return elapsed > 0 ? (this.totalReqs / elapsed).toFixed(2) : '0.00';
    }

    errorRate() {
        return this.totalReqs > 0
            ? ((this.errorReqs / this.totalReqs) * 100).toFixed(2)
            : '0.00';
    }

    report() {
        return {
            totalRequests:    this.totalReqs,
            successRequests:  this.successReqs,
            errorRequests:    this.errorReqs,
            postMessages:     this.postCount,
            feedRequests:     this.feedCount,
            avgLatencyMs:     this.avg(),
            p50LatencyMs:     this.percentile(0.50),
            p95LatencyMs:     this.percentile(0.95),
            p99LatencyMs:     this.percentile(0.99),
            minLatencyMs:     this.latencies.length > 0 ? Math.min(...this.latencies) : 0,
            maxLatencyMs:     this.latencies.length > 0 ? Math.max(...this.latencies) : 0,
            throughputRPS:    parseFloat(this.throughput()),
            errorRatePct:     parseFloat(this.errorRate()),
            durationMs:       Date.now() - this.startTime,
        };
    }
}

// ─── User Simulation ──────────────────────────────────────────────────────────
async function simulateUser(id, opts, stats, stopSignal) {
    const username = randUsername(id);

    while (!stopSignal.stopped) {
        const delay = randInt(opts.minDelay, opts.maxDelay);
        await sleep(delay);
        if (stopSignal.stopped) break;

        try {
            if (Math.random() > opts.feedRatio) {
                // Send a message
                const msg    = randMessage(opts.minLen, opts.maxLen);
                const msgId  = generateUUID();
                const result = await postMessage(opts.url, username, msg, msgId);
                stats.record(result, 'post');

                if (!result.ok && opts.verbose) {
                    console.error(`[User${id}] POST failed: ${result.status} ${result.error || ''}`);
                }
            } else {
                // Get feed
                const result = await getFeed(opts.url);
                stats.record(result, 'feed');
            }
        } catch (err) {
            stats.record({ ok: false, latencyMs: 0, error: err.message }, 'error');
        }
    }
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// ─── Progress Printer ─────────────────────────────────────────────────────────
function startProgressPrinter(stats, duration) {
    let elapsed = 0;
    const interval = setInterval(() => {
        elapsed++;
        const remaining = duration - elapsed;
        const r = stats.report();
        process.stdout.write(
            `\r[${elapsed}s/${duration}s] Reqs: ${r.totalRequests} | ` +
            `OK: ${r.successRequests} | Err: ${r.errorRequests} | ` +
            `AvgRT: ${r.avgLatencyMs}ms | RPS: ${r.throughputRPS} | ` +
            `Remaining: ${remaining}s   `
        );
    }, 1000);
    return interval;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    const opts = parseArgs();

    console.log('\n╔══════════════════════════════════════════════════════╗');
    console.log('║          Group Chat — Load Generator                ║');
    console.log('╚══════════════════════════════════════════════════════╝');
    console.log(`Target URL:     ${opts.url}`);
    console.log(`Users:          ${opts.users}`);
    console.log(`Duration:       ${opts.duration}s`);
    console.log(`Delay range:    ${opts.minDelay}–${opts.maxDelay}ms`);
    console.log(`Message length: ${opts.minLen}–${opts.maxLen} chars`);
    console.log(`Feed ratio:     ${(opts.feedRatio * 100).toFixed(0)}% of requests`);
    console.log('');

    // Verify LB is reachable
    console.log(`Checking LB health at ${opts.url}/lb/health ...`);
    try {
        const health = await makeRequest({ url: `${opts.url}/lb/health`, method: 'GET' });
        if (health.ok) {
            console.log(`LB is healthy: ${health.body.trim()}\n`);
        } else {
            console.warn(`LB health check returned ${health.status}. Continuing anyway...\n`);
        }
    } catch (e) {
        console.warn(`LB health check failed: ${e.message}. Continuing anyway...\n`);
    }

    const stats      = new Stats();
    const stopSignal = { stopped: false };

    console.log(`Starting ${opts.users} concurrent users...\n`);
    const progressInterval = startProgressPrinter(stats, opts.duration);

    // Sample LB/backend performance during the run for report plots.
    const thisMetrics = { samples: [] };
    const metricsTimer = setInterval(async () => {
        try {
            const result = await makeRequest({ url: `${opts.url}/lb/metrics`, method: 'GET' });
            if (result.ok) thisMetrics.samples.push({ elapsedMs: Date.now() - stats.startTime, metrics: JSON.parse(result.body) });
        } catch (_) {}
    }, Number(opts.metricsInterval) || 1000);

    // Launch all user coroutines
    const userPromises = [];
    for (let i = 1; i <= opts.users; i++) {
        userPromises.push(simulateUser(i, opts, stats, stopSignal));
    }

    // Run for the configured duration
    await sleep(opts.duration * 1000);
    stopSignal.stopped = true;

    clearInterval(progressInterval);
    clearInterval(metricsTimer);
    process.stdout.write('\n\n');

    // Wait for all users to finish current request
    await Promise.allSettled(userPromises.map(p => Promise.race([p, sleep(3000)])));

    const report = stats.report();

    // Print final report
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║                   FINAL REPORT                      ║');
    console.log('╚══════════════════════════════════════════════════════╝');
    console.log(`Total Requests:    ${report.totalRequests}`);
    console.log(`  POST /message:   ${report.postMessages}`);
    console.log(`  GET  /feed:      ${report.feedRequests}`);
    console.log(`Success:           ${report.successRequests}`);
    console.log(`Errors:            ${report.errorRequests}`);
    console.log(`Error Rate:        ${report.errorRatePct}%`);
    console.log(`Throughput:        ${report.throughputRPS} req/s`);
    console.log('');
    console.log(`Response Times:`);
    console.log(`  Min:             ${report.minLatencyMs}ms`);
    console.log(`  Avg:             ${report.avgLatencyMs}ms`);
    console.log(`  P50:             ${report.p50LatencyMs}ms`);
    console.log(`  P95:             ${report.p95LatencyMs}ms`);
    console.log(`  P99:             ${report.p99LatencyMs}ms`);
    console.log(`  Max:             ${report.maxLatencyMs}ms`);
    console.log(`Duration:          ${(report.durationMs / 1000).toFixed(1)}s`);
    console.log('');

    // Fetch LB metrics at end
    try {
        const lbMetrics = await makeRequest({ url: `${opts.url}/lb/metrics`, method: 'GET' });
        if (lbMetrics.ok) {
            const parsed = JSON.parse(lbMetrics.body);
            console.log('LB Backend Status:');
            if (parsed.backends) {
                for (const b of parsed.backends) {
                    console.log(`  ${b.name}: healthy=${b.healthy} score=${b.score} ` +
                        `queue=${b.queueLength} cpu=${b.cpu}% mem=${b.memory}% ` +
                        `active=${b.activeRequests} rt=${b.avgResponseTime}ms`);
                }
            }
            console.log(`LB Latency: avg=${parsed.latency?.avgMs}ms ` +
                `p95=${parsed.latency?.p95Ms}ms p99=${parsed.latency?.p99Ms}ms`);
        }
    } catch (e) {
        console.warn('Could not fetch LB metrics:', e.message);
    }

    // Write JSON report if --output specified
    if (opts.output) {
        const fs     = require('fs');
        const outData = {
            config:  opts,
            results: report,
            metricsSamples: thisMetrics.samples,
            time:    new Date().toISOString(),
        };
        fs.writeFileSync(opts.output, JSON.stringify(outData, null, 2));
        console.log(`\nReport written to: ${opts.output}`);
    }

    console.log('\nDone.\n');
    process.exit(0);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
