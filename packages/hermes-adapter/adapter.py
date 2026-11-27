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
import mimetypes
import os
import re
import socket
import time
from typing import Any, Callable, Dict, List, Optional, Set, Tuple
import urllib.parse
import uuid

try:
    from .ws_client import WebSocketClosed, http_json, http_upload, open_websocket
except ImportError:
    from ws_client import WebSocketClosed, http_json, http_upload, open_websocket  # type: ignore[no-redef]

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
        COMMAND = "command"

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


_TOOL_LINE_RE = re.compile(
    r"^(?:[\U0001F300-\U0001FAFF\u2600-\u27BF]\ufe0f?\s+)(.+)$"
)
_TOOL_PREFIX_EMOJIS = (
    "💻", "⚙️", "⚙", "📚", "⏰", "🐍", "🔍", "🔎", "📄", "📝",
    "🌐", "🛠️", "🛠", "🔧", "📦", "⚡", "🗂️", "🗂", "📁", "🧪", "📊", "📡", "🤖", "🧠",
)
_CLARIFY_OPTION_RE = re.compile(r"^\s*(\d+)[\.\)）、]\s+(.+?)\s*$")


def _classify_tool_line(line: str) -> Optional[Tuple[str, str]]:
    """Return ``(tool_name, summary)`` if ``line`` looks like a Hermes tool progress line."""
    stripped = line.strip()
    if not stripped:
        return None
    # Strip optional leading quote / emphasis markers Hermes or Markdown wrappers may add.
    unwrapped = re.sub(r"^[>\s*_`]+", "", stripped)
    unwrapped = re.sub(r"[*_`]+$", "", unwrapped).strip()
    if not unwrapped or not any(unwrapped.startswith(prefix) for prefix in _TOOL_PREFIX_EMOJIS):
        return None
    match = _TOOL_LINE_RE.match(unwrapped)
    body = match.group(1).strip() if match else unwrapped
    body = re.sub(r"^[*_`]+|[*_`]+$", "", body).strip()
    if not body:
        return None
    if ":" in body[:36]:
        head, rest = body.split(":", 1)
        if re.fullmatch(r"[A-Za-z0-9_.\-/ ]{1,36}", head.strip()):
            return head.strip()[:80], rest.strip() or body
    words = body.split(None, 2)
    if len(words) >= 2 and words[0].lower() in (
        "running", "reading", "searching", "scheduling", "executing", "calling",
        "writing", "editing", "fetching", "updating", "creating", "deleting", "removing",
    ):
        name = f"{words[0]} {words[1]}" if words[1].lower() in ("skill", "code", "tool", "command", "memory") else words[0]
        return name[:80], body
    return body[:64], body


def _parse_interactive_prompt(text: str) -> Optional[Dict[str, Any]]:
    """Detect Hermes plain-text clarify or exec-approval prompts and convert to a structured prompt block."""
    cleaned = text.strip()
    if not cleaned:
        return None
    lines = [line.rstrip() for line in cleaned.splitlines()]

    # 1. Hermes clarify prompt (e.g. "❓ ...\n1. Option A\n2. Option B\nReply with the number...")
    options: List[Dict[str, Any]] = []
    title_lines: List[str] = []
    has_skip_hint = False
    has_reply_hint = False
    for line in lines:
        s = line.strip()
        if not s:
            continue
        if re.search(r'reply\s+"?skip"?\s+to\s+skip', s, re.I):
            has_skip_hint = True
            continue
        if re.search(r"reply\s+with\s+the\s+number|reply\s+with\s+your\s+answer", s, re.I):
            has_reply_hint = True
            continue
        opt_match = _CLARIFY_OPTION_RE.match(s)
        if opt_match:
            num, label = opt_match.group(1), opt_match.group(2).strip()
            style = "primary" if re.search(r"\(recommended\)|推荐", label, re.I) else "default"
            options.append({"label": label[:200], "value": num, "style": style})
            continue
        if not options:
            title_lines.append(s)

    if options and (has_reply_hint or has_skip_hint or cleaned.startswith("❓") or cleaned.startswith("?")):
        title = "\n".join(title_lines).lstrip("❓? ").strip() or "请选择一项"
        if has_skip_hint and not any(opt["value"].lower() == "skip" or opt["label"] in ("跳过", "Skip") for opt in options):
            options.append({"label": "跳过", "value": "skip", "style": "default"})
        return {
            "id": f"clarify-{uuid.uuid4().hex[:10]}",
            "kind": "choice",
            "title": title[:2000],
            "options": options[:20],
            "allow_custom": True,
        }

    # 2. Hermes plain-text dangerous-command approval fallback
    if re.search(r"(?:approval\s+required|dangerous\s+command|confirm\s+execution|需要.*审批|危险命令)", cleaned, re.I) and re.search(
        r"\b(?:allow|approve|once|deny)\b|允许|拒绝", cleaned, re.I
    ):
        return {
            "id": f"approval-{uuid.uuid4().hex[:10]}",
            "kind": "approval",
            "title": "需要执行权限确认",
            "description": cleaned[:4000],
            "options": [
                {"label": "允许本次", "value": "once", "style": "primary"},
                {"label": "本次会话允许", "value": "session", "style": "default"},
                {"label": "始终允许", "value": "always", "style": "default"},
                {"label": "拒绝", "value": "deny", "style": "danger"},
            ],
            "allow_custom": False,
        }

    return None


