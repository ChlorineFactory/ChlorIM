"""Hermes Agent native Gateway platform adapter for ChlorIM.

Install into ``~/.hermes/plugins/chlorim/`` and enable with:
    hermes plugins enable chlorim

Environment variables:
    CHLORIM_URL           ChlorIM server base URL (http(s):// or ws(s)://)
    CHLORIM_BOT_TOKEN     Bridge Bot token (chior_bot_...) created in ChlorIM Settings -> Bots
    CHLORIM_HOME_CHANNEL  Optional default channel ID for Hermes Cron delivery (deliver=chlorim)
    CHLORIM_CWD           Optional default working directory reported to ChlorIM
    CHLORIM_ALLOWED_ROOTS Optional comma-separated list of folders browsable from ChlorIM UI
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
import inspect
import json
import logging
import os
import socket
from typing import Any, Callable, Dict, List, Optional, Tuple
import urllib.parse

try:
    from .ws_client import WebSocketClosed, http_json, open_websocket
except ImportError:
    from ws_client import WebSocketClosed, http_json, open_websocket  # type: ignore[no-redef]

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Hermes Gateway imports (with graceful fallback for standalone testing)
# ---------------------------------------------------------------------------

try:
    from gateway.platforms.base import BasePlatformAdapter, SendResult  # type: ignore[import-not-found]
except ImportError:
    @dataclass
    class SendResult:  # type: ignore[no-redef]
        success: bool
        message_id: Optional[str] = None
        error: Optional[str] = None
        delivery_uncertain: bool = False

    class BasePlatformAdapter:  # type: ignore[no-redef]
        def __init__(self, config: Any, platform: Any = None) -> None:
            self.config = config
            self.platform = platform
            self._connected = False
            self._message_handler: Optional[Callable[[Any], Any]] = None

        def _mark_connected(self) -> None:
            self._connected = True

        def _mark_disconnected(self) -> None:
            self._connected = False

        def set_message_handler(self, handler: Callable[[Any], Any]) -> None:
            self._message_handler = handler

        async def handle_message(self, event: Any) -> Any:
            if self._message_handler:
                return await self._message_handler(event)
            return None

        def build_source(self, **kwargs: Any) -> Any:
            return SessionSource(**kwargs)


try:
    from gateway.config import Platform, PlatformConfig  # type: ignore[import-not-found]
except ImportError:
    class Platform(str):  # type: ignore[no-redef]
        pass

    @dataclass
    class PlatformConfig:  # type: ignore[no-redef]
        enabled: bool = True
        token: Optional[str] = None
        home_channel: Optional[str] = None
        extra: Dict[str, Any] = field(default_factory=dict)


try:
    from gateway.platforms.event import MessageEvent, MessageType  # type: ignore[import-not-found]
except ImportError:
    class MessageType(str):  # type: ignore[no-redef]
        TEXT = "text"

    @dataclass
    class MessageEvent:  # type: ignore[no-redef]
        text: str
        source: Any
        message_id: Optional[str] = None
        message_type: Any = MessageType.TEXT
        reply_to_message_id: Optional[str] = None
        raw_message: Optional[Dict[str, Any]] = None


try:
    from gateway.session import SessionSource  # type: ignore[import-not-found]
except ImportError:
    @dataclass
    class SessionSource:  # type: ignore[no-redef]
        platform: Any = "chlorim"
        chat_id: str = ""
        chat_type: str = "group"
        user_id: Optional[str] = None
        user_name: Optional[str] = None
        chat_name: Optional[str] = None
        thread_id: Optional[str] = None


try:
    from agent.secret_scope import get_secret  # type: ignore[import-not-found]
except ImportError:
    def get_secret(name: str, default: Optional[str] = None) -> Optional[str]:  # type: ignore[no-redef]
        return os.environ.get(name, default)


SKIP_DIRS = {".git", "node_modules", ".pnpm-store", ".svelte-kit", "__pycache__", ".DS_Store", ".Trash"}


def _env_or_extra(config: Any, key: str, extra_key: Optional[str] = None) -> str:
    extra = getattr(config, "extra", None) or {}
    for candidate in filter(None, [extra_key, key, key.lower()]):
        val = extra.get(candidate)
        if isinstance(val, str) and val.strip():
            return val.strip()
    secret = get_secret(key)
    if isinstance(secret, str) and secret.strip():
        return secret.strip()
    return os.environ.get(key, "").strip()


def _normalize_urls(raw_url: str) -> Tuple[str, str]:
    """Return ``(http_base_url, ws_bridge_url)`` from any http(s):// or ws(s):// URL."""
    cleaned = raw_url.strip().rstrip("/")
    parsed = urllib.parse.urlparse(cleaned)
    if parsed.scheme in ("ws", "wss"):
        http_scheme = "https" if parsed.scheme == "wss" else "http"
        base_path = parsed.path[:-10] if parsed.path.endswith("/ws/bridge") else parsed.path
        http_base = urllib.parse.urlunparse((http_scheme, parsed.netloc, base_path.rstrip("/"), "", "", ""))
        ws_path = parsed.path if parsed.path.endswith("/ws/bridge") else f"{base_path.rstrip('/')}/ws/bridge"
        ws_url = urllib.parse.urlunparse((parsed.scheme, parsed.netloc, ws_path, "", "", ""))
        return http_base, ws_url
    if parsed.scheme in ("http", "https"):
        ws_scheme = "wss" if parsed.scheme == "https" else "ws"
        http_base = cleaned
        ws_url = urllib.parse.urlunparse((ws_scheme, parsed.netloc, f"{parsed.path.rstrip('/')}/ws/bridge", "", "", ""))
        return http_base, ws_url
    raise ValueError(f"CHLORIM_URL must start with http://, https://, ws://, or wss:// (got {raw_url!r})")


