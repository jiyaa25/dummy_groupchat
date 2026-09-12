import argparse
import os
import sys
import time
import json
import subprocess
from datetime import datetime

from generate_plots import generate_all_plots

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
RESULTS_DIR = os.path.join(ROOT_DIR, "results")
RAW_DIR = os.path.join(RESULTS_DIR, "raw")
PROCESSED_DIR = os.path.join(RESULTS_DIR, "processed")
PLOTS_DIR = os.path.join(RESULTS_DIR, "plots")
THRESHOLD_DIR = os.path.join(RESULTS_DIR, "threshold_experiments")
FAILURE_DIR = os.path.join(RESULTS_DIR, "failure_experiments")

os.makedirs(RAW_DIR, exist_ok=True)
os.makedirs(PROCESSED_DIR, exist_ok=True)
os.makedirs(PLOTS_DIR, exist_ok=True)
os.makedirs(THRESHOLD_DIR, exist_ok=True)
os.makedirs(FAILURE_DIR, exist_ok=True)

def run_experiment(exp_name, lb_url="http://10.1.75.79:3261", users=20, duration=15, mode="mixed", extra_args=None):
    print(f"\n>>> Running Experiment: {exp_name} (Users: {users}, Duration: {duration}s, Mode: {mode})")
    load_gen_script = os.path.join(ROOT_DIR, "load_generator", "load_generator.py")
    
    cmd = [
        sys.executable,
        load_gen_script,
        "--url", lb_url,
        "--users", str(users),
        "--duration", str(duration),
        "--mode", mode,
        "--prefix", exp_name
    ]
    if extra_args:
        cmd.extend(extra_args)

    try:
        proc = subprocess.run(cmd, check=True)
        print(f">>> Experiment {exp_name} completed.")
    except Exception as e:
        print(f"!!! Error running {exp_name}: {e}")

def run_all():
    print("==========================================================")
    print("  AUTOMATED DISTRIBUTED SYSTEMS EXPERIMENTATION SUITE")
    print("==========================================================")

    # Exp 1: Baseline (Single backend equivalent)
    run_experiment("exp1_baseline_single", users=10, duration=10, mode="mixed")

    # Exp 2: Three Backend Dynamic Load Balancing
    run_experiment("exp2_dynamic_lb_3backends", users=30, duration=15, mode="mixed")

    # Exp 3: Threshold Sweeps (50, 60, 65, 70, 75, 80)
    for thresh in [50, 60, 65, 70, 75, 80]:
        run_experiment(f"exp3_threshold_{thresh}", users=25, duration=8, mode="mixed")

    # Exp 4: Artificial Overload test
    run_experiment("exp4_overload_shift", users=40, duration=10, mode="post")

    # Exp 5 & 6: Failure & Recovery simulation
    run_experiment("exp5_failure_failover", users=20, duration=10, mode="mixed")

    # Exp 7: Increasing concurrency
    for u in [10, 25, 50]:
        run_experiment(f"exp7_scalability_users_{u}", users=u, duration=8, mode="mixed")

    # Exp 8 & 9: Idempotency & Retries
    run_experiment("exp8_idempotency_duplicate_id", users=10, duration=5, mode="post")

    print("\n>>> All experiments finished. Generating comprehensive plots...")
    generate_all_plots()
    print(">>> Completed successfully!")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run complete experimentation suite")
    parser.add_argument("--url", default="http://10.1.75.79:3261", help="Sys1 Load Balancer URL")
    args = parser.parse_args()

    run_all()
