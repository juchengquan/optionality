import argparse
import time

import yaml

from optionality.core import load_config, run_task, send_notifications

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Optionality Parameters")
    parser.add_argument("-t", "--task", help="Task type", choices=["strategy", "holdings"], required=True)
    parser.add_argument("-f", "--setting_file", help="Configuration file", type=str, required=True)
    args = parser.parse_args()

    t_s = time.time()
    with open(args.setting_file) as f:
        raw = yaml.safe_load(f)

    config = load_config(args.task, raw)
    result = run_task(args.task, config)
    send_notifications(config.notification, result.html)

    print(f"Session closed. total time: {time.time() - t_s}")
