from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


class FileJournal:
    """Crash-safe append-only JSONL journal preventing blind replay of side effects."""

    def __init__(self, journal_path: str | os.PathLike[str]) -> None:
        raw = str(journal_path)
        if not raw or raw == ":memory:":
            raise ValueError("Use a persistent private journal_path")
        self._path = Path(raw).resolve()
        self._path.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(self._path.parent, 0o700)
        except OSError:
            pass
        fd = os.open(self._path, os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o600)
        os.close(fd)
        try:
            os.chmod(self._path, 0o600)
        except OSError:
            pass
        self._binding: dict[str, Any] | None = None
        self._records: dict[str, dict[str, Any]] = {}
        self._load()

    def _load(self) -> None:
        with self._path.open("r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if entry.get("type") == "binding":
                    self._binding = entry
                elif entry.get("type") == "exec" and entry.get("task_id"):
                    self._records[entry["task_id"]] = entry

    def _append(self, entry: dict[str, Any]) -> None:
        with self._path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
            fh.flush()

    def bind(self, server: str, device_id: str, agent_id: str | None) -> None:
        if self._binding is None:
            self._binding = {
                "type": "binding",
                "server": server,
                "device_id": device_id,
                "agent_id": agent_id,
            }
            self._append(self._binding)
            return
        if (
            self._binding["server"] != server
            or self._binding["device_id"] != device_id
            or (
                self._binding.get("agent_id") is not None
                and agent_id is not None
                and self._binding["agent_id"] != agent_id
            )
        ):
            raise RuntimeError(
                "Journal belongs to another service or device; use its original identity or a separate journal"
            )
        if self._binding.get("agent_id") is None and agent_id is not None:
            self._binding = {**self._binding, "agent_id": agent_id}
            self._append(self._binding)

    def mark_started(self, task_id: str) -> bool:
        if task_id in self._records:
            return False
        entry = {"type": "exec", "task_id": task_id, "state": "started", "result": None}
        self._records[task_id] = entry
        self._append(entry)
        return True

    def mark_finished(self, task_id: str, result: dict[str, Any]) -> None:
        entry = {"type": "exec", "task_id": task_id, "state": "finished", "result": result}
        self._records[task_id] = entry
        self._append(entry)

    def mark_reported(self, task_id: str) -> None:
        prev = self._records.get(task_id)
        entry = {
            "type": "exec",
            "task_id": task_id,
            "state": "reported",
            "result": prev.get("result") if prev else None,
        }
        self._records[task_id] = entry
        self._append(entry)

    def unfinished_results(self) -> list[dict[str, Any]]:
        return [
            {"task_id": r["task_id"], "result": r["result"]}
            for r in self._records.values()
            if r.get("state") == "finished" and r.get("result") is not None
        ]
