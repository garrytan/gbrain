#!/usr/bin/env python3
import os, sys, json
from dotenv import load_dotenv
load_dotenv()

import loop, store


def main():
    args = sys.argv[1:]
    if not args:
        print("Usage:\n  python cli.py [--verbose] \"<task>\"\n"
              "  python cli.py show <run_id>\n"
              "  python cli.py replay <run_id>")
        sys.exit(1)

    if "--verbose" in args:
        os.environ["HARNESS_VERBOSE"] = "1"
        args = [a for a in args if a != "--verbose"]

    if args[0] == "show" and len(args) == 2:
        print(json.dumps(store.get_run(args[1]), indent=2, default=str))
    elif args[0] == "replay" and len(args) == 2:
        msgs = store.replay_run(args[1])
        print(json.dumps(msgs, indent=2, default=str))
    else:
        task = " ".join(args)
        print(f"[harness] task: {task}\n", flush=True)
        result = loop.run(task)
        print(f"\n[harness] result:\n{result}", flush=True)


if __name__ == "__main__":
    main()