def _expand_roots(cwd: str, raw_roots: str) -> List[str]:
    candidates = [item.strip() for item in raw_roots.split(",") if item.strip()] if raw_roots else [cwd]
    resolved: List[str] = []
    seen = set()
    for item in candidates:
        path = os.path.realpath(os.path.expanduser(item))
        if os.path.isdir(path) and path not in seen:
            seen.add(path)
            resolved.append(path)
    return resolved


def _is_within_roots(target_real: str, roots: List[str]) -> bool:
    for root in roots:
        try:
            rel = os.path.relpath(target_real, root)
        except ValueError:
            continue
        if rel == "." or (not rel.startswith("..") and not os.path.isabs(rel)):
            return True
    return False


@dataclass
class _ActiveRun:
    run_id: str
    message_id: str
    channel_id: str
    thread_root_id: Optional[str]
    scope_key: str
    task: Optional[asyncio.Task[Any]] = None
    emitted: str = ""
    finished: bool = False


class ChlorIMAdapter(BasePlatformAdapter):
    """Native Hermes Gateway platform adapter connecting directly to ChlorIM."""

    PLATFORM_NAME = "chlorim"

    def __init__(self, config: Any) -> None:
        platform = self._resolve_platform_enum()
        try:
            super().__init__(config, platform)
        except TypeError:
            super().__init__(config)  # type: ignore[call-arg]

        raw_url = _env_or_extra(config, "CHLORIM_URL", "url")
        token = getattr(config, "token", None) or _env_or_extra(config, "CHLORIM_BOT_TOKEN", "token")
        if not raw_url:
            raise ValueError("CHLORIM_URL is required for the ChlorIM platform adapter")
        if not token:
            raise ValueError("CHLORIM_BOT_TOKEN is required for the ChlorIM platform adapter")

        self.http_base, self.ws_url = _normalize_urls(raw_url)
        self.token = token.strip()
        self.cwd = os.path.realpath(os.path.expanduser(_env_or_extra(config, "CHLORIM_CWD", "cwd") or os.getcwd()))
        self.allowed_roots = _expand_roots(self.cwd, _env_or_extra(config, "CHLORIM_ALLOWED_ROOTS", "allowed_roots"))
        self.hostname = socket.gethostname()[:255]

        self._ws: Any = None
        self._stop = asyncio.Event()
        self._loop_task: Optional[asyncio.Task[Any]] = None
        self._ready_event = asyncio.Event()
        self._bot_id: Optional[str] = None
        self._bot_username: Optional[str] = None
        self._channels_cache: Dict[str, Dict[str, Any]] = {}

        # Active ChlorIM run.start turns indexed by (channel_id, thread_root_id), message_id, and run_id
        self._runs_by_scope: Dict[Tuple[str, Optional[str]], _ActiveRun] = {}
        self._runs_by_message: Dict[str, _ActiveRun] = {}
        self._runs_by_id: Dict[str, _ActiveRun] = {}

    @classmethod
    def _resolve_platform_enum(cls) -> Any:
        try:
            return Platform(cls.PLATFORM_NAME)
        except Exception:
            return cls.PLATFORM_NAME

    @property
    def _auth_headers(self) -> Dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"}

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        self._stop.clear()
        self._ready_event.clear()
        if self._loop_task and not self._loop_task.done():
            self._loop_task.cancel()
        self._loop_task = asyncio.create_task(self._connection_loop(), name="chlorim-ws-loop")
        try:
            await asyncio.wait_for(self._ready_event.wait(), timeout=12.0)
            self._mark_connected()
            return True
        except asyncio.TimeoutError:
            logger.warning("ChlorIM adapter connect timed out; background reconnect continues")
            return False

    async def disconnect(self) -> None:
        self._stop.set()
        for run in list(self._runs_by_id.values()):
            if run.task and not run.task.done():
                run.task.cancel()
        self._runs_by_scope.clear()
        self._runs_by_message.clear()
        self._runs_by_id.clear()
        if self._ws is not None:
            await self._ws.close(1000, "Hermes gateway shutting down")
            self._ws = None
        if self._loop_task and not self._loop_task.done():
            self._loop_task.cancel()
            try:
                await self._loop_task
            except asyncio.CancelledError:
                pass
        self._mark_disconnected()

    # ------------------------------------------------------------------
    # Outbound BasePlatformAdapter methods
    # ------------------------------------------------------------------

    def format_message(self, content: str) -> str:
        # ChlorIM renders standard GitHub Flavored Markdown directly.
        return content

    async def send_typing(self, chat_id: str, metadata: Optional[Dict[str, Any]] = None) -> None:
        # ChlorIM already displays a live streaming indicator while a run is active.
        return None

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        cached = self._channels_cache.get(chat_id)
        if cached:
            return dict(cached)
        status, payload = await http_json("GET", f"{self.http_base}/api/channels", headers=self._auth_headers)
        if status == 200 and isinstance(payload, list):
            for ch in payload:
                if isinstance(ch, dict) and ch.get("id"):
                    self._channels_cache[ch["id"]] = ch
            if chat_id in self._channels_cache:
                return dict(self._channels_cache[chat_id])
        return {"id": chat_id, "name": chat_id, "type": "group"}

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        meta = metadata or {}
        thread_id = meta.get("thread_id") or meta.get("thread_root_id")
        active = self._runs_by_scope.get((chat_id, thread_id))
        if active is None and thread_id is None:
            # Match any open run in this chat if caller omitted thread metadata.
            for candidate in self._runs_by_scope.values():
                if candidate.channel_id == chat_id and not candidate.finished:
                    active = candidate
                    break

        if active is not None and not active.finished and self._ws is not None:
            if content:
                delta = content[len(active.emitted):] if content.startswith(active.emitted) else (
                    ("\n\n" if active.emitted else "") + content
                )
                if delta:
                    await self._send_ws_delta(active.run_id, delta)
                    active.emitted += delta
            return SendResult(success=True, message_id=active.message_id)

        # Proactive / Cron / Follow-up message -> ChlorIM Bot REST API
        body: Dict[str, Any] = {"content": content}
        if thread_id:
            body["thread_root_id"] = thread_id
        if reply_to:
            body["reply_to_id"] = reply_to
        status, payload = await http_json(
            "POST",
            f"{self.http_base}/api/channels/{urllib.parse.quote(chat_id, safe='')}/messages",
            headers=self._auth_headers,
            body=body,
        )
        if 200 <= status < 300 and isinstance(payload, dict):
            return SendResult(success=True, message_id=str(payload.get("id", "")))
        err = payload.get("error", {}).get("message") if isinstance(payload, dict) else str(payload)
        return SendResult(success=False, error=f"HTTP {status}: {err}")

    async def edit_message(
        self,
        chat_id: str,
        message_id: str,
        content: str,
        *,
        finalize: bool = False,
    ) -> SendResult:
        active = self._runs_by_message.get(message_id)
        if active is not None and not active.finished and self._ws is not None:
            if content.startswith(active.emitted):
                delta = content[len(active.emitted):]
                if delta:
                    await self._send_ws_delta(active.run_id, delta)
                    active.emitted = content
            elif content and content != active.emitted:
                # Non-monotonic edit (e.g. replacing a placeholder); emit clean delta or patch on finalize.
                if not active.emitted:
                    await self._send_ws_delta(active.run_id, content)
                    active.emitted = content
                else:
                    await self._finish_run(active, content_override=content)
                    return SendResult(success=True, message_id=message_id)

            if finalize:
                await self._finish_run(active)
            return SendResult(success=True, message_id=message_id)

        # Fallback: edit a previously sent REST message directly
        status, payload = await http_json(
            "PATCH",
            f"{self.http_base}/api/messages/{urllib.parse.quote(message_id, safe='')}",
            headers=self._auth_headers,
            body={"content": content},
        )
        if 200 <= status < 300:
            return SendResult(success=True, message_id=message_id)
        err = payload.get("error", {}).get("message") if isinstance(payload, dict) else str(payload)
        return SendResult(success=False, error=f"HTTP {status}: {err}")

    # ------------------------------------------------------------------
    # WebSocket loop & ChlorIM Bridge protocol handling
    # ------------------------------------------------------------------

    async def _ws_send(self, frame: Dict[str, Any]) -> None:
        if self._ws is None:
            return
        await self._ws.send(json.dumps(frame))

    async def _send_ws_delta(self, run_id: str, text: str) -> None:
        chunk_size = 64_000
        for offset in range(0, len(text), chunk_size):
            await self._ws_send({
                "type": "run.delta",
                "run_id": run_id,
                "part": "text",
                "delta": text[offset:offset + chunk_size],
            })

    async def _finish_run(
        self,
        run: _ActiveRun,
        *,
        error: Optional[str] = None,
        content_override: Optional[str] = None,
    ) -> None:
        if run.finished:
            return
        run.finished = True
        self._runs_by_scope.pop((run.channel_id, run.thread_root_id), None)
        self._runs_by_message.pop(run.message_id, None)
        self._runs_by_id.pop(run.run_id, None)
        if error:
            await self._ws_send({"type": "run.error", "run_id": run.run_id, "error": error[:4000]})
            return
        await self._ws_send({"type": "run.done", "run_id": run.run_id, "external_session_id": run.scope_key})
        if content_override is not None:
            await http_json(
                "PATCH",
                f"{self.http_base}/api/messages/{urllib.parse.quote(run.message_id, safe='')}",
                headers=self._auth_headers,
                body={"content": content_override},
            )

    async def _connection_loop(self) -> None:
        attempt = 0
        while not self._stop.is_set():
            try:
                ws = await open_websocket(self.ws_url, headers=self._auth_headers, timeout=10.0)
                self._ws = ws
                attempt = 0
                await self._receive_loop(ws)
            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.warning("ChlorIM WebSocket disconnected: %s", exc)
            finally:
                if self._ws is not None:
                    await self._ws.close()
                    self._ws = None
                self._mark_disconnected()

            if self._stop.is_set():
                break
            delay = min(30.0, 0.5 * (2 ** min(attempt, 6)))
            attempt += 1
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=delay)
            except asyncio.TimeoutError:
                pass

    async def _receive_loop(self, ws: Any) -> None:
        while not self._stop.is_set():
            try:
                raw = await ws.recv()
            except WebSocketClosed:
                return
            event = json.loads(raw)
            kind = event.get("type")
            if kind == "bridge.welcome":
                self._bot_id = event.get("bot_id")
                self._bot_username = event.get("username")
                await self._ws_send({
                    "type": "bridge.hello",
                    "hostname": self.hostname,
                    "driver": "hermes",
                    "cwd": self.cwd,
                    "allowed_roots": self.allowed_roots,
                    "version": "0.3.0",
                })
                self._mark_connected()
                self._ready_event.set()
            elif kind == "ping":
                await self._ws_send({"type": "pong"})
            elif kind == "fs.list":
                await self._handle_fs_list(event.get("request_id", ""), event.get("path"))
            elif kind == "run.start":
                self._spawn_run(event)
            elif kind == "run.abort":
                run = self._runs_by_id.get(event.get("run_id", ""))
                if run and run.task and not run.task.done():
                    run.task.cancel()

    async def _handle_fs_list(self, request_id: str, requested_path: Optional[str]) -> None:
        try:
            roots = self.allowed_roots or [self.cwd]
            if not requested_path or not requested_path.strip():
                entries = [
                    {"name": os.path.basename(root) or root, "path": root, "kind": "dir"}
                    for root in roots
                ]
                await self._ws_send({
                    "type": "fs.list.result",
                    "request_id": request_id,
                    "path": "",
                    "parent": None,
                    "entries": entries,
                })
                return

            candidate = os.path.expanduser(requested_path.strip())
            if not os.path.isdir(candidate):
                raise ValueError(f'Directory "{requested_path}" does not exist on this device')
            dir_real = os.path.realpath(candidate)
            if not _is_within_roots(dir_real, roots):
                raise ValueError(f'Path "{requested_path}" is outside CHLORIM_ALLOWED_ROOTS')

            entries = []
            for entry in os.scandir(dir_real):
                if entry.name in SKIP_DIRS or entry.name.startswith("."):
                    continue
                try:
                    real = os.path.realpath(entry.path)
                    if _is_within_roots(real, roots) and os.path.isdir(real):
                        entries.append({"name": entry.name, "path": real, "kind": "dir"})
                except OSError:
                    continue
                if len(entries) >= 200:
                    break
            entries.sort(key=lambda item: item["name"].lower())

            up = os.path.dirname(dir_real)
            if up != dir_real and _is_within_roots(up, roots):
                parent: Optional[str] = up
            elif len(roots) > 1:
                parent = ""
            else:
                parent = None

            await self._ws_send({
                "type": "fs.list.result",
                "request_id": request_id,
                "path": dir_real,
                "parent": parent,
                "entries": entries,
            })
        except Exception as exc:
            await self._ws_send({
                "type": "fs.list.result",
                "request_id": request_id,
                "path": requested_path or "",
                "parent": None,
                "entries": [],
                "error": str(exc)[:1000],
            })

    def _spawn_run(self, event: Dict[str, Any]) -> None:
        run_id = str(event["run_id"])
        message_id = str(event["message_id"])
        channel_id = str(event["channel_id"])
        thread_root_id = event.get("thread_root_id")
        scope_key = str(event.get("scope_key") or f"channel:{channel_id}")

        run = _ActiveRun(
            run_id=run_id,
            message_id=message_id,
            channel_id=channel_id,
            thread_root_id=thread_root_id,
            scope_key=scope_key,
        )
        self._runs_by_scope[(channel_id, thread_root_id)] = run
        self._runs_by_message[message_id] = run
        self._runs_by_id[run_id] = run
        run.task = asyncio.create_task(self._execute_run(run, event), name=f"chlorim-run-{run_id[:8]}")

    async def _execute_run(self, run: _ActiveRun, event: Dict[str, Any]) -> None:
        try:
            chat_info = await self.get_chat_info(run.channel_id)
            chat_type = "dm" if chat_info.get("type") == "dm" else "group"
            chat_name = chat_info.get("name") or run.channel_id
            sender = event.get("sender") or {}
            prompt = str(event.get("prompt") or "")
            work_dir = event.get("work_dir")
            if work_dir:
                prompt = f"[ChlorIM Workspace Directory: {work_dir}]\n{prompt}"

            source = self._make_source(
                chat_id=run.channel_id,
                chat_type=chat_type,
                chat_name=chat_name,
                user_id=str(sender.get("id") or ""),
                user_name=str(sender.get("display_name") or sender.get("username") or "user"),
                thread_id=run.thread_root_id,
            )
            msg_event = self._make_event(
                text=prompt,
                source=source,
                message_id=run.message_id,
                raw_message=event,
            )
            result = await self.handle_message(msg_event)
            if isinstance(result, str) and result and not run.emitted and not run.finished:
                await self.send(run.channel_id, result, metadata={"thread_id": run.thread_root_id})
            if not run.finished:
                await self._finish_run(run)
        except asyncio.CancelledError:
            run.finished = True
            self._runs_by_scope.pop((run.channel_id, run.thread_root_id), None)
            self._runs_by_message.pop(run.message_id, None)
            self._runs_by_id.pop(run.run_id, None)
        except Exception as exc:
            logger.exception("Error processing ChlorIM run %s", run.run_id)
            await self._finish_run(run, error=str(exc) or "Hermes agent error")

    def _make_source(self, **kwargs: Any) -> Any:
        platform = self._resolve_platform_enum()
        if hasattr(self, "build_source"):
            sig = inspect.signature(self.build_source)
            accepted = {k: v for k, v in kwargs.items() if k in sig.parameters or any(
                p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values()
            )}
            if "platform" in sig.parameters:
                accepted.setdefault("platform", platform)
            return self.build_source(**accepted)
        sig = inspect.signature(SessionSource)
        accepted = {k: v for k, v in kwargs.items() if k in sig.parameters}
        if "platform" in sig.parameters:
            accepted.setdefault("platform", platform)
        return SessionSource(**accepted)

    def _make_event(self, *, text: str, source: Any, message_id: str, raw_message: Dict[str, Any]) -> Any:
        sig = inspect.signature(MessageEvent)
        params = sig.parameters
        kwargs: Dict[str, Any] = {"text": text, "source": source}
        if "message_id" in params:
            kwargs["message_id"] = message_id
        if "message_type" in params:
            kwargs["message_type"] = getattr(MessageType, "TEXT", "text")
        if "raw_message" in params:
            kwargs["raw_message"] = raw_message
        return MessageEvent(**kwargs)