@dataclass
class _RunPart:
    id: str
    text: str = ""
    deleted: bool = False


@dataclass
class _ActiveRun:
    run_id: str
    message_id: str
    channel_id: str
    thread_root_id: Optional[str]
    scope_key: str
    task: Optional[asyncio.Task[Any]] = None
    emitted: str = ""
    raw_seen: str = ""
    finished: bool = False
    handler_started: asyncio.Event = field(default_factory=asyncio.Event)
    done_event: asyncio.Event = field(default_factory=asyncio.Event)
    tool_seq: int = 0
    active_tool: Optional[Dict[str, Any]] = None
    seen_tool_lines: Set[str] = field(default_factory=set)
    seen_prompts: Set[str] = field(default_factory=set)
    pending_prompts: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    part_seq: int = 0
    parts: List[_RunPart] = field(default_factory=list)
    parts_by_id: Dict[str, _RunPart] = field(default_factory=dict)
    needs_patch: bool = False
    last_activity: float = field(default_factory=time.monotonic)

    def touch(self) -> None:
        self.last_activity = time.monotonic()

    def joined_prose(self) -> str:
        return "\n\n".join(part.text for part in self.parts if not part.deleted and part.text)

    @property
    def has_output(self) -> bool:
        return bool(self.emitted or self.joined_prose() or self.tool_seq or self.pending_prompts)


