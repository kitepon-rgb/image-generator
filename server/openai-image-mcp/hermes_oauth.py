"""hermes_oauth.py — X-HERMES-MCP の OAuth access token を 1 時間 TTL の事前更新で
常に新鮮に保つ補助モジュール (server.py / keepalive.py が共有して使う).

# なぜ必要か

MCP SDK の OAuthClientProvider は access_token の有効期限 (token_expiry_time) を
プロセスメモリ内にしか保持せず、 state ファイルから復元しない。 server.py /
keepalive.py は Hermes を叩くたびに新しい provider を作り直すため、 作りたての
provider は毎回 token_expiry_time=None → 「token は常に有効」と誤判定し、 期限切れ
access_token をそのまま送って 401 を踏む。

X-HERMES 検証で判明: SDK の 401 後の動線は refresh_token grant ではなく
authorization_code grant (ブラウザ consent) に直行する。 headless コンテナでは
server.py の _refuse_redirect が発火して RuntimeError で即死する。

対策として、 Hermes を叩く前に ensure_fresh_access_token() が state ファイルの
絶対時刻 expires_at を見て、 期限間近なら refresh_token grant を token endpoint に
直接 POST して access_token を事前更新する。 並行プロジェクト Chime の
chime/hermes_client.py と意図的に同一パターンに揃えている。
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from pathlib import Path
from typing import Any

import httpx


def _require_env(key: str) -> str:
    v = os.environ.get(key)
    if not v:
        raise SystemExit(f"FATAL: required env var {key!r} is not set")
    return v


HERMES_URL = _require_env("HERMES_MCP_URL")
HERMES_STATE_PATH = Path(
    os.environ.get("HERMES_OAUTH_STATE_PATH", "/var/lib/hermes-oauth/state.json")
)

# access_token の expire 何秒前から事前 refresh するか。
TOKEN_REFRESH_LEEWAY_S = 300

# 同一プロセス内の複数呼び出しが同時に refresh して refresh_token を二重ローテ
# (= rotation の reuse 検知でトークンファミリごと revoke) するのを防ぐ lock。
_REFRESH_LOCK = threading.Lock()


def _read_state() -> dict[str, Any]:
    if not HERMES_STATE_PATH.exists():
        return {}
    return json.loads(HERMES_STATE_PATH.read_text(encoding="utf-8"))


def _write_state(data: dict[str, Any]) -> None:
    """state ファイルを atomic write (.tmp → rename) で保存、 perm 0o600 を維持する."""
    HERMES_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = HERMES_STATE_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(HERMES_STATE_PATH)


def _discover_token_endpoint() -> str:
    """Hermes の OAuth authorization-server metadata から token endpoint を発見する."""
    base = HERMES_URL.rsplit("/", 1)[0] if HERMES_URL.endswith("/mcp") else HERMES_URL
    resp = httpx.get(f"{base}/.well-known/oauth-authorization-server", timeout=10.0)
    resp.raise_for_status()
    endpoint = resp.json().get("token_endpoint")
    if not endpoint:
        raise RuntimeError(
            f"hermes authorization-server metadata missing token_endpoint: {resp.text[:300]}"
        )
    return endpoint


def ensure_fresh_access_token(force: bool = False) -> bool:
    """state ファイルの access_token が expire 間近 (or force=True) なら事前 refresh する.

    state ファイルの tokens に絶対時刻 expires_at (unix 秒) を持たせ、 プロセスを
    跨いでも expire 判定できるようにする。 bootstrap 直後の state に expires_at が
    無くても、 初回 refresh で必ず付与される。

    Returns:
        True  — access_token が利用可能 (まだ有効 / 事前 refresh 成功)。
        False — refresh できなかった (未 bootstrap / client 資格情報欠落 /
                refresh_token 失効)。 呼び出し元で再 bootstrap 等の判断が要る。
    """
    with _REFRESH_LOCK:
        data = _read_state()
        tokens = data.get("tokens") or {}
        client = data.get("client_info") or {}
        refresh_token = tokens.get("refresh_token")
        if not refresh_token:
            print(
                f"WARN: hermes state has no refresh_token ({HERMES_STATE_PATH}) — "
                "bootstrap required",
                file=sys.stderr,
            )
            return False
        client_id = client.get("client_id")
        client_secret = client.get("client_secret")
        if not client_id or not client_secret:
            print(
                "WARN: hermes state client_info missing client_id/client_secret — "
                "proactive refresh disabled",
                file=sys.stderr,
            )
            return False

        now = time.time()
        expires_at = tokens.get("expires_at")
        if (
            not force
            and isinstance(expires_at, (int, float))
            and now + TOKEN_REFRESH_LEEWAY_S < expires_at
        ):
            return True  # まだ十分新鮮、 refresh 不要

        token_url = _discover_token_endpoint()
        try:
            resp = httpx.post(
                token_url,
                data={
                    "grant_type": "refresh_token",
                    "refresh_token": refresh_token,
                    "client_id": client_id,
                    "client_secret": client_secret,
                },
                timeout=15.0,
            )
        except httpx.RequestError as e:
            print(f"WARN: hermes proactive refresh request failed: {e}", file=sys.stderr)
            return False

        if resp.status_code != 200:
            # refresh_token が完全失効 (Hermes 側 revoke / 30 日アイドル) のとき。
            # 再 bootstrap が必要。
            print(
                f"WARN: hermes proactive refresh returned {resp.status_code}: "
                f"{resp.text[:300]}",
                file=sys.stderr,
            )
            return False

        body = resp.json()
        expires_in = int(body.get("expires_in", 3600))
        new_refresh = body.get("refresh_token", refresh_token)
        data["tokens"] = {
            "access_token": body["access_token"],
            "token_type": body.get("token_type", "Bearer"),
            "expires_in": expires_in,
            "scope": body.get("scope") or tokens.get("scope"),
            # rotation 対応: refresh_token が返れば追従、 無ければ旧 token を維持。
            "refresh_token": new_refresh,
            # 絶対時刻でも持たせる (プロセス跨ぎの expire 判定用)。
            "expires_at": time.time() + expires_in,
        }
        _write_state(data)
        rotated = "yes" if new_refresh != refresh_token else "no"
        print(
            f"hermes access_token refreshed (expires_in={expires_in}s, rotation={rotated})",
            file=sys.stderr,
        )
        return True
