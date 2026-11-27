from __future__ import annotations

import asyncio
import os
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from .client import AnyLinkClient, AnyLinkSocket
from .errors import AnyLinkError, TaskDeclined, TaskFailure
from .journal import FileJournal

InvokeHandler = Callable[[dict[str, Any], "TaskContext"], Awaitable[dict[str, Any] | str]]
FENCE_CODES = frozenset({"TASK_NOT_ACTIVE", "LEASE_FENCED", "TASK_TERMINAL"})


@dataclass
class TaskContext:
    task: dict[str, Any]
    cancelled: asyncio.Event
    _report_progress: Callable[[dict[str, Any]], Awaitable[None]]
    _suspend: Callable[[str, dict[str, Any], int], Awaitable[dict[str, Any]]]

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

    async def ask_input(
        self,
        prompt: str,
        *,
        choices: list[str] | None = None,
        timeout_seconds: int = 600,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"prompt": prompt}
        if choices:
            payload["choices"] = choices
        return await self._suspend("awaiting_input", payload, timeout_seconds)

    async def request_approval(
        self,
        prompt: str,
        *,
        risk_level: str = "medium",
        timeout_seconds: int = 600,
    ) -> dict[str, Any]:
        reply = await self._suspend(
            "awaiting_approval", {"prompt": prompt, "risk_level": risk_level}, timeout_seconds
        )
        return {
            "approved": reply.get("approved") is not False,
            "message": reply.get("message", ""),
            "data": reply.get("data"),
        }