# ---------------------------------------------------------------------------
# Hermes Plugin Loader Hooks
# ---------------------------------------------------------------------------

def check_requirements(config: Any = None) -> bool:
    url = _env_or_extra(config, "CHLORIM_URL", "url") if config is not None else (get_secret("CHLORIM_URL") or os.environ.get("CHLORIM_URL", ""))
    token = _env_or_extra(config, "CHLORIM_BOT_TOKEN", "token") if config is not None else (get_secret("CHLORIM_BOT_TOKEN") or os.environ.get("CHLORIM_BOT_TOKEN", ""))
    return bool(url.strip() and token.strip())


def _env_enablement() -> Optional[Dict[str, Any]]:
    url = (get_secret("CHLORIM_URL") or os.environ.get("CHLORIM_URL", "")).strip()
    token = (get_secret("CHLORIM_BOT_TOKEN") or os.environ.get("CHLORIM_BOT_TOKEN", "")).strip()
    if not (url and token):
        return None
    extra: Dict[str, Any] = {"url": url, "token": token}
    home = (get_secret("CHLORIM_HOME_CHANNEL") or os.environ.get("CHLORIM_HOME_CHANNEL", "")).strip()
    if home:
        extra["home_channel"] = home
    cwd = (get_secret("CHLORIM_CWD") or os.environ.get("CHLORIM_CWD", "")).strip()
    if cwd:
        extra["cwd"] = cwd
    roots = (get_secret("CHLORIM_ALLOWED_ROOTS") or os.environ.get("CHLORIM_ALLOWED_ROOTS", "")).strip()
    if roots:
        extra["allowed_roots"] = roots
    return extra


def register(ctx: Any) -> None:
    """Entry point discovered by Hermes Agent's plugin loader."""
    candidate_kwargs: Dict[str, Any] = {
        "name": "chlorim",
        "label": "ChlorIM",
        "adapter_factory": lambda cfg: ChlorIMAdapter(cfg),
        "check_fn": check_requirements,
        "required_env": ["CHLORIM_URL", "CHLORIM_BOT_TOKEN"],
        "env_enablement_fn": _env_enablement,
        "cron_deliver_env_var": "CHLORIM_HOME_CHANNEL",
        "emoji": "🌲",
        "dashboard_description": "Connect Hermes Gateway directly to ChlorIM channels, threads, and folder workspaces.",
        "platform_hint": (
            "You are chatting via ChlorIM (Markdown + code blocks supported). "
            "When a message includes [ChlorIM Workspace Directory: <path>], operate relative to that project folder."
        ),
    }
    sig = inspect.signature(ctx.register_platform)
    has_var_kw = any(p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values())
    filtered = candidate_kwargs if has_var_kw else {k: v for k, v in candidate_kwargs.items() if k in sig.parameters}
    ctx.register_platform(**filtered)
