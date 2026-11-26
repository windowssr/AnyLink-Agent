from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any
from urllib.parse import urlparse

import httpx
import websockets

from .errors import AnyLinkError

TERMINAL_TASK_STATES = frozenset(
    {"succeeded", "failed", "declined", "cancelled", "unknown", "expired"}
)


def _check_base_url(base_url: str) -> str:
    parsed = urlparse(base_url)
    if (
        parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.scheme not in ("http", "https")
        or not parsed.hostname
    ):
        raise ValueError("Use an HTTP(S) base_url without credentials, query, or fragment")
    if parsed.scheme == "http" and parsed.hostname not in ("localhost", "127.0.0.1", "::1"):
        raise ValueError("Remote AnyLink connections require HTTPS or a loopback tunnel")
    return base_url.rstrip("/") + "/"


class AnyLinkSocket:
    """Real-time WebSocket client for AnyLink Protocol v3 (/edge/v1/ws)."""

    def __init__(self, ws_url: str, token: str) -> None:
        self._ws_url = ws_url
        self._token = token
        self._ws: Any = None
        self._closed = False
        self._pending: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._listeners: dict[str, list[Callable[[dict[str, Any]], Any]]] = {}
        self._reader_task: asyncio.Task[None] | None = None
        self._ping_task: asyncio.Task[None] | None = None

    @property
    def connected(self) -> bool:
        return self._ws is not None and not self._closed

    def on(self, event_type: str, listener: Callable[[dict[str, Any]], Any]) -> Callable[[], None]:
        self._listeners.setdefault(event_type, []).append(listener)

        def unsubscribe() -> None:
            items = self._listeners.get(event_type)
            if items and listener in items:
                items.remove(listener)

        return unsubscribe

    def _emit(self, event_type: str, frame: dict[str, Any]) -> None:
        for fn in list(self._listeners.get(event_type, [])):
            res = fn(frame)
            if asyncio.iscoroutine(res):
                asyncio.create_task(res)

    async def connect(self, *, timeout: float = 15.0) -> AnyLinkSocket:
        self._closed = False
        self._ws = await asyncio.wait_for(
            websockets.connect(
                self._ws_url,
                additional_headers={"Authorization": f"Bearer {self._token}"},
                ping_interval=None,
            ),
            timeout=timeout,
        )
        raw_hello = await asyncio.wait_for(self._ws.recv(), timeout=timeout)
        hello = json.loads(raw_hello)
        if hello.get("type") != "hello":
            await self.close()
            raise AnyLinkError(
                hello.get("message", "WebSocket handshake failed"),
                code=hello.get("code", "WS_AUTH_FAILED"),
            )
        self._reader_task = asyncio.create_task(self._read_loop())
        self._ping_task = asyncio.create_task(self._ping_loop())
        self._emit("hello", hello)
        return self

    async def _read_loop(self) -> None:
        try:
            async for raw in self._ws:
                try:
                    frame = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                req_id = frame.get("request_id")
                if req_id and req_id in self._pending:
                    fut = self._pending.pop(req_id)
                    if not fut.done():
                        if frame.get("type") == "error":
                            fut.set_exception(
                                AnyLinkError(
                                    frame.get("message", "WS error"),
                                    code=frame.get("code", "WS_ERROR"),
                                )
                            )
                        else:
                            fut.set_result(frame)
                frame_type = frame.get("type")
                if isinstance(frame_type, str):
                    self._emit(frame_type, frame)
                self._emit("frame", frame)
        except asyncio.CancelledError:
            raise
        except Exception:
            pass
        finally:
            self._ws = None
            for req_id, fut in list(self._pending.items()):
                self._pending.pop(req_id, None)
                if not fut.done():
                    fut.set_exception(
                        AnyLinkError("WebSocket closed", code="WS_CLOSED", submission_unknown=True)
                    )
            self._emit("close", {"type": "close"})

    async def _ping_loop(self) -> None:
        try:
            while self.connected:
                await asyncio.sleep(20)
                if self._ws is not None:
                    await self._ws.send(json.dumps({"type": "ping"}))
        except asyncio.CancelledError:
            raise
        except Exception:
            pass

    async def send_rpc(self, frame: dict[str, Any], *, timeout: float = 15.0) -> dict[str, Any]:
        if not self.connected or self._ws is None:
            raise AnyLinkError("WebSocket is not connected", code="WS_DISCONNECTED")
        req_id = str(frame.get("request_id") or uuid.uuid4())
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[dict[str, Any]] = loop.create_future()
        self._pending[req_id] = fut
        try:
            await self._ws.send(json.dumps({**frame, "request_id": req_id}, ensure_ascii=False))
            return await asyncio.wait_for(fut, timeout=timeout)
        except asyncio.TimeoutError as exc:
            self._pending.pop(req_id, None)
            raise AnyLinkError(
                "WebSocket RPC timed out", code="WS_TIMEOUT", submission_unknown=True
            ) from exc

    async def claim_task(
        self, *, task_id: str | None = None, idempotency_key: str | None = None
    ) -> dict[str, Any]:
        frame: dict[str, Any] = {
            "type": "task.claim",
            "idempotency_key": idempotency_key or str(uuid.uuid4()),
        }
        if task_id:
            frame["task_id"] = task_id
        return await self.send_rpc(frame)

    async def heartbeat_task(
        self, task_id: str, *, extend_seconds: int | None = None
    ) -> dict[str, Any]:
        frame: dict[str, Any] = {"type": "task.heartbeat", "task_id": task_id}
        if extend_seconds is not None:
            frame["extend_seconds"] = extend_seconds
        return await self.send_rpc(frame)

    async def report_progress(self, task_id: str, progress: dict[str, Any]) -> dict[str, Any]:
        return await self.send_rpc({"type": "task.progress", "task_id": task_id, "progress": progress})

    async def complete_task(
        self, task_id: str, result: dict[str, Any], *, idempotency_key: str | None = None
    ) -> dict[str, Any]:
        return await self.send_rpc(
            {
                "type": "task.result",
                "task_id": task_id,
                "idempotency_key": idempotency_key or f"result:{task_id}",
                "result": result,
            }
        )

    async def cancel_task(
        self, task_id: str, *, idempotency_key: str | None = None
    ) -> dict[str, Any]:
        return await self.send_rpc(
            {
                "type": "task.cancel",
                "task_id": task_id,
                "idempotency_key": idempotency_key or str(uuid.uuid4()),
            }
        )

    async def close(self) -> None:
        self._closed = True
        for task in (self._ping_task, self._reader_task):
            if task and not task.done():
                task.cancel()
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:
                pass
            self._ws = None