class AnyLinkAgent:
    """Ergonomic edge agent runner for AnyLink Protocol v3.2.

    Supports decorator registration (`@agent.on_invoke` / `@agent.capability`),
    real-time WebSocket push with auto-reconnect, concurrent task slots, fencing lease heartbeats,
    interactive `ask_input` / `request_approval`, explicit `TaskDeclined`, and crash-safe journaling.
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
        self._default_handler = fn
        return fn

    def capability(self, name: str, *, description: str = "") -> Callable[[InvokeHandler], InvokeHandler]:
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
        await self._ensure_bound()
        recovered: list[dict[str, Any]] = []
        for row in self._journal.unfinished_results():
            try:
                completed = await self.client.complete_task(
                    row["task_id"], row["result"], idempotency_key=f"result:{row['task_id']}"
                )
                self._journal.mark_reported(row["task_id"])
                recovered.append(completed)
            except AnyLinkError as exc:
                if exc.status == 409 or exc.code in FENCE_CODES:
                    self._journal.mark_reported(row["task_id"])
                else:
                    raise
        return recovered

    async def _execute_claimed(
        self, task: dict[str, Any], *, socket: AnyLinkSocket | None = None
    ) -> dict[str, Any]:
        task_id = task["id"]
        lease_token = task.get("lease_token")
        attempt = int(task.get("attempt") or 1)
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
        suspended = False

        async def _heartbeat_loop() -> None:
            while active and not cancelled.is_set():
                try:
                    await asyncio.sleep(hb_interval)
                except asyncio.CancelledError:
                    break
                if not active or cancelled.is_set():
                    break
                if suspended:
                    continue
                try:
                    lt_kw = {"lease_token": lease_token} if lease_token else {}
                    if socket is not None and socket.connected:
                        ack = await socket.heartbeat_task(task_id, **lt_kw)
                        hb = ack.get("heartbeat", {})
                    else:
                        hb = await self.client.heartbeat_task(task_id, **lt_kw)
                    if hb.get("cancel_requested"):
                        cancelled.set()
                except AnyLinkError as exc:
                    if exc.status == 409 or exc.code in FENCE_CODES:
                        cancelled.set()
                        break
                except Exception:
                    pass

        hb_task = asyncio.create_task(_heartbeat_loop())

        async def _send_progress(progress: dict[str, Any]) -> None:
            if not active:
                return
            try:
                lt_kw = {"lease_token": lease_token} if lease_token else {}
                if socket is not None and socket.connected:
                    await socket.report_progress(task_id, progress, **lt_kw)
                else:
                    await self.client.report_progress(task_id, progress, **lt_kw)
            except Exception:
                pass

        async def _suspend_wait(state: str, payload: dict[str, Any], timeout_seconds: int) -> dict[str, Any]:
            nonlocal suspended
            suspended = True
            try:
                body = {"state": state, **payload, "timeout_seconds": timeout_seconds}
                if socket is not None and socket.connected:
                    await socket.suspend_task(task_id, body, lease_token=lease_token)
                else:
                    await self.client.suspend_task(task_id, body, lease_token=lease_token)

                loop = asyncio.get_running_loop()
                reply_fut: asyncio.Future[dict[str, Any]] = loop.create_future()

                def _on_resumed(frame: dict[str, Any]) -> None:
                    if frame.get("task_id") == task_id and not reply_fut.done():
                        reply_fut.set_result(
                            frame.get("reply")
                            or (frame.get("task") or {}).get("pending_interaction", {}).get("reply")
                            or {}
                        )

                off_r = socket.on("task.resumed", _on_resumed) if socket is not None else None

                async def _poll() -> None:
                    while not reply_fut.done() and not cancelled.is_set():
                        await asyncio.sleep(1.5)
                        try:
                            cur = await self.client.get_task(task_id)
                            if cur.get("state") == "running" and (cur.get("pending_interaction") or {}).get("resolved"):
                                if not reply_fut.done():
                                    reply_fut.set_result(cur["pending_interaction"].get("reply") or {})
                                return
                            if cur.get("state") == "declined" and not reply_fut.done():
                                reply_fut.set_result({"approved": False, "message": (cur.get("result") or {}).get("error", {}).get("message", "Declined")})
                                return
                            if cur.get("state") in ("cancelled", "expired", "unknown", "failed") and not reply_fut.done():
                                reply_fut.set_exception(TaskFailure("INTERACTION_ENDED", f"Task ended ({cur.get('state')})"))
                                return
                        except Exception:
                            pass

                poll_task = asyncio.create_task(_poll())
                try:
                    return await asyncio.wait_for(reply_fut, timeout=float(timeout_seconds))
                finally:
                    if off_r:
                        off_r()
                    poll_task.cancel()
            finally:
                suspended = False

        ctx = TaskContext(
            task=task,
            cancelled=cancelled,
            _report_progress=_send_progress,
            _suspend=_suspend_wait,
        )

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
            result_key = f"result:{task_id}:{attempt}" if attempt > 1 else f"result:{task_id}"
            lt_kw = {"lease_token": lease_token} if lease_token else {}
            try:
                if socket is not None and socket.connected:
                    try:
                        completed = (
                            await socket.complete_task(
                                task_id, result, idempotency_key=result_key, **lt_kw
                            )
                        )["task"]
                    except AnyLinkError as exc:
                        if exc.code in FENCE_CODES:
                            raise
                        completed = await self.client.complete_task(
                            task_id, result, idempotency_key=result_key, **lt_kw
                        )
                else:
                    completed = await self.client.complete_task(
                        task_id, result, idempotency_key=result_key, **lt_kw
                    )
                self._journal.mark_reported(task_id)
            except AnyLinkError as exc:
                if exc.status == 409 or exc.code in FENCE_CODES:
                    self._journal.mark_reported(task_id)
                    return {"task": task, "replayed": False, "fenced": True, "execution_unknown": result["state"] == "unknown"}
                raise
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
        max_concurrency: int = 2,
    ) -> None:
        await self._ensure_bound()
        if self._handlers:
            await self.client.register_capabilities(
                [{"name": name, "description": desc} for name, (desc, _) in self._handlers.items()]
            )
        await self.recover_results()

        stop = stop_event or asyncio.Event()
        concurrency = max(1, min(16, int(max_concurrency)))

        if use_websocket:
            socket: AnyLinkSocket | None = None
            try:
                socket = await self.client.connect_websocket(auto_reconnect=True)
            except Exception:
                socket = None
            if socket is not None:
                wakeup = asyncio.Event()
                in_flight: set[asyncio.Task[Any]] = set()
                off_avail = socket.on("task.available", lambda _: wakeup.set())

                def _on_hello(_: dict[str, Any]) -> None:
                    asyncio.create_task(self.recover_results())
                    wakeup.set()

                off_hello = socket.on("hello", _on_hello)
                try:
                    while not stop.is_set():
                        claimed_any = False
                        while not stop.is_set() and len(in_flight) < concurrency:
                            try:
                                claimed = (
                                    await socket.claim_task()
                                    if socket.connected
                                    else await self.client.claim_task()
                                )
                                task = claimed.get("task")
                            except Exception:
                                task = None
                            if not task:
                                break
                            claimed_any = True

                            async def _run_job(t: dict[str, Any]) -> None:
                                try:
                                    await self._execute_claimed(t, socket=socket)
                                except Exception:
                                    pass

                            job = asyncio.create_task(_run_job(task))
                            in_flight.add(job)
                            job.add_done_callback(lambda j: (in_flight.discard(j), wakeup.set()))

                        if claimed_any and len(in_flight) < concurrency:
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
                    if in_flight:
                        await asyncio.gather(*in_flight, return_exceptions=True)
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
