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
