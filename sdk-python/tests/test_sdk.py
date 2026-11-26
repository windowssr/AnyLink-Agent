from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import httpx
import pytest

from anylink import AnyLinkAgent, AnyLinkClient, AnyLinkError, FileJournal, TaskContext, TaskDeclined, TaskFailure


def test_file_journal_binding_and_crash_recovery(tmp_path: Path) -> None:
    journal_file = tmp_path / "receipts.jsonl"
    j = FileJournal(journal_file)
    j.bind("https://hub.example/", "dev-1", "agent-1")
    assert j.mark_started("task-1") is True
    assert j.mark_started("task-1") is False

    # Reopening preserves started state and enforces binding.
    j2 = FileJournal(journal_file)
    j2.bind("https://hub.example/", "dev-1", "agent-1")
    assert j2.mark_started("task-1") is False
    with pytest.raises(RuntimeError, match="another service or device"):
        j2.bind("https://other.example/", "dev-1", "agent-1")

    # Finished results stay recoverable until reported.
    j2.mark_started("task-2")
    j2.mark_finished("task-2", {"state": "succeeded", "output": {"ok": True}})
    assert len(j2.unfinished_results()) == 1
    j2.mark_reported("task-2")
    assert j2.unfinished_results() == []
    assert (os.stat(journal_file).st_mode & 0o777) == 0o600


