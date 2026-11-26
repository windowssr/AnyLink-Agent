"""One bounded online utterance; input/output are private pipes, never chat logs."""
import asyncio
import base64
import json
import sys
from pathlib import Path

import edge_tts


async def main():
    request = json.loads(sys.stdin.buffer.read(20000))
    profiles = json.loads(Path(__file__).with_name("profiles.json").read_text())
    profile = profiles[request["profile"]]
    text = request["text"]
    if not isinstance(text, str) or not 0 < len(text) <= 1500:
        raise ValueError("utterance_length")
    audio = bytearray()
    async with asyncio.timeout(25) if sys.version_info >= (3, 11) else _timeout():
        async for part in edge_tts.Communicate(text, voice=profile["voice"], rate=profile["rate"], pitch=profile["pitch"]).stream():
            if part["type"] == "audio":
                audio.extend(part["data"])
                if len(audio) > 1024 * 1024:
                    raise ValueError("utterance_size")
    if not audio:
        raise ValueError("no_audio")
    print(json.dumps({"format": "mp3", "audio": base64.b64encode(audio).decode("ascii")}))


class _timeout:
    # Native parent enforces a 30-second deadline on older system Python.
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as error:
        print(type(error).__name__, file=sys.stderr)
        sys.exit(1)
