from __future__ import annotations


class AnyLinkError(Exception):
    """Protocol or transport error returned by an AnyLink hub."""

    def __init__(
        self,
        message: str,
        *,
        code: str = "ANYLINK_ERROR",
        status: int = 0,
        request_id: str | None = None,
        idempotency_key: str | None = None,
        submission_unknown: bool = False,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.status = status
        self.request_id = request_id
        self.idempotency_key = idempotency_key
        self.submission_unknown = submission_unknown


class TaskFailure(Exception):
    """Raise when a task definitely failed and is safe to report as `failed`."""

    def __init__(self, code: str, message: str, *, learn_boundary: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.learn_boundary = learn_boundary


class TaskDeclined(Exception):
    """Raise when this edge agent cannot perform the task in its local environment.

    The Cloud Memory Brain automatically records this boundary so other devices
    naturally avoid sending unsupported tasks in future turns.
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
