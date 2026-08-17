# dsh-mimo-worker

A **model-route execution worker** for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Registers a single tool `model_route` that delegates *execution* work — reading files, editing code, running commands, compiling, testing — to a worker sub-agent running on an inexpensive model, and returns a structured report for the main model to review.

> Main model plans and reviews; the worker executes. Built to save tokens and money on long-tail execution tasks.

## How it works

- The tool spawns a DSH sub-agent (`spawn` provider) with its `agentOptions` **forced to the configured worker model** (engine-level override, inherited parent model ignored).
- The worker inherits your agent preset, so it has the full execution toolset (file read/write/edit, shell, background jobs, glob/grep) inside the DSH sandbox. Sub-agent approval is pinned to `never` — it cannot self-approve anything.
- The worker **must** finish by calling `structured_output` with a report:
  ```json
  {
    "status": "done",            // done | partial | blocked
    "summary": "conclusion",
    "changedFiles": ["path/a.js"],
    "evidence": ["test/compile output snippets"],
    "notes": "leftovers or blockers"
  }
  ```
  The main model validates the report (`status` / `changedFiles` / `evidence`) and decides next steps.

## Requirements

- DeepSeek Harness — [installation guide](https://www.npmjs.com/package/@deepseek-ai/dsh)
- Node.js ≥ 22
- A reachable model provider route registered in your DSH `llm-pi-ai` settings (defaults to `meituan/LongCat-2.0`; see Configuration)

## Installation

```bash
# from GitHub
dsh plugin --profile web add github:<your-username>/dsh-mimo-worker

# or copy the folder into your profile's node_modules
#   <your-dsh-profile>\node_modules\dsh-mimo-worker\
```

Then append to `<your-dsh-profile>\cordis.patch.yml`:

```yaml
- insert:
    - id: model-route
      name: 'dsh-mimo-worker'
      config:
        toolName: model_route
        providerName: spawn
        provider: meituan
        model: LongCat-2.0
        maxTokens: 8192
        maxDepth: 3
        labelPrefix: model_route
        toolFilter:
          deny:
            - subagent
            - subagent_fork
            - workflow
            - model_route
            - ask_user_question
```

Restart DSH, then ask the main model to run a task through `model_route` (e.g. "use the model route to run `node --version`").

## Usage

```
model_route(task="...", context="optional background", run_in_background=false)
```

- **Foreground** (default): waits for the worker and returns the structured report.
- **Background**: `run_in_background: true` returns a job id; collect with `job_output`, stop with `job_kill` (good for long builds/tests).

## Configuration

| Key | Default | Description |
|---|---|---|
| `toolName` | `model_route` | tool name exposed to the main model |
| `providerName` | `spawn` | `ctx.subagents` provider (spawn supports outputSchema/persona/toolFilter/depthLimit) |
| `provider` | `meituan` | worker model provider route |
| `model` | `LongCat-2.0` | worker model id — switch model by changing `provider` + `model` |
| `maxTokens` | `8192` | per-request output cap (match to the model's max output) |
| `maxDepth` | `3` | sub-agent recursion cap |
| `labelPrefix` | `model_route` | task label prefix |
| `toolFilter` | deny delegation/asking tools | worker tool allow/deny filter (e.g. add `allow`/`deny` lists) |
| `persona` | built-in execution persona | worker system prompt override |

Example switch to Xiaomi MiMo:

```yaml
provider: xiaomi
model: mimo-v2.5
maxTokens: 32768
```

## Notes

- Zero third-party dependencies: uses only DSH host services (`tools` / `subagents` / `jobs`).
- The web-search / other provider routes are untouched.
- Keep in mind the worker model's output cap (e.g. LongCat-2.0 is 8192 tokens): split long tasks or switch to a larger model for big outputs.

## License

MIT