from __future__ import annotations

import asyncio
import os
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from .client import AnyLinkClient, AnyLinkSocket
from .errors import TaskDeclined, TaskFailure
from .journal import FileJournal

InvokeHandler = Callable[[dict[str, Any], "TaskContext"], Awaitable[dict[str, Any] | str]]


@dataclass
class TaskContext:
    task: dict[str, Any]
    cancelled: asyncio.Event
    _report_progress: Callable[[dict[str, Any]], Awaitable[None]]

    async def report_progress(
        self,
        *,
        stage: str | None = None,
        message: str | None = None,
        percent: float | None = None,
        data: dict[str, Any] | None = None,
    ) -> None:
        payload: dict[str, Any] = {}
        if stage is not None:
            payload["stage"] = stage
        if message is not None:
            payload["message"] = message
        if percent is not None:
            payload["percent"] = percent
        if data is not None:
            payload["data"] = data
        await self._report_progress(payload)


class AnyLinkAgent:
    """Ergonomic edge agent runner for AnyLink Protocol v3.

    Supports decorator registration (`@agent.on_invoke` / `@agent.capability`),
    real-time WebSocket push, automatic lease heartbeats, explicit `TaskDeclined`
    boundary reporting, and crash-safe local journaling.
    """

    def __init__(
        self,
        client: AnyLinkClient,
        *,
        journal_path: str | os.PathLike[str],
    ) -> None:
        self.client = client
        self._journal = FileJournal(journal_path)
        self._bound = False
        self._default_handler: InvokeHandler | None = None
        self._handlers: dict[str, tuple[str, InvokeHandler]] = {}

    def on_invoke(self, fn: InvokeHandler) -> InvokeHandler:
        """Register the default handler for capability-free cross-device instructions."""
        self._default_handler = fn
        return fn

    def capability(self, name: str, *, description: str = "") -> Callable[[InvokeHandler], InvokeHandler]:
        """Optionally register a named capability handler (compatibility with structured tasks)."""

        def decorator(fn: InvokeHandler) -> InvokeHandler:
            self._handlers[name] = (description, fn)
            return fn

        return decorator

    async def _ensure_bound(self) -> None:
        if self._bound:
            return
        ident = await self.client.identity()
        device = ident["device"]
        agent = ident.get("agent")
        self._journal.bind(self.client.base_url, device["id"], agent["id"] if agent else None)
        self._bound = True

    async def recover_results(self) -> list[dict[str, Any]]:
        """Resend durable results whose server confirmation was lost; never re-run started tasks."""
        await self._ensure_bound()
        recovered: list[dict[str, Any]] = []
        for row in self._journal.unfinished_results():
            completed = await self.client.complete_task(
                row["task_id"], row["result"], idempotency_key=f"result:{row['task_id']}"
            )
            self._journal.mark_reported(row["task_id"])
            recovered.append(completed)
        return recovered

    async def _execute_claimed(
        self, task: dict[str, Any], *, socket: AnyLinkSocket | None = None
    ) -> dict[str, Any]:
        task_id = task["id"]
        if not self._journal.mark_started(task_id):
            return {"task": task, "replayed": True, "execution_unknown": True}

        cancelled = asyncio.Event()
        off_cancel = None
        if socket is not None:
            off_cancel = socket.on(
                "task.cancel",
                lambda frame: cancelled.set() if frame.get("task_id") == task_id else None,
            )

        lease_seconds = int(task.get("lease_seconds") or 120)
        hb_interval = max(2.0, lease_seconds / 3.0)
        active = True

        async def _heartbeat_loop() -> None:
            while active and not cancelled.is_set():
                try:
                    await asyncio.sleep(hb_interval)
                except asyncio.CancelledError:
                    break
                if not active or cancelled.is_set():
                    break
                try:
                    if socket is not None and socket.connected:
                        ack = await socket.heartbeat_task(task_id)
                        hb = ack.get("heartbeat", {})
                    else:
                        hb = await self.client.heartbeat_task(task_id)
                    if hb.get("cancel_requested"):
                        cancelled.set()
                except Exception:
                    pass

        hb_task = asyncio.create_task(_heartbeat_loop())

        async def _send_progress(progress: dict[str, Any]) -> None:
            if not active:
                return
            try:
                if socket is not None and socket.connected:
                    await socket.report_progress(task_id, progress)
                else:
                    await self.client.report_progress(task_id, progress)
            except Exception:
                pass

        ctx = TaskContext(task=task, cancelled=cancelled, _report_progress=_send_progress)

        try:
            cap = task.get("capability", "agent.invoke")
            result: dict[str, Any]
            try:
                if cap in self._handlers:
                    _, fn = self._handlers[cap]
                    out = await fn(task.get("input", {}), ctx)
                    result = {"state": "succeeded", "output": {"reply": out} if isinstance(out, str) else (out or {})}
                elif self._default_handler is not None:
                    out = await self._default_handler(task, ctx)
                    result = {"state": "succeeded", "output": {"reply": out} if isinstance(out, str) else (out or {})}
                else:
                    result = {
                        "state": "declined",
                        "error": {
                            "code": "CAPABILITY_UNAVAILABLE",
                            "message": f"This agent cannot handle '{cap}' in its environment",
                            "learn_boundary": True,
                        },
                    }
            except TaskDeclined as exc:
                result = {
                    "state": "declined",
                    "error": {"code": exc.code, "message": str(exc)[:500], "learn_boundary": True},
                }
            except TaskFailure as exc:
                err: dict[str, Any] = {"code": exc.code, "message": str(exc)[:500]}
                if exc.learn_boundary:
                    err["learn_boundary"] = True
                result = {"state": "failed", "error": err}
            except Exception:
                result = {
                    "state": "unknown",
                    "error": {
                        "code": "INTERRUPTED_OUTCOME_UNKNOWN" if cancelled.is_set() else "HANDLER_OUTCOME_UNKNOWN",
                        "message": "The host handler did not return a durable result; inspect its effects before retrying",
                    },
                }

            self._journal.mark_finished(task_id, result)
            result_key = f"result:{task_id}"
            if socket is not None and socket.connected:
                try:
                    completed = (await socket.complete_task(task_id, result, idempotency_key=result_key))["task"]
                except Exception:
                    completed = await self.client.complete_task(task_id, result, idempotency_key=result_key)
            else:
                completed = await self.client.complete_task(task_id, result, idempotency_key=result_key)
            self._journal.mark_reported(task_id)
            return {"task": completed, "replayed": False, "execution_unknown": result["state"] == "unknown"}
        finally:
            active = False
            if off_cancel:
                off_cancel()
            hb_task.cancel()
            try:
                await hb_task
            except asyncio.CancelledError:
                pass

    async def run_next(
        self, *, task_id: str | None = None, socket: AnyLinkSocket | None = None
    ) -> dict[str, Any] | None:
        await self._ensure_bound()
        if socket is not None and socket.connected:
            claimed = await socket.claim_task(task_id=task_id)
        else:
            claimed = await self.client.claim_task(task_id=task_id)
        task = claimed.get("task")
        if not task:
            return None
        return await self._execute_claimed(task, socket=socket)

    async def run(
        self,
        *,
        stop_event: asyncio.Event | None = None,
        poll_interval: float = 2.0,
        use_websocket: bool = True,
    ) -> None:
        await self._ensure_bound()
        if self._handlers:
            await self.client.register_capabilities(
                [{"name": name, "description": desc} for name, (desc, _) in self._handlers.items()]
            )
        await self.recover_results()

        stop = stop_event or asyncio.Event()
        if use_websocket:
            socket: AnyLinkSocket | None = None
            try:
                socket = await self.client.connect_websocket()
            except Exception:
                socket = None
            if socket is not None:
                wakeup = asyncio.Event()
                off_avail = socket.on("task.available", lambda _: wakeup.set())
                off_hello = socket.on("hello", lambda _: wakeup.set())
                try:
                    while not stop.is_set():
                        ran = await self.run_next(socket=socket)
                        if ran is not None:
                            continue
                        wakeup.clear()
                        wait_tasks = [
                            asyncio.create_task(wakeup.wait()),
                            asyncio.create_task(stop.wait()),
                            asyncio.create_task(asyncio.sleep(max(poll_interval, 15.0))),
                        ]
                        _, pending = await asyncio.wait(wait_tasks, return_when=asyncio.FIRST_COMPLETED)
                        for p in pending:
                            p.cancel()
                finally:
                    off_avail()
                    off_hello()
                    await socket.close()
                return

        while not stop.is_set():
            await self.run_next()
            try:
                await asyncio.wait_for(stop.wait(), timeout=poll_interval)
            except asyncio.TimeoutError:
                pass
