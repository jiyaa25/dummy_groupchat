import argparse
import csv
import json
import os
import random
import ssl
import string
import sys
import threading
import time
import urllib.request
import urllib.error
import uuid
from datetime import datetime

from config import DEFAULT_CONFIG

# Create SSL context to allow self-signed certificates in HTTPS mode
ssl_context = ssl.create_default_context()
ssl_context.check_hostname = False
ssl_context.verify_mode = ssl.CERT_NONE

class LoadGenerator:
    def __init__(self, url, users, duration, min_msg_length, max_msg_length, min_interval, max_interval, mode="mixed", post_ratio=0.7, output_prefix="load_test"):
        self.url = url.rstrip('/')
        self.users = users
        self.duration = duration
        self.min_msg_length = min_msg_length
        self.max_msg_length = max_msg_length
        self.min_interval = min_interval
        self.max_interval = max_interval
        self.mode = mode
        self.post_ratio = post_ratio
        self.output_prefix = output_prefix

        self.records = []
        self.records_lock = threading.Lock()
        self.stop_event = threading.Event()

    def generate_random_message(self):
        length = random.randint(self.min_msg_length, self.max_msg_length)
        letters = string.ascii_letters + string.digits + " !?.,:;-"
        return ''.join(random.choice(letters) for _ in range(length))

    def send_post_message(self, user_name):
        msg_text = self.generate_random_message()
        msg_id = str(uuid.uuid4())
        payload = json.dumps({
            "client-name": user_name,
            "msg": msg_text,
            "message_id": msg_id
        }).encode('utf-8')

        req = urllib.request.Request(
            f"{self.url}/message",
            data=payload,
            headers={
                "Content-Type": "application/json",
                "User-Agent": f"LoadGen-User/{user_name}"
            },
            method="POST"
        )

        start_time = time.time()
        success = False
        status_code = 0
        resp_size = 0
        error_msg = ""

        try:
            with urllib.request.urlopen(req, context=ssl_context, timeout=10.0) as resp:
                status_code = resp.status
                body = resp.read()
                resp_size = len(body)
                success = (200 <= status_code < 300)
        except urllib.error.HTTPError as e:
            status_code = e.code
            error_msg = str(e)
            try:
                body = e.read()
                resp_size = len(body)
            except:
                pass
        except Exception as e:
            error_msg = str(e)
            status_code = 0

        duration_ms = (time.time() - start_time) * 1000.0

        record = {
            "timestamp": datetime.now().isoformat(),
            "user": user_name,
            "request_type": "POST /message",
            "message_id": msg_id,
            "status_code": status_code,
            "response_time_ms": round(duration_ms, 2),
            "success": success,
            "error": error_msg,
            "request_size": len(payload),
            "response_size": resp_size
        }

        with self.records_lock:
            self.records.append(record)

        return record

    def send_get_feed(self, user_name):
        req = urllib.request.Request(
            f"{self.url}/feed",
            headers={
                "User-Agent": f"LoadGen-User/{user_name}"
            },
            method="GET"
        )

        start_time = time.time()
        success = False
        status_code = 0
        resp_size = 0
        error_msg = ""

        try:
            with urllib.request.urlopen(req, context=ssl_context, timeout=10.0) as resp:
                status_code = resp.status
                body = resp.read()
                resp_size = len(body)
                success = (200 <= status_code < 300)
        except urllib.error.HTTPError as e:
            status_code = e.code
            error_msg = str(e)
            try:
                body = e.read()
                resp_size = len(body)
            except:
                pass
        except Exception as e:
            error_msg = str(e)
            status_code = 0

        duration_ms = (time.time() - start_time) * 1000.0

        record = {
            "timestamp": datetime.now().isoformat(),
            "user": user_name,
            "request_type": "GET /feed",
            "message_id": "",
            "status_code": status_code,
            "response_time_ms": round(duration_ms, 2),
            "success": success,
            "error": error_msg,
            "request_size": 0,
            "response_size": resp_size
        }

        with self.records_lock:
            self.records.append(record)

        return record

    def user_worker(self, user_id):
        user_name = f"User_{user_id:03d}"
        
        while not self.stop_event.is_set():
            if self.mode == "post":
                self.send_post_message(user_name)
            elif self.mode == "feed":
                self.send_get_feed(user_name)
            else:
                # Mixed mode
                if random.random() < self.post_ratio:
                    self.send_post_message(user_name)
                else:
                    self.send_get_feed(user_name)

            sleep_time = random.uniform(self.min_interval, self.max_interval)
            time.sleep(sleep_time)

    def run(self):
        print(f"==================================================")
        print(f"Starting Load Generator")
        print(f"Target URL:        {self.url}")
        print(f"Concurrent Users:  {self.users}")
        print(f"Duration:          {self.duration}s")
        print(f"Msg Length Range:  {self.min_msg_length} - {self.max_msg_length} chars")
        print(f"Interval Range:    {self.min_interval}s - {self.max_interval}s")
        print(f"Mode:              {self.mode}")
        print(f"==================================================")

        threads = []
        start_ts = time.time()

        for i in range(1, self.users + 1):
            t = threading.Thread(target=self.user_worker, args=(i,), daemon=True)
            threads.append(t)
            t.start()

        # Run for specified duration
        time.sleep(self.duration)
        self.stop_event.set()

        for t in threads:
            t.join(timeout=1.0)

        total_time = time.time() - start_ts
        self.save_and_report(total_time)

    def save_and_report(self, total_time):
        out_dir = os.path.join(os.path.dirname(__file__), "../results/raw")
        os.makedirs(out_dir, exist_ok=True)

        timestamp_str = datetime.now().strftime("%Y%m%d_%H%M%S")
        csv_path = os.path.join(out_dir, f"{self.output_prefix}_{timestamp_str}.csv")
        json_path = os.path.join(out_dir, f"{self.output_prefix}_{timestamp_str}.json")

        # Write CSV
        with open(csv_path, 'w', newline='', encoding='utf-8') as f:
            writer = csv.DictWriter(f, fieldnames=[
                "timestamp", "user", "request_type", "message_id", "status_code",
                "response_time_ms", "success", "error", "request_size", "response_size"
            ])
            writer.writeheader()
            writer.writerows(self.records)

        # Compute summary metrics
        total_reqs = len(self.records)
        successful_reqs = sum(1 for r in self.records if r["success"])
        failed_reqs = total_reqs - successful_reqs
        latencies = [r["response_time_ms"] for r in self.records if r["success"]]
        latencies.sort()

        avg_latency = round(sum(latencies) / len(latencies), 2) if latencies else 0
        p50_latency = latencies[int(len(latencies) * 0.50)] if latencies else 0
        p95_latency = latencies[int(len(latencies) * 0.95)] if latencies else 0
        p99_latency = latencies[int(len(latencies) * 0.99)] if latencies else 0
        throughput = round(total_reqs / total_time, 2) if total_time > 0 else 0

        summary = {
            "timestamp": datetime.now().isoformat(),
            "target_url": self.url,
            "users": self.users,
            "duration_seconds": round(total_time, 2),
            "total_requests": total_reqs,
            "successful_requests": successful_reqs,
            "failed_requests": failed_reqs,
            "error_rate_percent": round((failed_reqs / total_reqs * 100), 2) if total_reqs > 0 else 0,
            "throughput_req_per_sec": throughput,
            "avg_latency_ms": avg_latency,
            "p50_latency_ms": p50_latency,
            "p95_latency_ms": p95_latency,
            "p99_latency_ms": p99_latency,
            "raw_csv_file": csv_path
        }

        with open(json_path, 'w', encoding='utf-8') as f:
            json.dump(summary, f, indent=2)

        print("\n--- Load Test Results ---")
        print(f"Total Requests:     {total_reqs}")
        print(f"Successful:         {successful_reqs}")
        print(f"Failed:             {failed_reqs}")
        print(f"Throughput:         {throughput} req/sec")
        print(f"Avg Response Time:  {avg_latency} ms")
        print(f"P95 Response Time:  {p95_latency} ms")
        print(f"P99 Response Time:  {p99_latency} ms")
        print(f"Raw data saved to:  {csv_path}")
        print(f"Summary saved to:   {json_path}")
        print("-------------------------")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Distributed Systems Load Generator")
    parser.add_argument("--url", default=DEFAULT_CONFIG["url"], help="Target Load Balancer URL")
    parser.add_argument("--users", type=int, default=DEFAULT_CONFIG["users"], help="Number of concurrent users")
    parser.add_argument("--duration", type=int, default=DEFAULT_CONFIG["duration"], help="Duration in seconds")
    parser.add_argument("--min-msg-length", type=int, default=DEFAULT_CONFIG["min_msg_length"], help="Min message length")
    parser.add_argument("--max-msg-length", type=int, default=DEFAULT_CONFIG["max_msg_length"], help="Max message length")
    parser.add_argument("--min-interval", type=float, default=DEFAULT_CONFIG["min_interval"], help="Min interval in seconds")
    parser.add_argument("--max-interval", type=float, default=DEFAULT_CONFIG["max_interval"], help="Max interval in seconds")
    parser.add_argument("--mode", choices=["post", "feed", "mixed"], default=DEFAULT_CONFIG["mode"], help="Request mode")
    parser.add_argument("--prefix", default="load_test", help="Output file prefix")

    args = parser.parse_args()

    gen = LoadGenerator(
        url=args.url,
        users=args.users,
        duration=args.duration,
        min_msg_length=args.min_msg_length,
        max_msg_length=args.max_msg_length,
        min_interval=args.min_interval,
        max_interval=args.max_interval,
        mode=args.mode,
        output_prefix=args.prefix
    )
    gen.run()
