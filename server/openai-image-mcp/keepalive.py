"""keepalive.py — Hermes OAuth refresh_token rotation 維持用の cron 駆動ピング.

OAuthClientProvider は access_token が切れる度に refresh_token で新ペアに rotation
する。 そのたびに refresh_token の TTL タイマー (Hermes 側 30 日) もリセットされるので、
**何らかの呼び出しが定期的に起これば永続更新される**。

問題は「長期間 image-hub の openai-image を 1 度も使わなかった」ケース。 refresh_token
が完全失効 → 401 → 再 bootstrap (ブラウザ consent) が必要になる。

このスクリプトを週 1 で cron 駆動すれば、 実際の生成リクエストが 0 でも token は
常に活きる。 やることは Hermes に tools/list を 1 発投げるだけ (quota 消費なし、
数秒で終わる)。

cron:
    0 4 * * 0 kite docker exec image-hub-openai-image python /opt/xai-image-mcp/keepalive.py
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

from mcp.client.auth import OAuthClientProvider, TokenStorage
from mcp.client.session import ClientSession
from mcp.client.streamable_http import streamablehttp_client
from mcp.shared.auth import (
    OAuthClientInformationFull,
    OAuthClientMetadata,
    OAuthToken,
)


def _require_env(key: str) -> str:
    v = os.environ.get(key)
    if not v:
        sys.exit(f"FATAL: required env var {key!r} is not set")
    return v


_HERMES_URL = _require_env("HERMES_MCP_URL")
_OAUTH_STATE_PATH = Path(
    os.environ.get("HERMES_OAUTH_STATE_PATH", "/var/lib/hermes-oauth/state.json")
)


class FileTokenStorage(TokenStorage):
    """server.py / bootstrap_oauth.py と同形式の atomic + 0o600 ストレージ."""

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


async def _refuse_redirect(_url: str) -> None:
    raise RuntimeError(
        "FATAL: keepalive triggered OAuth redirect — refresh_token already dead. "
        "Re-bootstrap by running bootstrap_oauth.py locally and copying the new "
        f"state file to {_OAUTH_STATE_PATH}."
    )


async def _refuse_callback() -> tuple[str, str | None]:
    raise RuntimeError(
        "FATAL: keepalive triggered OAuth callback — bootstrap mode only"
    )


async def _main() -> None:
    storage = FileTokenStorage(_OAUTH_STATE_PATH)
    auth = OAuthClientProvider(
        server_url=_HERMES_URL,
        client_metadata=OAuthClientMetadata(
            redirect_uris=["http://localhost:9999/callback"],
            client_name="image-hub-openai-image",
            grant_types=["authorization_code", "refresh_token"],
            response_types=["code"],
        ),
        storage=storage,
        redirect_handler=_refuse_redirect,
        callback_handler=_refuse_callback,
    )

    async with streamablehttp_client(_HERMES_URL, auth=auth) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await session.list_tools()
            print(f"keepalive ok: hermes tools={len(tools.tools)}")


if __name__ == "__main__":
    asyncio.run(_main())
