import getpass
import json
import os
import re
import sys
import tempfile
from pathlib import Path


def save_credentials(directory, app_id, app_secret):
    if not re.fullmatch(r"cli_[A-Za-z0-9]+", app_id) or not app_secret.strip():
        raise ValueError("请填写有效的 App ID 和 App Secret。")

    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    destination = directory / "credentials.json"
    with tempfile.NamedTemporaryFile(mode="w", dir=directory, delete=False) as staged:
        try:
            json.dump({"appId": app_id, "appSecret": app_secret}, staged)
            staged.flush()
            os.fsync(staged.fileno())
            os.replace(staged.name, destination)
        finally:
            Path(staged.name).unlink(missing_ok=True)
    return destination


if __name__ == "__main__":
    if not sys.stdin.isatty():
        sys.exit("请在本机交互式终端运行。")
    app_id = input("App ID：").strip()
    secret = getpass.getpass("App Secret（输入隐藏）：").strip()
    try:
        destination = save_credentials(
            Path.home() / ".config/openmausbot/feishu-gateway", app_id, secret
        )
    except ValueError as error:
        sys.exit(str(error))
    print(f"凭据已保存到 {destination}")