class AnyLinkClient:
    """Async HTTP + WebSocket client for AnyLink Protocol v3."""

    def __init__(
        self,
        base_url: str,
        token: str,
        *,
        timeout: float = 30.0,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        if not isinstance(token, str) or not token.strip() or "\n" in token or "\r" in token:
            raise ValueError("A device credential token is required")
        self.base_url = _check_base_url(base_url)
        self._token = token
        self._timeout = timeout
        self._owns_client = http_client is None
        self._http = http_client or httpx.AsyncClient(
            base_url=self.base_url,
            timeout=timeout,
            follow_redirects=False,
        )

    async def __aenter__(self) -> AnyLinkClient:
        return self

    async def __aexit__(self, *_: Any) -> None:
        await self.close()

    async def close(self) -> None:
        if self._owns_client:
            await self._http.aclose()

    @classmethod
    async def connect(
        cls,
        *,
        base_url: str,
        join_key: str | None = None,
        password: str | None = None,
        install_id: str,
        device_name: str,
        agent_key: str,
        agent_name: str,
        platform: str = "other",
        device_slug: str | None = None,
        kind: str = "agent",
        summary: str = "",
        timeout: float = 30.0,
    ) -> dict[str, Any]:
        """Join an AnyLink server with the owner join key or login password and receive a one-time agent token."""
        checked = _check_base_url(base_url)
        secret = join_key or password
        if not secret or "\n" in secret or "\r" in secret:
            raise ValueError("A join_key or password is required")
        device_body: dict[str, Any] = {"install_id": install_id, "name": device_name, "platform": platform}
        if device_slug is not None:
            device_body["slug"] = device_slug
        payload = {
            "device": device_body,
            "agent": {"key": agent_key, "name": agent_name, "kind": kind, "summary": summary},
        }
        async with httpx.AsyncClient(base_url=checked, timeout=timeout, follow_redirects=False) as http:
            try:
                res = await http.post(
                    "edge/v1/connect",
                    headers={"Authorization": f"Bearer {secret}"},
                    json=payload,
                )
            except httpx.HTTPError as exc:
                raise AnyLinkError("AnyLink connect failed", code="TRANSPORT_ERROR") from exc
        if res.status_code >= 400:
            try:
                err = res.json().get("error", {})
            except Exception:
                err = {}
            raise AnyLinkError(
                err.get("message", f"AnyLink HTTP {res.status_code}"),
                code=err.get("code", "HTTP_ERROR"),
                status=res.status_code,
            )
        return res.json()

    def ws_url(self) -> str:
        parsed = urlparse(self.base_url)
        scheme = "wss" if parsed.scheme == "https" else "ws"
        return f"{scheme}://{parsed.netloc}{parsed.path}edge/v1/ws"

    async def connect_websocket(self, *, timeout: float = 15.0) -> AnyLinkSocket:
        sock = AnyLinkSocket(self.ws_url(), self._token)
        return await sock.connect(timeout=timeout)

    async def _request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
        *,
        idempotency_key: str | None | bool = None,
        headers: dict[str, str] | None = None,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        writing = method.upper() not in ("GET", "HEAD")
        key: str | None = None
        if writing and idempotency_key is not False:
            key = idempotency_key if isinstance(idempotency_key, str) else str(uuid.uuid4())
        req_headers = {"Authorization": f"Bearer {self._token}", **(headers or {})}
        if key:
            req_headers["Idempotency-Key"] = key
        try:
            res = await self._http.request(
                method,
                path,
                json=body,
                headers=req_headers,
                params=params,
            )
        except httpx.HTTPError as exc:
            raise AnyLinkError(
                "Submission outcome is unknown; do not repeat execution blindly"
                if writing
                else "AnyLink request failed",
                code="SUBMISSION_UNKNOWN" if writing else "TRANSPORT_ERROR",
                idempotency_key=key,
                submission_unknown=writing,
            ) from exc
        request_id = res.headers.get("x-anylink-request-id")
        if res.status_code >= 400:
            try:
                data = res.json()
                err = data.get("error", {})
            except Exception:
                data, err = {}, {}
            code = err.get("code", "HTTP_ERROR")
            raise AnyLinkError(
                err.get("message", f"AnyLink HTTP {res.status_code}"),
                code=code,
                status=res.status_code,
                request_id=data.get("request_id") or request_id,
                idempotency_key=key,
                submission_unknown=writing and res.status_code >= 500 and code != "PROVIDER_NOT_CONFIGURED",
            )
        return res.json()

    # Identity & discovery
    async def protocol(self) -> dict[str, Any]:
        return await self._request("GET", "edge/v1/protocol")

    async def identity(self) -> dict[str, Any]:
        return await self._request("GET", "edge/v1/identity")

    async def directory(self) -> dict[str, Any]:
        return await self._request("GET", "edge/v1/directory")

    async def persona(self) -> dict[str, Any]:
        return await self._request("GET", "edge/v1/persona")

    async def update_profile(
        self,
        *,
        name: str | None = None,
        summary: str | None = None,
        kind: str | None = None,
    ) -> dict[str, Any]:
        body = {k: v for k, v in {"name": name, "summary": summary, "kind": kind}.items() if v is not None}
        return await self._request("PATCH", "edge/v1/agent/profile", body, idempotency_key=False)

    async def update_device_profile(
        self,
        *,
        name: str | None = None,
        slug: str | None = None,
    ) -> dict[str, Any]:
        body = {k: v for k, v in {"name": name, "slug": slug}.items() if v is not None}
        return await self._request("PATCH", "edge/v1/device/profile", body, idempotency_key=False)

    # Cloud Memory Brain v3
    async def assemble_memory(
        self,
        *,
        query: str | None = None,
        max_memories: int = 15,
        max_episodes: int = 6,
        max_chars: int = 12000,
        include_scopes: list[str] | None = None,
        include_boundaries: bool = True,
        include_persona: bool = False,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "max_memories": max_memories,
            "max_episodes": max_episodes,
            "max_chars": max_chars,
            "include_boundaries": include_boundaries,
            "include_persona": include_persona,
        }
        if query is not None:
            body["query"] = query
        if include_scopes is not None:
            body["include_scopes"] = include_scopes
        return await self._request("POST", "edge/v1/memory/assemble", body, idempotency_key=False)

    async def ingest_memory(
        self,
        messages: list[dict[str, Any]],
        *,
        kind: str = "turn",
        session_key: str | None = None,
        metadata: dict[str, Any] | None = None,
        consolidate_now: bool = False,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "kind": kind,
            "messages": messages,
            "metadata": metadata or {},
            "consolidate_now": consolidate_now,
        }
        if session_key:
            body["session_key"] = session_key
        return await self._request("POST", "edge/v1/memory/ingest", body, idempotency_key=False)

    async def episodes(self, *, limit: int = 30) -> dict[str, Any]:
        return await self._request("GET", "edge/v1/memory/episodes", params={"limit": limit})

    async def context(self) -> dict[str, Any]:
        return await self._request("GET", "edge/v1/context")

    async def search_memories(
        self,
        *,
        q: str | None = None,
        scope: str | None = None,
        kind: str | None = None,
        device_id: str | None = None,
        limit: int | None = None,
    ) -> dict[str, Any]:
        body = {
            k: v
            for k, v in {"q": q, "scope": scope, "kind": kind, "device_id": device_id, "limit": limit}.items()
            if v is not None
        }
        return await self._request("POST", "edge/v1/memories/search", body, idempotency_key=False)

    async def save_memory(
        self,
        *,
        title: str,
        content: str,
        scope: str = "global",
        kind: str = "fact",
        tags: list[str] | None = None,
        importance: float = 0.6,
        applicable_device_id: str | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "title": title,
            "content": content,
            "scope": scope,
            "kind": kind,
            "tags": tags or [],
            "importance": importance,
        }
        if applicable_device_id is not None:
            body["applicable_device_id"] = applicable_device_id
        return await self._request("POST", "edge/v1/memories", body, idempotency_key=idempotency_key)

    async def update_memory(
        self,
        memory_id: str,
        expected_revision: int,
        *,
        title: str | None = None,
        content: str | None = None,
        kind: str | None = None,
        tags: list[str] | None = None,
        importance: float | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"expected_revision": expected_revision}
        for k, v in {"title": title, "content": content, "kind": kind, "tags": tags, "importance": importance}.items():
            if v is not None:
                body[k] = v
        return await self._request(
            "PATCH", f"edge/v1/memories/{memory_id}", body, idempotency_key=idempotency_key
        )

    async def delete_memory(
        self, memory_id: str, revision: int, *, idempotency_key: str | None = None
    ) -> dict[str, Any]:
        return await self._request(
            "DELETE",
            f"edge/v1/memories/{memory_id}",
            headers={"If-Match": str(revision)},
            idempotency_key=idempotency_key,
        )

    # Multi-Model Gateway
    async def models(self) -> dict[str, Any]:
        return await self._request("GET", "model/v1/models")

    async def chat_completions(
        self,
        *,
        model: str = "default",
        messages: list[dict[str, Any]],
        auto_memory: bool | None = None,
        **extra: Any,
    ) -> dict[str, Any]:
        headers = {}
        if auto_memory is not None:
            headers["X-AnyLink-Auto-Memory"] = "on" if auto_memory else "off"
        return await self._request(
            "POST",
            "model/v1/chat/completions",
            {"model": model, "messages": messages, "stream": False, **extra},
            headers=headers,
            idempotency_key=False,
        )

    async def stream_chat_completions(
        self,
        *,
        model: str = "default",
        messages: list[dict[str, Any]],
        auto_memory: bool | None = None,
        **extra: Any,
    ) -> AsyncIterator[dict[str, Any]]:
        headers = {"Authorization": f"Bearer {self._token}"}
        if auto_memory is not None:
            headers["X-AnyLink-Auto-Memory"] = "on" if auto_memory else "off"
        async with self._http.stream(
            "POST",
            "model/v1/chat/completions",
            headers=headers,
            json={"model": model, "messages": messages, "stream": True, **extra},
        ) as res:
            if res.status_code >= 400:
                raw = await res.aread()
                try:
                    err = json.loads(raw).get("error", {})
                except Exception:
                    err = {}
                raise AnyLinkError(
                    err.get("message", f"Model HTTP {res.status_code}"),
                    code=err.get("code", "HTTP_ERROR"),
                    status=res.status_code,
                    submission_unknown=res.status_code >= 500,
                )
            done = False
            async for line in res.aiter_lines():
                if not line.startswith("data:"):
                    continue
                data = line[5:].lstrip()
                if data == "[DONE]":
                    done = True
                    break
                if data:
                    yield json.loads(data)
            if not done:
                raise AnyLinkError(
                    "Model stream ended without [DONE]; it will not be retried",
                    code="STREAM_INCOMPLETE",
                    submission_unknown=True,
                )

    # Cross-device tasks (capability-free)
    async def invoke(
        self,
        instruction: str,
        *,
        target: dict[str, str] | None = None,
        capability: str | None = None,
        input_data: dict[str, Any] | None = None,
        ttl_seconds: int = 1800,
        lease_seconds: int = 120,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "instruction": instruction,
            "ttl_seconds": ttl_seconds,
            "lease_seconds": lease_seconds,
        }
        if target:
            body["target"] = target
        if capability:
            body["capability"] = capability
        if input_data is not None:
            body["input"] = input_data
        return await self._request("POST", "edge/v1/tasks", body, idempotency_key=idempotency_key)

    async def create_task(
        self, task: dict[str, Any], *, idempotency_key: str | None = None
    ) -> dict[str, Any]:
        return await self._request("POST", "edge/v1/tasks", task, idempotency_key=idempotency_key)

    async def get_task(self, task_id: str) -> dict[str, Any]:
        return await self._request("GET", f"edge/v1/tasks/{task_id}")

    async def list_tasks(
        self, *, role: str = "source", state: str | None = None
    ) -> dict[str, Any]:
        params = {"role": role, **({"state": state} if state else {})}
        return await self._request("GET", "edge/v1/tasks", params=params)

    async def claim_task(
        self, *, task_id: str | None = None, idempotency_key: str | None = None
    ) -> dict[str, Any]:
        body = {"task_id": task_id} if task_id else {}
        return await self._request("POST", "edge/v1/tasks/claim", body, idempotency_key=idempotency_key)

    async def heartbeat_task(
        self, task_id: str, *, extend_seconds: int | None = None
    ) -> dict[str, Any]:
        body = {"extend_seconds": extend_seconds} if extend_seconds is not None else {}
        return await self._request(
            "POST", f"edge/v1/tasks/{task_id}/heartbeat", body, idempotency_key=False
        )

    async def report_progress(self, task_id: str, progress: dict[str, Any]) -> dict[str, Any]:
        return await self._request(
            "POST", f"edge/v1/tasks/{task_id}/progress", progress, idempotency_key=False
        )

    async def complete_task(
        self, task_id: str, result: dict[str, Any], *, idempotency_key: str | None = None
    ) -> dict[str, Any]:
        return await self._request(
            "POST",
            f"edge/v1/tasks/{task_id}/result",
            result,
            idempotency_key=idempotency_key or f"result:{task_id}",
        )

    async def cancel_task(
        self, task_id: str, *, idempotency_key: str | None = None
    ) -> dict[str, Any]:
        return await self._request(
            "POST", f"edge/v1/tasks/{task_id}/cancel", {}, idempotency_key=idempotency_key
        )

    async def register_capabilities(
        self, capabilities: list[dict[str, str]], *, idempotency_key: str | None = None
    ) -> dict[str, Any]:
        return await self._request(
            "POST",
            "edge/v1/link/capabilities",
            {"capabilities": capabilities},
            idempotency_key=idempotency_key,
        )

    async def wait_for_task(
        self,
        task_id: str,
        *,
        socket: AnyLinkSocket | None = None,
        timeout: float = 120.0,
        poll_interval: float = 1.0,
        on_progress: Callable[[dict[str, Any]], Any] | None = None,
    ) -> dict[str, Any]:
        if socket is not None and socket.connected:
            loop = asyncio.get_running_loop()
            done_fut: asyncio.Future[dict[str, Any]] = loop.create_future()

            def _on_complete(frame: dict[str, Any]) -> None:
                task = frame.get("task")
                if task and task.get("id") == task_id and not done_fut.done():
                    done_fut.set_result(task)

            def _on_progress(frame: dict[str, Any]) -> None:
                if frame.get("task_id") == task_id and on_progress:
                    on_progress(frame.get("progress", {}))

            off_c = socket.on("task.completed", _on_complete)
            off_p = socket.on("task.progress", _on_progress)
            try:
                cur = await self.get_task(task_id)
                if cur.get("state") in TERMINAL_TASK_STATES:
                    return cur
                return await asyncio.wait_for(done_fut, timeout=timeout)
            except asyncio.TimeoutError as exc:
                raise AnyLinkError("Timed out waiting for task", code="TASK_WAIT_TIMEOUT") from exc
            finally:
                off_c()
                off_p()

        deadline = asyncio.get_running_loop().time() + timeout
        while asyncio.get_running_loop().time() < deadline:
            cur = await self.get_task(task_id)
            if cur.get("progress") and on_progress:
                on_progress(cur["progress"])
            if cur.get("state") in TERMINAL_TASK_STATES:
                return cur
            await asyncio.sleep(min(poll_interval, max(0.05, deadline - asyncio.get_running_loop().time())))
        raise AnyLinkError("Timed out waiting for task", code="TASK_WAIT_TIMEOUT")
