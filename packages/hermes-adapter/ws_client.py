"""Lightweight async WebSocket + HTTP helpers for the ChlorIM Hermes adapter.

Prefers ``websockets`` and ``httpx`` when installed in the Hermes virtualenv,
and transparently falls back to Python standard library implementations so the
adapter works with zero extra dependencies in any Python >= 3.10 environment.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import mimetypes
import os
import ssl
import struct
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any, Dict, Optional, Tuple

try:
    import websockets as _websockets  # type: ignore[import-not-found]
except ImportError:
    _websockets = None

try:
    import httpx as _httpx  # type: ignore[import-not-found]
except ImportError:
    _httpx = None

_WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class WebSocketClosed(Exception):
    """Raised when the remote peer closes the WebSocket connection."""

    def __init__(self, code: int = 1000, reason: str = "") -> None:
        super().__init__(f"WebSocket closed ({code}): {reason}")
        self.code = code
        self.reason = reason


class StdlibWebSocket:
    """Minimal RFC 6455 asyncio WebSocket client using only the Python stdlib."""

    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self._reader = reader
        self._writer = writer
        self._closed = False
        self._write_lock = asyncio.Lock()

    @classmethod
    async def connect(
        cls,
        url: str,
        headers: Optional[Dict[str, str]] = None,
        timeout: float = 10.0,
    ) -> "StdlibWebSocket":
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme not in ("ws", "wss"):
            raise ValueError(f"Unsupported WebSocket scheme: {parsed.scheme}")
        secure = parsed.scheme == "wss"
        host = parsed.hostname or "127.0.0.1"
        port = parsed.port or (443 if secure else 80)
        path = parsed.path or "/"
        if parsed.query:
            path = f"{path}?{parsed.query}"

        ssl_ctx = ssl.create_default_context() if secure else None
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(host, port, ssl=ssl_ctx, server_hostname=host if secure else None),
            timeout=timeout,
        )

        key = base64.b64encode(os.urandom(16)).decode("ascii")
        host_header = f"{host}:{port}" if parsed.port else host
        req_headers = {
            "Host": host_header,
            "Upgrade": "websocket",
            "Connection": "Upgrade",
            "Sec-WebSocket-Key": key,
            "Sec-WebSocket-Version": "13",
            **(headers or {}),
        }
        lines = [f"GET {path} HTTP/1.1"] + [f"{k}: {v}" for k, v in req_headers.items()]
        writer.write(("\r\n".join(lines) + "\r\n\r\n").encode("utf-8"))
        await writer.drain()

        status_line = await asyncio.wait_for(reader.readline(), timeout=timeout)
        if b" 101 " not in status_line:
            writer.close()
            raise ConnectionError(f"WebSocket handshake failed: {status_line.decode('utf-8', 'replace').strip()}")

        resp_headers: Dict[str, str] = {}
        while True:
            line = await asyncio.wait_for(reader.readline(), timeout=timeout)
            if line in (b"\r\n", b"\n", b""):
                break
            decoded = line.decode("utf-8", "replace").strip()
            if ":" in decoded:
                k, v = decoded.split(":", 1)
                resp_headers[k.strip().lower()] = v.strip()

        expected = base64.b64encode(hashlib.sha1((key + _WS_GUID).encode("ascii")).digest()).decode("ascii")
        if resp_headers.get("sec-websocket-accept") != expected:
            writer.close()
            raise ConnectionError("Invalid Sec-WebSocket-Accept header")

        return cls(reader, writer)

    async def _send_frame(self, opcode: int, payload: bytes) -> None:
        if self._closed:
            raise WebSocketClosed(1006, "Already closed")
        mask = os.urandom(4)
        length = len(payload)
        header = bytearray([0x80 | opcode])
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header.extend(struct.pack("!H", length))
        else:
            header.append(0x80 | 127)
            header.extend(struct.pack("!Q", length))
        header.extend(mask)
        masked = bytes(b ^ mask[i & 3] for i, b in enumerate(payload))
        async with self._write_lock:
            self._writer.write(bytes(header) + masked)
            await self._writer.drain()

    async def send(self, text: str) -> None:
        await self._send_frame(0x1, text.encode("utf-8"))

    async def ping(self) -> None:
        await self._send_frame(0x9, b"")

    async def close(self, code: int = 1000, reason: str = "") -> None:
        if self._closed:
            return
        try:
            payload = struct.pack("!H", code) + reason.encode("utf-8")[:120]
            await self._send_frame(0x8, payload)
        except Exception:
            pass
        self._closed = True
        try:
            self._writer.close()
            await self._writer.wait_closed()
        except Exception:
            pass

    async def _read_frame(self) -> Tuple[bool, int, bytes]:
        head = await self._reader.readexactly(2)
        fin = bool(head[0] & 0x80)
        opcode = head[0] & 0x0F
        masked = bool(head[1] & 0x80)
        length = head[1] & 0x7F
        if length == 126:
            length = struct.unpack("!H", await self._reader.readexactly(2))[0]
        elif length == 127:
            length = struct.unpack("!Q", await self._reader.readexactly(8))[0]
        mask = await self._reader.readexactly(4) if masked else None
        data = await self._reader.readexactly(length) if length else b""
        if mask:
            data = bytes(b ^ mask[i & 3] for i, b in enumerate(data))
        return fin, opcode, data

    async def recv(self, timeout: float = 75.0) -> str:
        chunks: list[bytes] = []
        while True:
            try:
                fin, opcode, data = await asyncio.wait_for(self._read_frame(), timeout=timeout)
            except asyncio.TimeoutError as exc:
                self._closed = True
                raise WebSocketClosed(1006, "Read timeout") from exc
            except asyncio.IncompleteReadError as exc:
                self._closed = True
                raise WebSocketClosed(1006, "EOF") from exc
            if opcode == 0x8:  # Close
                code = struct.unpack("!H", data[:2])[0] if len(data) >= 2 else 1000
                reason = data[2:].decode("utf-8", "replace") if len(data) > 2 else ""
                await self.close(code, reason)
                raise WebSocketClosed(code, reason)
            if opcode == 0x9:  # Ping -> Pong
                await self._send_frame(0xA, data)
                continue
            if opcode == 0xA:  # Pong
                continue
            if opcode in (0x0, 0x1):  # Continuation / Text
                chunks.append(data)
                if fin:
                    return b"".join(chunks).decode("utf-8")
            elif opcode == 0x2:
                raise ValueError("Unexpected binary frame")


class _WebsocketsCompat:
    """Thin wrapper normalizing ``websockets`` API to match ``StdlibWebSocket``."""

    def __init__(self, conn: Any) -> None:
        self._conn = conn

    async def send(self, text: str) -> None:
        await self._conn.send(text)

    async def ping(self) -> None:
        await self._conn.ping()

    async def recv(self, timeout: float = 75.0) -> str:
        try:
            msg = await asyncio.wait_for(self._conn.recv(), timeout=timeout)
            return msg if isinstance(msg, str) else msg.decode("utf-8")
        except asyncio.TimeoutError as exc:
            raise WebSocketClosed(1006, "Read timeout") from exc
        except Exception as exc:
            code = getattr(exc, "code", 1006)
            reason = getattr(exc, "reason", str(exc))
            raise WebSocketClosed(code, reason) from exc

    async def close(self, code: int = 1000, reason: str = "") -> None:
        try:
            await self._conn.close(code=code, reason=reason)
        except Exception:
            pass


async def open_websocket(
    url: str,
    headers: Optional[Dict[str, str]] = None,
    timeout: float = 10.0,
) -> Any:
    if _websockets is not None:
        kwargs: Dict[str, Any] = {"open_timeout": timeout, "max_size": 32 * 1024 * 1024}
        try:
            conn = await _websockets.connect(url, additional_headers=headers or {}, **kwargs)
        except TypeError:
            conn = await _websockets.connect(url, extra_headers=headers or {}, **kwargs)
        return _WebsocketsCompat(conn)
    return await StdlibWebSocket.connect(url, headers=headers, timeout=timeout)


def _urllib_json_sync(
    method: str,
    url: str,
    headers: Dict[str, str],
    body: Optional[Dict[str, Any]],
    timeout: float,
) -> Tuple[int, Any]:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req_headers = dict(headers)
    if data is not None:
        req_headers.setdefault("Content-Type", "application/json")
    request = urllib.request.Request(url, data=data, headers=req_headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as err:
        raw = err.read().decode("utf-8", "replace")
        try:
            parsed = json.loads(raw) if raw else None
        except Exception:
            parsed = raw
        return err.code, parsed


async def http_json(
    method: str,
    url: str,
    headers: Optional[Dict[str, str]] = None,
    body: Optional[Dict[str, Any]] = None,
    timeout: float = 15.0,
) -> Tuple[int, Any]:
    if _httpx is not None:
        async with _httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.request(method, url, headers=headers, json=body)
            try:
                payload = resp.json()
            except Exception:
                payload = resp.text
            return resp.status_code, payload
    return await asyncio.to_thread(_urllib_json_sync, method, url, headers or {}, body, timeout)


def _urllib_upload_sync(
    url: str,
    field_name: str,
    filename: str,
    data: bytes,
    content_type: str,
    headers: Dict[str, str],
    timeout: float,
) -> Tuple[int, Any]:
    boundary = f"----ChlorIMBoundary{uuid.uuid4().hex}"
    safe_name = filename.replace('"', "_").replace("\r", "_").replace("\n", "_")
    head = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="{field_name}"; filename="{safe_name}"\r\n'
        f"Content-Type: {content_type}\r\n\r\n"
    ).encode("utf-8")
    tail = f"\r\n--{boundary}--\r\n".encode("utf-8")
    body = head + data + tail
    req_headers = {
        **headers,
        "Content-Type": f"multipart/form-data; boundary={boundary}",
        "Content-Length": str(len(body)),
    }
    request = urllib.request.Request(url, data=body, headers=req_headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as err:
        raw = err.read().decode("utf-8", "replace")
        try:
            parsed = json.loads(raw) if raw else None
        except Exception:
            parsed = raw
        return err.code, parsed


async def http_upload(
    url: str,
    field_name: str,
    filename: str,
    data: bytes,
    content_type: Optional[str] = None,
    headers: Optional[Dict[str, str]] = None,
    timeout: float = 30.0,
) -> Tuple[int, Any]:
    mime = content_type or mimetypes.guess_type(filename)[0] or "application/octet-stream"
    if _httpx is not None:
        async with _httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(url, headers=headers, files={field_name: (filename, data, mime)})
            try:
                payload = resp.json()
            except Exception:
                payload = resp.text
            return resp.status_code, payload
    return await asyncio.to_thread(_urllib_upload_sync, url, field_name, filename, data, mime, headers or {}, timeout)
