"""Translate the Google Antigravity Python SDK's stream to Bridge JSONL."""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import sys
from uuid import uuid4


def emit(event_type, **fields):
    print(json.dumps({"type": event_type, **fields}, ensure_ascii=True), flush=True)


async def run(request, permission):
    try:
        from google.antigravity import Agent, LocalAgentConfig, types
        from google.antigravity.hooks import policy
    except ImportError:
        emit("error", error="Install or update the Antigravity SDK with python3 -m pip install -U google-antigravity.")
        return

    # Do not use the server-supplied session id as a filesystem path.
    session_scope = hashlib.sha256(
        (str(Path.cwd()) + "\0" + request["scope_key"]).encode()
    ).hexdigest()
    save_dir = Path(os.environ["CHIOR_BRIDGE_AGENT_STATE"]) / session_scope
    save_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    options = {"save_dir": str(save_dir), "workspaces": [str(Path.cwd())]}
    external = request.get("external_session_id")
    if external:
        if not isinstance(external, str) or not external.replace("-", "").isalnum() or len(external) > 128:
            emit("error", error="Invalid Antigravity session ID")
            return
        options["conversation_id"] = external

    if permission == "readonly":
        options["policies"] = [
            *[policy.allow(tool.value) for tool in types.BuiltinTools.read_only()],
            policy.deny_all(),
        ]
    elif permission == "auto":
        options["policies"] = [policy.auto()]

    prompt = {"sender": request["sender"], "message": request["prompt"]}
    if not external:
        prompt["recent_messages"] = request["context"][:-1]
        if request.get("channel_context"):
            prompt["channel_context"] = request["channel_context"]
    async with Agent(LocalAgentConfig(**options)) as agent:
        response = await agent.chat(json.dumps(prompt, ensure_ascii=False))
        tools = {}
        async for chunk in response.chunks:
            if isinstance(chunk, types.Thought):
                emit("thinking", delta=chunk.text)
            elif isinstance(chunk, types.Text):
                emit("text", delta=chunk.text)
            elif isinstance(chunk, types.ToolCall):
                tool_id = chunk.id or uuid4().hex
                tool = {"id": tool_id, "name": str(getattr(chunk.name, "value", chunk.name)), "input": chunk.args}
                tools[chunk.id or chunk.step_id or tool_id] = tool
                emit("tool_start", tool={**tool, "status": "running"})
            elif isinstance(chunk, types.ToolResult):
                key = chunk.id or chunk.step_id
                tool = tools.pop(key, None)
                if tool is None:
                    tool = {"id": key or uuid4().hex, "name": str(getattr(chunk.name, "value", chunk.name))}
                emit("tool_end", tool={
                    **tool, "status": "error" if chunk.error else "done",
                    "output": chunk.error or chunk.model_dump(mode="json")["result"],
                })
        emit("done", external_session_id=agent.conversation_id)


if __name__ == "__main__":
    try:
        asyncio.run(run(json.loads(sys.stdin.readline()), sys.argv[1]))
    except Exception as error:
        emit("error", error=f"Antigravity SDK run failed ({type(error).__name__}). Check the Python SDK and Gemini credentials.")
