"""Offline validation: malformed input must never reach the online provider."""
import asyncio
import importlib.util
import io
import json
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

provider = types.SimpleNamespace(Communicate=lambda *_a, **_kw: (_ for _ in ()).throw(AssertionError("network reached")))
sys.modules["edge_tts"] = provider
spec = importlib.util.spec_from_file_location("synthesize", Path(__file__).with_name("synthesize.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class InputValidation(unittest.TestCase):
    def reject(self, request, error):
        stdin = types.SimpleNamespace(buffer=io.BytesIO(json.dumps(request).encode()))
        with patch.object(sys, "stdin", stdin), self.assertRaises(error):
            asyncio.run(module.main())

    def test_unknown_profile(self):
        self.reject({"profile": "other", "text": "hello"}, KeyError)

    def test_empty_text(self):
        self.reject({"profile": "sweet-lively", "text": ""}, ValueError)

    def test_large_text(self):
        self.reject({"profile": "sweet-lively", "text": "a" * 1501}, ValueError)

    def test_wrong_type(self):
        self.reject({"profile": "sweet-lively", "text": [1]}, ValueError)


if __name__ == "__main__":
    unittest.main()
