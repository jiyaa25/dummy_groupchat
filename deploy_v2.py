import paramiko
import time
import os
import json

systems = [
    {"name": "SYS1", "port": 2261, "ip": "172.17.0.62", "role": "LB", "script": "start_lb.sh"},
    {"name": "SYS2", "port": 2262, "ip": "172.17.0.63", "role": "BACKEND", "script": "start_sys2.sh"},
    {"name": "SYS3", "port": 2263, "ip": "172.17.0.64", "role": "BACKEND", "script": "start_sys3.sh"},
    {"name": "SYS4", "port": 2264, "ip": "172.17.0.65", "role": "BACKEND", "script": "start_sys4.sh"},
]

host = "10.1.75.79"
username = "student"
password = "jisha.123"

local_base = os.path.dirname(os.path.abspath(__file__))

env_content = """# Distributed Systems Phase 2 - Professor Deployment
LB_PORT=3000
LB_URL=http://172.17.0.62:3000

PORT=3000
BACKEND_1_URL=http://172.17.0.63:3000
BACKEND_2_URL=http://172.17.0.64:3000
BACKEND_3_URL=http://172.17.0.65:3000

# Shared PostgreSQL database on SYS2
DB_HOST=172.17.0.63
DB_PORT=5432
DB_NAME=chat_db
DB_USER=student
DB_PASSWORD=jisha.123

ALLOW_MOCK_DB=false

QUEUE_WEIGHT=0.40
CPU_WEIGHT=0.20
MEMORY_WEIGHT=0.10
ACTIVE_REQUEST_WEIGHT=0.15
RESPONSE_TIME_WEIGHT=0.15

OVERLOAD_THRESHOLD=70.0
RECOVERY_THRESHOLD=55.0

HEARTBEAT_INTERVAL_MS=1000
HEARTBEAT_TIMEOUT_MS=3500
HEALTH_CHECK_INTERVAL_MS=1500

ENABLE_HTTPS=false
CRYPTO_SECRET=itisagroupprojectbyjiya
CRYPTO_SALT=1104
"""

files_to_upload = [
    ("server/env.js", "server/env.js"),
    ("server/crypto.js", "server/crypto.js"),
    ("server/metrics.js", "server/metrics.js"),
    ("server/heartbeat.js", "server/heartbeat.js"),
    ("server/db.js", "server/db.js"),
    ("server/messageService.js", "server/messageService.js"),
    ("server/index.js", "server/index.js"),
    ("lb/env.js", "lb/env.js"),
    ("lb/scoring.js", "lb/scoring.js"),
    ("lb/backendManager.js", "lb/backendManager.js"),
    ("lb/healthManager.js", "lb/healthManager.js"),
    ("lb/server.js", "lb/server.js"),
    ("daemon.js", "daemon.js"),
    ("db/schema.sql", "db/schema.sql"),
    ("deploy/start_lb.sh", "deploy/start_lb.sh"),
    ("deploy/start_sys2.sh", "deploy/start_sys2.sh"),
    ("deploy/start_sys3.sh", "deploy/start_sys3.sh"),
    ("deploy/start_sys4.sh", "deploy/start_sys4.sh"),
]

def get_ssh(port):
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, port=port, username=username, password=password, timeout=15)
    return client

def deploy_node(node):
    print(f"\n>>> Uploading to {node['name']} (port {node['port']})...")
    ssh = get_ssh(node["port"])
    sftp = ssh.open_sftp()
    remote_base = "/home/student/dummy_groupchat"

    ssh.exec_command(f"mkdir -p {remote_base}/server {remote_base}/lb {remote_base}/deploy")

    with sftp.open(f"{remote_base}/.env", "w") as f:
        f.write(env_content)

    for local_rel, remote_rel in files_to_upload:
        local_path = os.path.join(local_base, local_rel)
        remote_path = f"{remote_base}/{remote_rel}"
        if os.path.exists(local_path):
            sftp.put(local_path, remote_path)

    sftp.close()

    # Permissions & Syntax check
    ssh.exec_command(f"chmod +x {remote_base}/deploy/*.sh")
    stdin, stdout, stderr = ssh.exec_command(f"cd {remote_base} && node --check server/db.js server/messageService.js server/index.js lb/server.js daemon.js")
    err = stderr.read().decode().strip()
    if err:
        print(f"[{node['name']}] Syntax error: {err}")
    else:
        print(f"[{node['name']}] Files uploaded & syntax OK.")

    ssh.close()

def start_cluster():
    print("\n>>> Killing old node processes on all machines...")
    for n in systems:
        ssh = get_ssh(n["port"])
        ssh.exec_command("pkill -9 -f 'node ' || true")
        ssh.close()

    time.sleep(2)

    print("\n>>> Starting Backends (SYS2, SYS3, SYS4) with self-healing daemon...")
    for n in systems:
        if n["role"] == "BACKEND":
            ssh = get_ssh(n["port"])
            cmd = f"""bash -lc '
            cd /home/student/dummy_groupchat
            nohup ./deploy/{n["script"]} </dev/null >/dev/null 2>&1 &
            sleep 1
            '
            """
            ssh.exec_command(cmd)
            ssh.close()
            print(f"[{n['name']}] Launched daemon.")

    print("\n>>> Waiting 5 seconds for backends to initialize cache...")
    time.sleep(5)

    for n in systems:
        if n["role"] == "BACKEND":
            ssh = get_ssh(n["port"])
            stdin, stdout, stderr = ssh.exec_command("curl -s http://localhost:3000/health")
            print(f"[{n['name']}] Health: {stdout.read().decode().strip()}")
            ssh.close()

    print("\n>>> Starting Load Balancer on SYS1 with self-healing daemon...")
    ssh1 = get_ssh(2261)
    cmd_lb = """bash -lc '
    cd /home/student/dummy_groupchat
    nohup ./deploy/start_lb.sh </dev/null >/dev/null 2>&1 &
    sleep 1
    '
    """
    ssh1.exec_command(cmd_lb)
    ssh1.close()

    print(">>> Waiting 4 seconds for LB to establish heartbeats...")
    time.sleep(4)

    ssh1 = get_ssh(2261)
    stdin, stdout, stderr = ssh1.exec_command("curl -s http://localhost:3000/lb/health; echo ''; curl -s http://localhost:3000/lb/status")
    print("[SYS1] LB Health & Status:\n", stdout.read().decode().strip())
    ssh1.close()

if __name__ == "__main__":
    for n in systems:
        deploy_node(n)
    start_cluster()
    print("\n=== Cluster V2 Deployment Completed Successfully! ===")
