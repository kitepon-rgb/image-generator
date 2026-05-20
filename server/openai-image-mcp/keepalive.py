"""keepalive.py — Hermes OAuth refresh_token rotation 維持用の cron 駆動ピング.

OAuth の refresh_token には Hermes 側 30 日のアイドル TTL がある。 image-hub の
openai-image を 1 度も使わない週があると rotation が走らず、 refresh_token が
完全失効 → 401 → 再 bootstrap (ブラウザ consent) が必要になる。

このスクリプトを週 1 cron で叩けば、 実際の生成リクエストが 0 でも
ensure_fresh_access_token(force=True) が refresh_token grant を 1 回踏み、
rotation で refresh_token の TTL タイマーがリセットされる。 画像生成 quota の
消費なし、 数秒で完走する。

cron:
    0 4 * * 0 kite docker exec image-hub-openai-image python /opt/xai-image-mcp/keepalive.py
"""

from __future__ import annotations

import sys

from hermes_oauth import HERMES_STATE_PATH, ensure_fresh_access_token


def main() -> None:
    ok = ensure_fresh_access_token(force=True)
    if not ok:
        sys.exit(
            f"FATAL: hermes keepalive could not rotate refresh_token "
            f"(state={HERMES_STATE_PATH}). Re-bootstrap with bootstrap_oauth.py."
        )
    print("keepalive ok: hermes refresh_token rotated")


if __name__ == "__main__":
    main()
