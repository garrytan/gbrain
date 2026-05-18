import subprocess, tempfile, shutil
from pathlib import Path
from tools import Tool

# Minimal safe environment: no inherited PATH tricks, no $HOME bleed.
_SAFE_ENV = {"PATH": "/usr/bin:/bin", "TMPDIR": "/tmp", "LANG": "en_US.UTF-8"}


class Bash(Tool):
    name = "bash"
    description = (
        "Run a shell command in an isolated sandbox directory. "
        "PATH is restricted to /usr/bin:/bin. No network restriction."
    )
    schema = {
        "name": "bash",
        "description": description,
        "input_schema": {
            "type": "object",
            "properties": {
                "cmd": {"type": "string", "description": "Shell command to run"},
            },
            "required": ["cmd"],
        },
    }

    def execute(self, cmd: str) -> str:
        sandbox = Path(tempfile.mkdtemp(prefix="harness-"))
        try:
            result = subprocess.run(
                cmd, shell=True, capture_output=True, text=True,
                timeout=30, cwd=str(sandbox), env=_SAFE_ENV,
            )
        finally:
            shutil.rmtree(sandbox, ignore_errors=True)
        return (
            f"exit_code={result.returncode}\n"
            f"stdout:\n{result.stdout}\n"
            f"stderr:\n{result.stderr}"
        )
