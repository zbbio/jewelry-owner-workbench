"""N14 live start: reuse the existing local Windows credential adapter only at authorized launch."""
import os
from pathlib import Path
import runpy
import subprocess
import sys


def main():
    try:
        adapter = Path(os.environ["LOCALAPPDATA"]) / "JewelryOwnerWorkbench" / "deepseek_test_shop.py"
        f = runpy.run_path(str(adapter))
        env = f["config"]()
        # Child receives only the already approved credential environment; the secret isn't printed, a flag, or serialized.
        return subprocess.run([str(f["NODE"]), str(Path(__file__).with_name("服务.mjs")), "--live"],
                              env=env, check=False).returncode
    except (OSError, ImportError, KeyError, ValueError):
        print("N14_LOCAL_CREDENTIAL_LAUNCH_UNAVAILABLE", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