async def test_client_protocol_v3_requests_and_auto_memory() -> None:
    seen: list[tuple[str, str, dict[str, str], Any]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append((req.method, str(req.url), dict(req.headers), req.content.decode("utf-8")))
        return httpx.Response(200, json={"ok": True, "id": "t-1", "state": "queued"})

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(base_url="https://hub.example/", transport=transport) as http:
        client = AnyLinkClient("https://hub.example", "ak_test_token_1234567890", http_client=http)
        assert client.ws_url() == "wss://hub.example/edge/v1/ws"
        await client.assemble_memory(query="Mac 桌面文件", max_memories=10)
        await client.ingest_memory(
            [{"role": "user", "content": "以后都用中文回答"}],
            kind="turn",
            consolidate_now=True,
        )
        await client.invoke("整理桌面文件", target={"device_name": "Mac"}, lease_seconds=90)
        await client.chat_completions(
            model="default",
            messages=[{"role": "user", "content": "你好"}],
            auto_memory=True,
        )

    assert seen[0][1] == "https://hub.example/edge/v1/memory/assemble"
    assert seen[1][1] == "https://hub.example/edge/v1/memory/ingest"
    assert seen[2][1] == "https://hub.example/edge/v1/tasks"
    assert "idempotency-key" in seen[2][2]
    assert seen[3][2]["x-anylink-auto-memory"] == "on"


async def test_client_rejects_remote_http() -> None:
    with pytest.raises(ValueError, match="HTTPS"):
        AnyLinkClient("http://remote.example", "ak_token")


async def test_agent_decorator_declined_failed_and_unknown(tmp_path: Path) -> None:
    reported: list[dict[str, Any]] = []
    queue: list[dict[str, Any]] = [
        {"id": "t-ok", "capability": "agent.invoke", "instruction": "ping", "input": {"instruction": "ping"}, "lease_seconds": 60},
        {"id": "t-decline", "capability": "agent.invoke", "instruction": "send wechat", "input": {"instruction": "send wechat"}, "lease_seconds": 60},
        {"id": "t-fail", "capability": "agent.invoke", "instruction": "bad input", "input": {"instruction": "bad input"}, "lease_seconds": 60},
        {"id": "t-crash", "capability": "agent.invoke", "instruction": "crash", "input": {"instruction": "crash"}, "lease_seconds": 60},
    ]

    class FakeClient:
        base_url = "https://hub.example/"

        async def identity(self) -> dict[str, Any]:
            return {"device": {"id": "dev-1"}, "agent": {"id": "agent-1"}}

        async def claim_task(self, *, task_id: str | None = None) -> dict[str, Any]:
            return {"task": queue.pop(0) if queue else None}

        async def heartbeat_task(self, task_id: str, *, extend_seconds: int | None = None) -> dict[str, Any]:
            return {"task_id": task_id, "cancel_requested": False}

        async def report_progress(self, task_id: str, progress: dict[str, Any]) -> dict[str, Any]:
            return {"id": task_id, "progress": progress}

        async def complete_task(self, task_id: str, result: dict[str, Any], *, idempotency_key: str | None = None) -> dict[str, Any]:
            reported.append({"task_id": task_id, "result": result, "key": idempotency_key})
            return {"id": task_id, "state": result["state"], "result": result}

    agent = AnyLinkAgent(FakeClient(), journal_path=tmp_path / "agent.jsonl")  # type: ignore[arg-type]

    @agent.on_invoke
    async def handle(task: dict[str, Any], ctx: TaskContext) -> dict[str, Any] | str:
        inst = task.get("instruction") or ""
        if inst == "ping":
            await ctx.report_progress(stage="done", percent=100)
            return "pong"
        if inst == "send wechat":
            raise TaskDeclined("NO_WECHAT", "This Linux node cannot send WeChat messages")
        if inst == "bad input":
            raise TaskFailure("BAD_INPUT", "Missing file path")
        raise RuntimeError("Network died mid-side-effect")

    while await agent.run_next() is not None:
        pass

    assert [r["result"]["state"] for r in reported] == ["succeeded", "declined", "failed", "unknown"]
    assert reported[0]["result"]["output"] == {"reply": "pong"}
    assert reported[1]["result"]["error"]["learn_boundary"] is True
    assert reported[1]["result"]["error"]["code"] == "NO_WECHAT"
    assert reported[2]["result"]["error"]["code"] == "BAD_INPUT"


async def test_live_server_end_to_end_if_configured(tmp_path: Path) -> None:
    """Runs against a real AnyLink v3 server when ANYLINK_TEST_BASE_URL + ANYLINK_TEST_JOIN_KEY are set."""
    base_url = os.environ.get("ANYLINK_TEST_BASE_URL")
    join_key = os.environ.get("ANYLINK_TEST_JOIN_KEY")
    if not base_url or not join_key:
        pytest.skip("Set ANYLINK_TEST_BASE_URL and ANYLINK_TEST_JOIN_KEY for live E2E test")

    sender_join = await AnyLinkClient.connect(
        base_url=base_url,
        join_key=join_key,
        install_id="py-e2e-sender-01",
        device_name="PySender",
        platform="linux",
        agent_key="sender",
        agent_name="Python Sender",
    )
    receiver_join = await AnyLinkClient.connect(
        base_url=base_url,
        join_key=join_key,
        install_id="py-e2e-receiver-01",
        device_name="PyMac",
        platform="macos",
        agent_key="receiver",
        agent_name="Python Receiver",
    )

    async with AnyLinkClient(base_url, sender_join["token"]) as sender, AnyLinkClient(
        base_url, receiver_join["token"]
    ) as receiver:
        proto = await sender.protocol()
        assert proto["version"] == "3.0"

        # 1. Connect receiver via WebSocket and handle capability-free task + decline boundary learning
        sender_ws = await sender.connect_websocket()
        receiver_agent = AnyLinkAgent(receiver, journal_path=tmp_path / "recv.jsonl")

        @receiver_agent.on_invoke
        async def handle(task: dict[str, Any], ctx: TaskContext) -> dict[str, Any]:
            inst = task.get("instruction") or ""
            if "微信" in inst:
                raise TaskDeclined("NO_WECHAT", "PyMac 未开放微信发送功能")
            await ctx.report_progress(stage="working", message="处理中", percent=50)
            return {"reply": f"已处理: {inst}"}

        import asyncio

        stop = asyncio.Event()
        runner = asyncio.create_task(receiver_agent.run(stop_event=stop, use_websocket=True))
        try:
            await asyncio.sleep(0.3)
            # Verify live WS online presence
            directory = await sender.directory()
            py_mac = next(d for d in directory["items"] if d["device"]["name"] == "PyMac")
            assert py_mac["agents"][0]["ws_online"] is True

            # Task 1: succeed with real-time WS progress & completion push
            progress_events: list[dict[str, Any]] = []
            t1 = await sender.invoke("整理桌面周报", target={"device_name": "PyMac"})
            done1 = await sender.wait_for_task(
                t1["id"], socket=sender_ws, timeout=10.0, on_progress=progress_events.append
            )
            assert done1["state"] == "succeeded"
            assert done1["result"]["output"]["reply"] == "已处理: 整理桌面周报"

            # Task 2: target declines -> Cloud Memory Brain learns boundary automatically!
            t2 = await sender.invoke("帮我发微信给张三", target={"device_name": "PyMac"})
            done2 = await sender.wait_for_task(t2["id"], socket=sender_ws, timeout=10.0)
            assert done2["state"] == "declined"

            # Give background consolidation a moment, then assemble memory from sender!
            await asyncio.sleep(0.5)
            assembled = await sender.assemble_memory(query="发微信 PyMac")
            assert any("微信" in b["content"] for b in assembled["boundaries"]), assembled
        finally:
            stop.set()
            await runner
            await sender_ws.close()
