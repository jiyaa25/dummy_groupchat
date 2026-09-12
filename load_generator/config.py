import os

DEFAULT_CONFIG = {
    "url": os.getenv("LB_URL", "http://10.1.75.79:3261"),
    "users": 20,
    "duration": 30,
    "min_msg_length": 10,
    "max_msg_length": 150,
    "min_interval": 0.1,
    "max_interval": 1.0,
    "mode": "mixed", # "post", "feed", "mixed"
    "post_ratio": 0.7, # 70% POST /message, 30% GET /feed in mixed mode
    "output_dir": os.path.join(os.path.dirname(__file__), "../results/raw")
}