class ChlorIMAdapter(BasePlatformAdapter):
    """Native Hermes Gateway platform adapter connecting directly to ChlorIM."""

    PLATFORM_NAME = "chlorim"
    MAX_MESSAGE_LENGTH = 100_000

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

        # Active ChlorIM run.start turns indexed by (channel_id, thread_root_id), message_id, virtual part_id, and run_id
        self._runs_by_scope: Dict[Tuple[str, Optional[str]], _ActiveRun] = {}
        self._runs_by_message: Dict[str, _ActiveRun] = {}
        self._runs_by_id: Dict[str, _ActiveRun] = {}
        self._part_to_run: Dict[str, _ActiveRun] = {}

    @property
    def _message_handler(self) -> Optional[Callable[[Any], Any]]:
        return getattr(self, "_wrapped_message_handler", None)

    @_message_handler.setter
    def _message_handler(self, handler: Optional[Callable[[Any], Any]]) -> None:
        if handler is None or getattr(handler, "_chlorim_wrapped", False):
            self._wrapped_message_handler = handler
            return
        self._wrapped_message_handler = self._wrap_message_handler(handler)

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
        self._part_to_run.clear()
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

    def _find_run_for_event(self, event: Any) -> Optional[_ActiveRun]:
        msg_id = getattr(event, "message_id", None)
        if isinstance(msg_id, str):
            if msg_id.startswith("input:"):
                return None
            if msg_id in self._runs_by_message:
                return self._runs_by_message[msg_id]
            if msg_id in self._part_to_run:
                return self._part_to_run[msg_id]
        source = getattr(event, "source", None)
        chat_id = getattr(source, "chat_id", None)
        thread_id = getattr(source, "thread_id", None)
        if isinstance(chat_id, str):
            run = self._runs_by_scope.get((chat_id, thread_id))
            if run is not None and not run.finished:
                return run
            for candidate in self._runs_by_scope.values():
                if candidate.channel_id == chat_id and not candidate.finished:
                    return candidate
        active_runs = [candidate for candidate in self._runs_by_id.values() if not candidate.finished]
        if len(active_runs) == 1:
            return active_runs[0]
        return None

    def _wrap_message_handler(self, handler: Callable[[Any], Any]) -> Callable[[Any], Any]:
        async def _tracked_handler(event: Any) -> Any:
            run = self._find_run_for_event(event)
            if run is not None:
                run.handler_started.set()
                run.touch()
            try:
                result = await handler(event)
            except asyncio.CancelledError:
                if run is not None and not run.finished:
                    run.finished = True
                    run.done_event.set()
                    self._cleanup_run(run)
                raise
            except Exception as exc:
                logger.exception("Hermes message handler failed for ChlorIM event")
                if run is not None and not run.finished:
                    await self._finish_run(run, error=str(exc) or "Hermes agent error")
                raise

            if run is not None and not run.finished:
                if isinstance(result, str) and result.strip():
                    current_prose = run.joined_prose().strip() or run.emitted.strip()
                    if result.strip() != current_prose:
                        await self._emit_structured_content(run, result)
                if run.has_output:
                    final_prose = run.joined_prose()
                    override = final_prose if (run.needs_patch and final_prose and final_prose != run.emitted) else None
                    await self._finish_run(run, content_override=override)
                    # Return None so Hermes BasePlatformAdapter does not post a duplicate REST copy.
                    return None
                # Handler returned nothing and emitted no deltas (e.g. unauthorized user dropped by Hermes).
                await self._finish_run(
                    run,
                    error="Hermes 未返回内容（请检查 ~/.hermes/.env 是否已设置 CHLORIM_ALLOW_ALL_USERS=true 或 CHLORIM_ALLOWED_USERS，并查看 hermes gateway 日志）",
                )
                return None
            return result

        setattr(_tracked_handler, "_chlorim_wrapped", True)
        return _tracked_handler

    def set_message_handler(self, handler: Callable[[Any], Any]) -> None:
        wrapped = self._wrap_message_handler(handler) if not getattr(handler, "_chlorim_wrapped", False) else handler
        super().set_message_handler(wrapped)

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

    def _lookup_active_run(self, chat_id: str, thread_id: Optional[str] = None) -> Optional[_ActiveRun]:
        active = self._runs_by_scope.get((chat_id, thread_id))
        if active is None and thread_id is None:
            for candidate in self._runs_by_scope.values():
                if candidate.channel_id == chat_id and not candidate.finished:
                    active = candidate
                    break
        return active if active is not None and not active.finished else None

    async def _close_active_tool(self, run: _ActiveRun, status: str = "done") -> None:
        if run.active_tool is None:
            return
        finished = {**run.active_tool, "status": status}
        run.active_tool = None
        await self._ws_send({
            "type": "run.delta",
            "run_id": run.run_id,
            "part": "tool_end",
            "tool": finished,
        })

    def _alloc_part(self, run: _ActiveRun) -> _RunPart:
        run.part_seq += 1
        part = _RunPart(id=f"{run.message_id}:p{run.part_seq}")
        run.parts.append(part)
        run.parts_by_id[part.id] = part
        self._part_to_run[part.id] = run
        return part

    async def _emit_tool_line(self, run: _ActiveRun, line: str, name: str, detail: str) -> None:
        run.touch()
        if line in run.seen_tool_lines:
            return
        run.seen_tool_lines.add(line)
        await self._close_active_tool(run, "done")
        run.tool_seq += 1
        tool = {
            "id": f"hermes-tool-{run.tool_seq}",
            "name": name,
            "input": detail,
            "status": "running",
        }
        run.active_tool = tool
        await self._ws_send({
            "type": "run.delta",
            "run_id": run.run_id,
            "part": "tool_start",
            "tool": tool,
        })

    async def _emit_prompt(self, run: _ActiveRun, prompt_block: Dict[str, Any], meta: Optional[Dict[str, Any]] = None) -> None:
        run.touch()
        await self._close_active_tool(run, "done")
        dedupe_key = f"{prompt_block.get('kind')}:{prompt_block.get('title')}:{len(prompt_block.get('options', []))}"
        if dedupe_key in run.seen_prompts:
            return
        run.seen_prompts.add(dedupe_key)
        run.pending_prompts[prompt_block["id"]] = meta or {"kind": prompt_block.get("kind")}
        await self._ws_send({
            "type": "run.delta",
            "run_id": run.run_id,
            "part": "prompt",
            "prompt": prompt_block,
        })

    async def _emit_structured_content(
        self,
        run: _ActiveRun,
        content: str,
        *,
        part: Optional[_RunPart] = None,
    ) -> None:
        if not content:
            return
        run.touch()
        # 1. Check if the entire message is an interactive clarify / approval prompt.
        prompt_block = _parse_interactive_prompt(content)
        if prompt_block is not None:
            await self._emit_prompt(run, prompt_block)
            return

        # 2. Separate tool progress lines from real prose lines.
        prose_lines: List[str] = []
        tool_lines_seen = False
        for line in content.splitlines():
            classified = _classify_tool_line(line)
            if classified is not None:
                tool_lines_seen = True
                await self._emit_tool_line(run, line.strip(), classified[0], classified[1])
            else:
                prose_lines.append(line)

        prose = "\n".join(prose_lines).strip() if tool_lines_seen else content
        if not prose:
            return

        # Re-check prose in case tool lines preceded a clarify/approval block in the same payload.
        nested_prompt = _parse_interactive_prompt(prose)
        if nested_prompt is not None:
            await self._emit_prompt(run, nested_prompt)
            return

        await self._close_active_tool(run, "done")
        target = part if part is not None else self._alloc_part(run)

        if not target.text:
            target.text = prose
            if not run.needs_patch:
                chunk = prose if not run.emitted else ("\n\n" + prose)
                await self._send_ws_delta(run.run_id, chunk)
                run.emitted += chunk
            return

        if prose == target.text:
            return

        latest_prose = next((p for p in reversed(run.parts) if not p.deleted and p.text), None)
        if latest_prose is target and prose.startswith(target.text) and not run.needs_patch:
            delta = prose[len(target.text):]
            target.text = prose
            if delta:
                await self._send_ws_delta(run.run_id, delta)
                run.emitted += delta
        else:
            # Non-monotonic edit (e.g. rolling draft replacement) -> defer clean patch to run completion.
            target.text = prose
            run.needs_patch = True

    async def send_clarify(
        self,
        chat_id: str,
        question: str,
        choices: Optional[List[str]] = None,
        *,
        clarify_id: Optional[str] = None,
        session_key: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        **_kwargs: Any,
    ) -> SendResult:
        meta = metadata or {}
        thread_id = meta.get("thread_id") or meta.get("thread_root_id")
        active = self._lookup_active_run(chat_id, thread_id)
        options: List[Dict[str, Any]] = []
        for idx, choice in enumerate(choices or [], start=1):
            label = str(choice).strip()
            if not label:
                continue
            style = "primary" if re.search(r"\(recommended\)|推荐", label, re.I) else "default"
            options.append({"label": label[:200], "value": str(idx), "style": style})
        if not any(opt["value"].lower() == "skip" or opt["label"] in ("跳过", "Skip") for opt in options):
            options.append({"label": "跳过", "value": "skip", "style": "default"})
        pid = str(clarify_id or f"clarify-{uuid.uuid4().hex[:10]}")[:128]
        prompt_block = {
            "id": pid,
            "kind": "choice",
            "title": str(question).strip()[:2000] or "请选择一项",
            "options": options[:20],
            "allow_custom": True,
        }
        if active is not None and self._ws is not None:
            part = self._alloc_part(active)
            await self._emit_prompt(active, prompt_block, {"kind": "choice", "session_key": session_key, "clarify_id": clarify_id})
            return SendResult(success=True, message_id=part.id)
        return await self.send(chat_id, str(question), metadata=metadata)

    async def send_exec_approval(
        self,
        chat_id: str,
        command: str = "",
        description: str = "",
        *,
        approval_id: Optional[str] = None,
        session_key: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        **kwargs: Any,
    ) -> SendResult:
        meta = metadata or {}
        thread_id = meta.get("thread_id") or meta.get("thread_root_id")
        active = self._lookup_active_run(chat_id, thread_id)
        detail = "\n".join(part for part in [str(description or "").strip(), str(command or kwargs.get("cmd") or "").strip()] if part)
        pid = str(approval_id or f"approval-{uuid.uuid4().hex[:10]}")[:128]
        prompt_block = {
            "id": pid,
            "kind": "approval",
            "title": "需要执行权限确认",
            "description": detail[:4000] if detail else "该操作需要你的授权才能继续执行",
            "options": [
                {"label": "允许本次", "value": "once", "style": "primary"},
                {"label": "本次会话允许", "value": "session", "style": "default"},
                {"label": "始终允许", "value": "always", "style": "default"},
                {"label": "拒绝", "value": "deny", "style": "danger"},
            ],
            "allow_custom": False,
        }
        if active is not None and self._ws is not None:
            part = self._alloc_part(active)
            await self._emit_prompt(active, prompt_block, {"kind": "approval", "session_key": session_key, "approval_id": approval_id})
            return SendResult(success=True, message_id=part.id)
        return await self.send(chat_id, detail or "需要执行权限确认", metadata=metadata)

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        meta = metadata or {}
        thread_id = meta.get("thread_id") or meta.get("thread_root_id")
        active = self._lookup_active_run(chat_id, thread_id)

        if active is not None and self._ws is not None:
            part = self._alloc_part(active)
            await self._emit_structured_content(active, content, part=part)
            return SendResult(success=True, message_id=part.id)

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
        active = self._runs_by_message.get(message_id) or self._part_to_run.get(message_id)
        if active is not None and not active.finished and self._ws is not None:
            part = active.parts_by_id.get(message_id)
            if part is None:
                part = active.parts[-1] if active.parts else self._alloc_part(active)
            await self._emit_structured_content(active, content, part=part)
            # Only finalize from edit_message when no tracked Hermes handler owns the lifecycle.
            # Inside Hermes Gateway, a multi-step turn may call edit_message(..., finalize=True)
            # on intermediate drafts or tool-progress bubbles before the turn actually completes.
            if finalize and not active.finished and not active.handler_started.is_set() and active.joined_prose():
                final_prose = active.joined_prose()
                override = final_prose if (active.needs_patch and final_prose != active.emitted) else None
                await self._finish_run(active, content_override=override)
            return SendResult(success=True, message_id=message_id)

        # Fallback: edit a previously sent REST message directly (strip virtual :pN suffix if present)
        real_id = message_id.split(":p", 1)[0]
        status, payload = await http_json(
            "PATCH",
            f"{self.http_base}/api/messages/{urllib.parse.quote(real_id, safe='')}",
            headers=self._auth_headers,
            body={"content": content},
        )
        if 200 <= status < 300:
            return SendResult(success=True, message_id=message_id)
        err = payload.get("error", {}).get("message") if isinstance(payload, dict) else str(payload)
        return SendResult(success=False, error=f"HTTP {status}: {err}")

    async def delete_message(self, chat_id: str, message_id: str) -> bool:
        # Never delete the active streaming ChlorIM bubble when Hermes dismisses a progress bubble.
        active = self._runs_by_message.get(message_id) or self._part_to_run.get(message_id)
        if active is not None:
            part = active.parts_by_id.get(message_id)
            if part is not None:
                if part.text:
                    active.needs_patch = True
                part.deleted = True
            return True
        if ":p" in message_id:
            return True
        status, _ = await http_json(
            "DELETE",
            f"{self.http_base}/api/messages/{urllib.parse.quote(message_id, safe='')}",
            headers=self._auth_headers,
        )
        return 200 <= status < 300

    async def _upload_and_post_file(
        self,
        chat_id: str,
        path_or_url: str,
        caption: Optional[str] = None,
        *,
        file_name: Optional[str] = None,
        is_image: bool = False,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        target = str(path_or_url or "").strip()
        if not target:
            return SendResult(success=False, error="Empty file path or URL")

        meta = metadata or {}
        thread_id = meta.get("thread_id") or meta.get("thread_root_id")

        if target.startswith(("http://", "https://")):
            md = f"![{file_name or 'image'}]({target})" if is_image else f"[{file_name or target}]({target})"
            text = f"{caption.strip()}\n\n{md}" if caption and caption.strip() else md
            return await self.send(chat_id, text, reply_to=reply_to, metadata=metadata)

        expanded = os.path.expanduser(target)
        if not os.path.isfile(expanded):
            return SendResult(success=False, error=f"File not found: {target}")

        name = file_name or os.path.basename(expanded) or ("image.png" if is_image else "attachment")
        mime = mimetypes.guess_type(name)[0] or ("image/png" if is_image else "application/octet-stream")
        try:
            with open(expanded, "rb") as fh:
                raw_bytes = fh.read()
        except OSError as exc:
            return SendResult(success=False, error=f"Failed to read file: {exc}")

        up_status, up_payload = await http_upload(
            f"{self.http_base}/api/uploads",
            "file",
            name,
            raw_bytes,
            content_type=mime,
            headers=self._auth_headers,
        )
        if not (200 <= up_status < 300) or not isinstance(up_payload, dict):
            err = up_payload.get("error", {}).get("message") if isinstance(up_payload, dict) else str(up_payload)
            return SendResult(success=False, error=f"Upload failed (HTTP {up_status}): {err}")

        body: Dict[str, Any] = {
            "content": (caption or "").strip(),
            "attachments": [up_payload],
        }
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

    async def send_image(
        self,
        chat_id: str,
        image_url: str,
        caption: Optional[str] = None,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        **_kwargs: Any,
    ) -> SendResult:
        return await self._upload_and_post_file(
            chat_id, image_url, caption=caption, is_image=True, reply_to=reply_to, metadata=metadata,
        )

    async def send_document(
        self,
        chat_id: str,
        file_path: str,
        caption: Optional[str] = None,
        file_name: Optional[str] = None,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        **_kwargs: Any,
    ) -> SendResult:
        return await self._upload_and_post_file(
            chat_id, file_path, caption=caption, file_name=file_name, is_image=False, reply_to=reply_to, metadata=metadata,
        )

    send_file = send_document

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

    def _cleanup_run(self, run: _ActiveRun) -> None:
        scope_key = (run.channel_id, run.thread_root_id)
        if self._runs_by_scope.get(scope_key) is run:
            self._runs_by_scope.pop(scope_key, None)
        self._runs_by_message.pop(run.message_id, None)
        self._runs_by_id.pop(run.run_id, None)
        for part in run.parts:
            self._part_to_run.pop(part.id, None)

    async def _finish_run(
        self,
        run: _ActiveRun,
        *,
        error: Optional[str] = None,
        content_override: Optional[str] = None,
    ) -> None:
        if run.finished:
            return
        await self._close_active_tool(run, "error" if error else "done")
        run.finished = True
        run.done_event.set()
        self._cleanup_run(run)
        if error:
            await self._ws_send({"type": "run.error", "run_id": run.run_id, "error": error[:4000]})
            return
        await self._ws_send({"type": "run.done", "run_id": run.run_id, "external_session_id": run.scope_key[:1024]})
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
                    "version": "0.4.6",
                })
                self._mark_connected()
                self._ready_event.set()
            elif kind == "ping":
                await self._ws_send({"type": "pong"})
            elif kind == "fs.list":
                asyncio.create_task(
                    self._handle_fs_list(event.get("request_id", ""), event.get("path")),
                    name="chlorim-fs-list",
                )
            elif kind == "run.start":
                self._spawn_run(event)
            elif kind == "run.input":
                asyncio.create_task(self._handle_run_input(event), name="chlorim-run-input")
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

    async def _handle_run_input(self, event: Dict[str, Any]) -> None:
        run_id = str(event.get("run_id") or "")
        prompt_id = event.get("prompt_id")
        content = str(event.get("content") or "").strip()
        sender = event.get("sender") or {}
        run = self._runs_by_id.get(run_id)
        if run is None or run.finished or not content:
            return
        try:
            prompt_meta = run.pending_prompts.pop(str(prompt_id), None) if prompt_id else None
            if prompt_meta and prompt_meta.get("kind") == "approval":
                session_key = prompt_meta.get("session_key")
                if session_key:
                    try:
                        from tools.approval import resolve_gateway_approval  # type: ignore[import-not-found]
                        if resolve_gateway_approval(session_key, content):
                            return
                    except Exception:
                        pass

            chat_info = await self.get_chat_info(run.channel_id)
            chat_type = "dm" if chat_info.get("type") == "dm" else "group"
            chat_name = chat_info.get("name") or run.channel_id
            source = self._make_source(
                chat_id=run.channel_id,
                chat_type=chat_type,
                chat_name=chat_name,
                user_id=str(sender.get("username") or sender.get("id") or ""),
                user_name=str(sender.get("display_name") or sender.get("username") or "user"),
                thread_id=run.thread_root_id,
            )
            msg_event = self._make_event(
                text=content,
                source=source,
                message_id=f"input:{run.message_id}:{uuid.uuid4().hex[:8]}",
                raw_message=event,
                is_command=content.startswith("/"),
            )
            await self.handle_message(msg_event)
        except Exception:
            logger.exception("Error forwarding ChlorIM run.input for run %s", run_id)

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

    def _strip_bot_mention(self, text: str) -> str:
        cleaned = text.strip()
        if self._bot_username:
            pattern = rf"^(?:@{re.escape(self._bot_username)}\b[\s,，:：]*)+"
            stripped = re.sub(pattern, "", cleaned, flags=re.IGNORECASE).strip()
            if stripped:
                return stripped
        return cleaned

    async def _execute_run(self, run: _ActiveRun, event: Dict[str, Any]) -> None:
        try:
            chat_info = await self.get_chat_info(run.channel_id)
            chat_type = "dm" if chat_info.get("type") == "dm" else "group"
            chat_name = chat_info.get("name") or run.channel_id
            sender = event.get("sender") or {}
            raw_prompt = str(event.get("prompt") or "")
            prompt = self._strip_bot_mention(raw_prompt)
            is_command = prompt.startswith("/")
            work_dir = event.get("work_dir")
            if work_dir and not is_command:
                prompt = f"[ChlorIM Workspace Directory: {work_dir}]\n{prompt}"

            source = self._make_source(
                chat_id=run.channel_id,
                chat_type=chat_type,
                chat_name=chat_name,
                user_id=str(sender.get("username") or sender.get("id") or ""),
                user_name=str(sender.get("display_name") or sender.get("username") or "user"),
                thread_id=run.thread_root_id,
            )
            msg_event = self._make_event(
                text=prompt,
                source=source,
                message_id=run.message_id,
                raw_message=event,
                is_command=is_command,
            )
            result = await self.handle_message(msg_event)
            if isinstance(result, str) and result and not run.emitted and not run.finished:
                await self.send(run.channel_id, result, metadata={"thread_id": run.thread_root_id})
                await self._finish_run(run)
                return

            # In real Hermes Gateway, BasePlatformAdapter.handle_message() spawns a background task
            # and returns None immediately. Wait for the tracked handler to finish without cutting off
            # active multi-step turns early.
            if not run.finished:
                started_at = time.monotonic()
                while not run.finished and not run.handler_started.is_set():
                    try:
                        await asyncio.wait_for(run.handler_started.wait(), timeout=5.0)
                        break
                    except asyncio.TimeoutError:
                        if run.finished:
                            return
                        if run.has_output:
                            # Output is actively flowing even without handler_started; wait until idle.
                            if time.monotonic() - run.last_activity >= 120.0:
                                final_prose = run.joined_prose()
                                override = final_prose if (run.needs_patch and final_prose and final_prose != run.emitted) else None
                                await self._finish_run(run, content_override=override)
                                return
                            continue
                        if time.monotonic() - started_at >= 30.0:
                            await self._finish_run(
                                run,
                                error="Hermes Gateway 未处理此消息（请确认已启用 chlorim 插件并在 ~/.hermes/.env 配置 CHLORIM_ALLOW_ALL_USERS=true）",
                            )
                            return
                if not run.finished:
                    await run.done_event.wait()
        except asyncio.CancelledError:
            run.finished = True
            run.done_event.set()
            self._cleanup_run(run)
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

    def _make_event(
        self,
        *,
        text: str,
        source: Any,
        message_id: str,
        raw_message: Dict[str, Any],
        is_command: bool = False,
    ) -> Any:
        sig = inspect.signature(MessageEvent)
        params = sig.parameters
        kwargs: Dict[str, Any] = {"text": text, "source": source}
        if "message_id" in params:
            kwargs["message_id"] = message_id
        if "message_type" in params:
            if is_command and hasattr(MessageType, "COMMAND"):
                kwargs["message_type"] = getattr(MessageType, "COMMAND")
            else:
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
        "allowed_users_env": "CHLORIM_ALLOWED_USERS",
        "allow_all_env": "CHLORIM_ALLOW_ALL_USERS",
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
