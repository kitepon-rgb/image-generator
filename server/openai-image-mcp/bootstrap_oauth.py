"""bootstrap_oauth.py — HermesAgent への OAuth 初回 consent を 1 回だけ走らせる.

このスクリプトはコンテナの中ではなく、ブラウザがある手元のマシン (例: WSL2 +
Windows ブラウザ) で 1 度だけ動かす。 DCR で client 登録 → ブラウザで consent →
authorization_code → token 交換 → state ファイル保存、 までを完走させる。

生成された state ファイルを prod へ scp して openai-image-mcp の bind mount 先
(/home/kite/image-hub/hermes_oauth/state.json) に置けば、 以降は server.py が
refresh_token rotation で自動更新を回す。 再 bootstrap が必要になるのは
refresh_token が完全失効 (例: 30 日以上未使用、 Hermes 側で revoke) した時のみ。

Usage:
    HERMES_MCP_URL=https://hermes.kitepon.dynv6.net/mcp \\
        python bootstrap_oauth.py [output_state_file]

output_state_file が省略されたら ./hermes_oauth_state.json に書く。
"""

from __future__ import annotations

import asyncio
import http.server
import json
import os
import sys
import threading
import webbrowser
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from mcp.client.auth import OAuthClientProvider, TokenStorage
from mcp.client.session import ClientSession
from mcp.client.streamable_http import streamablehttp_client
from mcp.shared.auth import (
    OAuthClientInformationFull,
    OAuthClientMetadata,
    OAuthToken,
)

CALLBACK_PORT = 9999
CALLBACK_URL = f"http://localhost:{CALLBACK_PORT}/callback"


class FileTokenStorage(TokenStorage):
    """server.py 側と同形式の atomic write + chmod 0o600 ストレージ."""

    def __init__(self, path: Path) -> None:
        self._path = path
        self._lock = asyncio.Lock()

    async def _read(self) -> dict[str, Any]:
        if not self._path.exists():
            return {}
        return json.loads(self._path.read_text())

    async def _write(self, data: dict[str, Any]) -> None:
        async with self._lock:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._path.with_suffix(".tmp")
            tmp.write_text(json.dumps(data, indent=2))
            os.chmod(tmp, 0o600)
            tmp.replace(self._path)

    async def get_tokens(self) -> OAuthToken | None:
        data = await self._read()
        raw = data.get("tokens")
        return OAuthToken.model_validate(raw) if raw else None

    async def set_tokens(self, tokens: OAuthToken) -> None:
        data = await self._read()
        data["tokens"] = tokens.model_dump(mode="json")
        await self._write(data)

    async def get_client_info(self) -> OAuthClientInformationFull | None:
        data = await self._read()
        raw = data.get("client_info")
        return OAuthClientInformationFull.model_validate(raw) if raw else None

    async def set_client_info(self, info: OAuthClientInformationFull) -> None:
        data = await self._read()
        data["client_info"] = info.model_dump(mode="json")
        await self._write(data)


class _CallbackHandler(http.server.BaseHTTPRequestHandler):
    code: str | None = None
    state: str | None = None

    def do_GET(self) -> None:  # noqa: N802 (BaseHTTPRequestHandler convention)
        parsed = urlparse(self.path)
        if parsed.path != "/callback":
            self.send_response(404)
            self.end_headers()
            return
        params = parse_qs(parsed.query)
        _CallbackHandler.code = params.get("code", [None])[0]
        _CallbackHandler.state = params.get("state", [None])[0]
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(
            b"<html><body><h1>OAuth complete.</h1>"
            b"<p>Tokens saved. You can close this window.</p></body></html>"
        )

    def log_message(self, *args: Any, **kwargs: Any) -> None:  # silence access log
        return


async def _main() -> None:
    hermes_url = os.environ.get("HERMES_MCP_URL", "https://hermes.kitepon.dynv6.net/mcp")
    state_path = Path(sys.argv[1] if len(sys.argv) > 1 else "./hermes_oauth_state.json").resolve()
    print(f"Hermes URL    : {hermes_url}")
    print(f"State file out: {state_path}\n")

    httpd = http.server.HTTPServer(("localhost", CALLBACK_PORT), _CallbackHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    async def redirect_handler(url: str) -> None:
        print("Opening browser for OAuth consent:")
        print(f"  {url}\n")
        try:
            webbrowser.open(url)
        except Exception:  # noqa: BLE001 — fallback to manual paste
            print("(webbrowser.open failed — paste the URL above into a browser manually)\n")

    async def callback_handler() -> tuple[str, str | None]:
        print(f"Waiting for callback at {CALLBACK_URL} ...")
        while _CallbackHandler.code is None:
            await asyncio.sleep(0.1)
        print("Callback received. Exchanging code for tokens ...\n")
        return _CallbackHandler.code, _CallbackHandler.state

    storage = FileTokenStorage(state_path)
    auth = OAuthClientProvider(
        server_url=hermes_url,
        client_metadata=OAuthClientMetadata(
            redirect_uris=[CALLBACK_URL],
            client_name="image-hub-openai-image",
            grant_types=["authorization_code", "refresh_token"],
            response_types=["code"],
        ),
        storage=storage,
        redirect_handler=redirect_handler,
        callback_handler=callback_handler,
    )

    async with streamablehttp_client(hermes_url, auth=auth) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await session.list_tools()
            tool_names = [t.name for t in tools.tools]
            print("OAuth complete + session live.")
            print(f"  state file : {state_path}")
            print(f"  tools/list : {len(tool_names)} tools ({', '.join(tool_names[:3])}...)")
            print()
            print("Next steps:")
            print(
                "  ssh kite@192.168.1.2 'mkdir -p /home/kite/image-hub/hermes_oauth'"
            )
            print(
                f"  scp {state_path} kite@192.168.1.2:/home/kite/image-hub/hermes_oauth/state.json"
            )
            print(
                "  ssh kite@192.168.1.2 'cd /home/kite/image-hub && "
                "docker compose up -d openai-image-mcp'"
            )

    httpd.shutdown()


if __name__ == "__main__":
    asyncio.run(_main())
