#!/usr/bin/env python3
"""Generate Lab-6 plots from load_generator.js JSON output."""
import json, sys
from pathlib import Path
import matplotlib.pyplot as plt

if len(sys.argv) < 2:
    raise SystemExit('Usage: python3 report_plots.py results.json [output_dir]')

source = Path(sys.argv[1])
out = Path(sys.argv[2]) if len(sys.argv) > 2 else Path('plots')
out.mkdir(parents=True, exist_ok=True)
data = json.loads(source.read_text())
samples = data.get('metricsSamples', [])
if not samples:
    raise SystemExit('No metricsSamples found. Run load_generator.js with --output first.')

x = [s['elapsedMs'] / 1000 for s in samples]
backend_ids = ['SYS2', 'SYS3', 'SYS4']

# Plot 1: LB response time summary over the run.
avg_rt = [s['metrics'].get('sys1_lb', {}).get('avgResponseTimeMs', 0) for s in samples]
plt.figure(figsize=(9, 5))
plt.plot(x, avg_rt, label='LB average response time')
plt.xlabel('Elapsed time (s)'); plt.ylabel('Response time (ms)')
plt.title('Load Generator: Load Balancer Response Time')
plt.grid(True, alpha=.25); plt.legend(); plt.tight_layout()
plt.savefig(out / 'response_time.png', dpi=160); plt.close()

# Plot 2: CPU utilization of all four systems.
plt.figure(figsize=(9, 5))
plt.plot(x, [s['metrics'].get('sys1_lb', {}).get('cpuPercent', 0) for s in samples], label='SYS1')
for bid in backend_ids:
    plt.plot(x, [next((b.get('cpuPercent', 0) for b in s['metrics'].get('backends', []) if b.get('system') == bid), 0) for s in samples], label=bid)
plt.xlabel('Elapsed time (s)'); plt.ylabel('CPU utilization (%)')
plt.title('System CPU Utilization')
plt.grid(True, alpha=.25); plt.legend(); plt.tight_layout()
plt.savefig(out / 'cpu_utilization.png', dpi=160); plt.close()

# Plot 3: memory utilization of all four systems.
plt.figure(figsize=(9, 5))
plt.plot(x, [s['metrics'].get('sys1_lb', {}).get('memoryPercent', 0) for s in samples], label='SYS1')
for bid in backend_ids:
    plt.plot(x, [next((b.get('memoryPercent', 0) for b in s['metrics'].get('backends', []) if b.get('system') == bid), 0) for s in samples], label=bid)
plt.xlabel('Elapsed time (s)'); plt.ylabel('Memory utilization (%)')
plt.title('System Memory Utilization')
plt.grid(True, alpha=.25); plt.legend(); plt.tight_layout()
plt.savefig(out / 'memory_utilization.png', dpi=160); plt.close()

# Plot 4: backend performance scores showing dynamic switching pressure.
plt.figure(figsize=(9, 5))
for bid in backend_ids:
    plt.plot(x, [next((b.get('score', 0) for b in s['metrics'].get('backends', []) if b.get('system') == bid), 0) for s in samples], label=bid)
plt.axhline(float(data.get('config', {}).get('overloadThreshold', 70)), linestyle='--', label='Overload threshold')
plt.xlabel('Elapsed time (s)'); plt.ylabel('Performance score (0–100)')
plt.title('Dynamic Backend Performance Scores')
plt.grid(True, alpha=.25); plt.legend(); plt.tight_layout()
plt.savefig(out / 'backend_scores.png', dpi=160); plt.close()

print(f'Created plots in {out.resolve()}')
