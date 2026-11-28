# `anylink-agent` (Python SDK)

Official Python SDK for **AnyLink Protocol v3** — connect any Python script, Linux server, LangGraph/CrewAI/AutoGen workflow, or personal assistant into a shared-memory Personal Agent Network.

## Installation

```bash
pip install anylink-agent
# or from local repo checkout:
uv pip install -e ./sdk-python
```

## Quickstart

```python
import asyncio
import os
from anylink import AnyLinkAgent, AnyLinkClient, TaskContext, TaskDeclined


async def main() -> None:
    joined = await AnyLinkClient.connect(
        base_url=os.environ["ANYLINK_BASE_URL"],
        join_key=os.environ["ANYLINK_JOIN_KEY"],
        install_id="linux-gpu-box-01",
        device_name="GPU Server",
        platform="linux",
        agent_key="gpu-worker",
        agent_name="GPU Agent",
        summary="Runs local ML jobs and inspects GPU utilization",
    )

    async with AnyLinkClient(os.environ["ANYLINK_BASE_URL"], joined["token"]) as client:
        # 1. Assemble relevant cross-device memory & learned device boundaries
        mem = await client.assemble_memory(query="Which repo am I working on?")
        print(mem["summary_text"])

        # 2. Call Cloud Model Gateway (optional auto-memory injection + turn ingestion)
        reply = await client.chat_completions(
            model="default",
            messages=[{"role": "user", "content": "Summarize my active project"}],
            auto_memory=True,
        )
        print(reply["choices"][0]["message"]["content"])

        # 3. Run an autonomous edge node over real-time WebSocket
        agent = AnyLinkAgent(client, journal_path="./private-state/journal.jsonl")

        @agent.on_invoke
        async def handle(task: dict, ctx: TaskContext):
            instruction = task.get("instruction") or ""
            if "wechat" in instruction.lower():
                raise TaskDeclined("UNSUPPORTED", "This Linux server cannot access WeChat")
            await ctx.report_progress(stage="running", message="Working...", percent=50)
            return {"reply": f"Completed on GPU Server: {instruction}"}

        await agent.run()


asyncio.run(main())
```

## Build and publish

Run from the repository root with Python 3.10+ (the commands below select Python 3.12):

```bash
uv run --project sdk-python --python 3.12 --extra dev pytest sdk-python/tests
uv build sdk-python --python 3.12 --out-dir artifacts/pypi/0.9.3
uvx --python 3.12 twine check artifacts/pypi/0.9.3/*.whl artifacts/pypi/0.9.3/*.tar.gz
```

For a manual upload, use the PyPI account that owns this project, with a verified email and two-factor authentication. Create a token scoped to `anylink-agent` in your account settings, and enter it at the hidden password prompt:

```bash
uvx --python 3.12 twine upload --username __token__ artifacts/pypi/0.9.3/*.whl artifacts/pypi/0.9.3/*.tar.gz
```

Upload only the Python wheel and source archive. Keep `pyproject.toml`, `anylink.__version__`, and the local project's version in `uv.lock` consistent. Future releases need a new version; SDK versions are managed separately from Android preview tags.

## GitHub Actions Trusted Publishing

The repository's [publish-python.yml](../.github/workflows/publish-python.yml) tests Python 3.10, 3.12 and 3.13, builds the wheel and source archive, validates their metadata/content, and imports the built wheel in an isolated environment. Main-branch pushes, pull requests and manual workflow runs perform verification only. Publishing runs only for a pushed `python-v*` tag that exactly matches the SDK version, such as `python-v0.9.3`.

The publishing job downloads the verified distributions and uses short-lived OIDC credentials; no PyPI API token is stored in GitHub. GitHub's environment must be named `pypi`.

The `anylink-agent` project already exists on PyPI. Sign in as its owner, open [Your projects](https://pypi.org/manage/projects/), choose **Manage** for `anylink-agent`, then open **Publishing** in that project's sidebar. Add a GitHub publisher with these exact values:

- Owner: `windowssr` (the GitHub repository owner)
- Repository name: `AnyLink-Agent`
- Workflow filename: `publish-python.yml` (the basename, not the display name)
- Environment name: `pypi`

After adding the publisher, commit the intended SDK source and workflow, then push its SDK tag:

```bash
git tag -a python-v0.9.3 -m "Python SDK 0.9.3"
git push origin python-v0.9.3
git push github python-v0.9.3
```

Bind the publisher to the existing `anylink-agent` project. Account-level pending publishers are for creating a new project. Subsequent versions reuse the project publisher and get their own `python-v<version>` tag; published version files cannot be replaced. See [PyPI's official guide](https://docs.pypi.org/trusted-publishers/adding-a-publisher/).

## Releases

- **0.9.3**: Updates package installation and project publisher instructions, and releases through the SDK-specific Trusted Publishing workflow. The SDK runtime API is unchanged from 0.9.2.
- **0.9.2**: Initial PyPI distribution of the AnyLink Python SDK.
