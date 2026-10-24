# Stats Explorer + Jev

**Stats Explorer computes and Jev checks.** Stats Explorer produces every number: tests, effect sizes, confidence intervals, summaries, charts and reports. [Jev](https://docs.typesafe.ai/introduction/quickstart) is TypeSafe's "System One" model. It answers typed yes/no questions with a probability in well under a second, and it never writes text or computes numbers. Together they cover the two places an AI assistant goes wrong in data work: picking the wrong analysis, and describing the result wrongly.

| Checkpoint | When | What Jev is asked | What Stats Explorer checks itself |
|---|---|---|---|
| `plan` (on by default) | Step 1 of a hypothesis test, after you confirm the choices and before anything is computed | Does the test fit the question? Do H₀/H₁ state the question, in the right direction? Are these the columns the question is about? | Column types, group names, test arguments (as always) |
| `conclusions` (on by default) | `check_conclusions`, before the assistant presents findings or puts them in a report | Is each claim supported by the computed results, without overstating them? | Every number in a claim appears in the results (allowing for the rounding shown); "significant" / "not significant" matches p and α; causal or "proves" wording is flagged |
| `data` (opt-in) | Before any tool reads a file | Does any column name or text value contain instructions aimed at an AI (prompt injection)? | Obvious injection phrases |

**What Jev sees.** The `plan` and `conclusions` checkpoints send only the question, the plan, column names and types, and the computed summary results. Raw rows are never sent. The `data` checkpoint also sends column names and up to 20 distinct text values per column, which is why it's opt-in. Check your data-handling rules before you turn it on.

**Turning probabilities into decisions.** Stats Explorer applies fixed thresholds, so the same answer always gives the same outcome:

| Jev's probability that the item is fine | Outcome |
|---|---|
| at least 0.8 (`STATS_EXPLORER_JEV_PASS_AT`) | pass |
| below 0.5 (`STATS_EXPLORER_JEV_FAIL_BELOW`) | fail |
| in between | review |

Stats Explorer's own checks can lower a result but never raise it. A claim with a wrong p-value fails even if Jev liked it.

## Three ways to run it

### 1. Cooperate: no orchestrator needed

Connect both MCP servers to Claude or Copilot. Stats Explorer doesn't call Jev itself. At each checkpoint it answers **JEV CHECK NEEDED** with a packet in the shapes the common Jev MCP servers take:

- `propositions` and `context` for `jev_noul` or `check`
- `claims` and `evidence` for `jev_verify` or `verify`
- `text` and `purpose` for `jev_screen`
- `state` and `questions` for `evaluate`

The assistant calls the Jev tool, reports the answers with `record_verification`, and repeats the call. The checkpoint waits until then (`STATS_EXPLORER_JEV_REQUIRE=off` turns waiting off). If no Jev server is connected, the assistant tells you, and goes on only if you accept. That acceptance is recorded as an override.

In this mode the assistant relays Jev's answer, so the report labels it "Jev, as reported by the AI assistant". For a check the assistant can't skip or alter, use enforce or orchestrated.

**Claude Code** (any Jev MCP server works; `@jkudish/jev-mcp` is shown):

```bash
claude mcp add jev -e TYPESAFE_API_KEY=YOUR_KEY -- npx -y @jkudish/jev-mcp
claude mcp add stats-explorer -e STATS_EXPLORER_JEV=cooperate -e STATS_EXPLORER_CONFIRM_VIA=chat -- npx -y stats-explorer-mcp
npx -y stats-explorer-mcp init-jev    # writes the routing section into CLAUDE.md and .github/copilot-instructions.md
```

**VS Code (Copilot)**: install the Stats Explorer extension, set **Stats Explorer › Jev: Mode** to `cooperate`, and add your Jev server in `.vscode/mcp.json`:

```json
{
  "inputs": [{ "type": "promptString", "id": "typesafe-key", "description": "TypeSafe API key", "password": true }],
  "servers": {
    "jev": { "type": "stdio", "command": "npx", "args": ["-y", "@jkudish/jev-mcp"], "env": { "TYPESAFE_API_KEY": "${input:typesafe-key}" } }
  }
}
```

Then run **Stats Explorer: Add Jev Routing Instructions to This Workspace**.

### 2. Enforce: Stats Explorer calls Jev itself

Set `STATS_EXPLORER_JEV=enforce` and give Stats Explorer its own `TYPESAFE_API_KEY`. At each checkpoint it calls `POST https://api.typesafe.ai/v1/systemone` directly. The assistant can't skip the check, change the questions, or report a different answer, and `record_verification` refuses answers from it. Results then come back in one of three forms:

- **Pass:** the tool carries on.
- **Review or fail:** the tool answers **BLOCKED BY JEV CHECK** with the reasons.
- **Jev unreachable:** the checkpoint is blocked (fail closed). With `STATS_EXPLORER_JEV_ON_ERROR=warn`, only Stats Explorer's own checks run and the result says so.

In VS Code, set **Jev: Mode** to `enforce` and run **Stats Explorer: Set TypeSafe API Key**. The key is kept in VS Code's secret storage, not in settings.json. With Claude Code:

```bash
claude mcp add stats-explorer -e STATS_EXPLORER_JEV=enforce -e TYPESAFE_API_KEY=YOUR_KEY -e STATS_EXPLORER_CONFIRM_VIA=chat -- npx -y stats-explorer-mcp
```

You can still connect a Jev MCP server for other jobs. Stats Explorer's checkpoints don't depend on it.

### 3. Orchestrated: production pipelines

Orchestrated mode is for running Stats Explorer inside LangGraph, Temporal, Airflow, n8n, AWS Step Functions or Bedrock AgentCore, or your own service. Set `STATS_EXPLORER_JEV=orchestrated` and `STATS_EXPLORER_APPROVAL_SECRET` (at least 32 random characters, shared only with the orchestrator). Each checkpoint then works like this:

1. The tool returns `status: "needs_approval"` with `data.jev_packet`.
2. The orchestrator evaluates the packet with Jev, its own policy, or a human review queue.
3. It signs its decision and calls `record_verification` with `approval`.
4. It repeats the tool call.

Answers or overrides that aren't signed are refused, so the AI model can't approve itself. Each approval is tied to one packet, expires after 10 minutes by default, and works only once.

Token format: `base64url(payload) + "." + base64url(HMAC-SHA256(secret, base64url(payload)))`, where the payload is `{ "packet_id", "overall": "pass" | "review" | "fail", "items": [{ "id", "probability" | "outcome" }], "exp": unix seconds, "nonce", "by" }`.

JavaScript:

```js
import { signApproval } from 'stats-explorer-mcp/jev';
const approval = signApproval(process.env.STATS_EXPLORER_APPROVAL_SECRET, { packet_id, overall: 'pass', items, by: 'my-policy' });
```

Python (LangGraph or any other orchestrator):

```python
import base64, hashlib, hmac, json, os, secrets, time
def b64u(b): return base64.urlsafe_b64encode(b).rstrip(b"=").decode()
def sign_approval(packet_id, overall, items, by="langgraph-policy"):
    body = b64u(json.dumps({"packet_id": packet_id, "overall": overall, "items": items, "by": by,
                            "exp": int(time.time()) + 600, "nonce": secrets.token_hex(12)}).encode())
    sig = hmac.new(os.environ["STATS_EXPLORER_APPROVAL_SECRET"].encode(), body.encode(), hashlib.sha256).digest()
    return f"{body}.{b64u(sig)}"
```

A complete runnable example is `examples/orchestrator/pipeline.mjs`. It starts Stats Explorer, runs a hypothesis-test job from `job.json`, checks the data, plan and conclusions with Jev, signs each decision, and saves a report with an "Independent checks" section. Use `--dry-run` to try it without a TypeSafe key:

```bash
node examples/orchestrator/pipeline.mjs examples/orchestrator/job.json --dry-run
```

When the orchestrator sits between an LLM agent and the MCP servers, intercept tool results whose `status` is `needs_approval`, handle them as above, and pass the repeated result back to the agent.

## Audit trail

Set `STATS_EXPLORER_AUDIT_LOG=/path/audit.jsonl` and every checkpoint decision is appended as one JSON line. Each line records the time, mode, checkpoint, packet id, outcome per item, the source (Jev API, the assistant, orchestrator or user override), the model and the tool. Data values, API keys and secrets are never written to it.

Reports built with `build_report` get an **Independent checks** section for the analyses they include. With `conclusions_check`, they open with **Key findings**: only the assistant's claims that passed.

## All settings

| Variable | Default | Meaning |
|---|---|---|
| `STATS_EXPLORER_JEV` | `off` | `cooperate`, `enforce` or `orchestrated` |
| `STATS_EXPLORER_JEV_CHECKPOINTS` | `plan,conclusions` | Any of `plan`, `conclusions`, `data` (or `all`) |
| `STATS_EXPLORER_JEV_REQUIRE` | `on` | Cooperate mode: checkpoints wait for Jev's answer |
| `STATS_EXPLORER_JEV_PASS_AT` / `_FAIL_BELOW` | `0.8` / `0.5` | Decision thresholds |
| `STATS_EXPLORER_JEV_ON_ERROR` | `block` | Enforce mode when the API can't be reached: `block` or `warn` |
| `STATS_EXPLORER_JEV_ALLOW_OVERRIDE` | `on` | Whether the user may go ahead despite a flagged check (always off in orchestrated mode) |
| `STATS_EXPLORER_AUDIT_LOG` | none | JSON Lines audit file |
| `TYPESAFE_API_KEY` | none | Enforce mode |
| `TYPESAFE_BASE_URL` / `TYPESAFE_MODEL` / `TYPESAFE_TIMEOUT_SECONDS` / `TYPESAFE_MAX_RETRIES` | `https://api.typesafe.ai` / `jev-latest` / `10` / `2` | Enforce mode |
| `STATS_EXPLORER_APPROVAL_SECRET` | none | Orchestrated mode (32 characters or more) |

## Limits

Jev's probabilities come from a model. They're a strong second opinion, not proof, and TypeSafe hasn't published a calibration curve, so tune the thresholds on your own analyses. In cooperate mode the check depends on the assistant relaying it honestly. Use enforce or orchestrated mode when that matters.

## Measuring how well Jev does

Before you rely on Jev (or advertise that it checks the work), measure it on your own key:

```bash
TYPESAFE_API_KEY=YOUR_KEY npm run jev:eval            # PowerShell: $env:TYPESAFE_API_KEY="YOUR_KEY"; npm run jev:eval
npm run jev:eval -- --repeat 3                       # ask each case 3 times to see how stable the answers are
npm run jev:eval -- --dry-run                        # no key: what Stats Explorer's own checks catch by themselves
```

The script sends Jev the exact packets the server sends at the `plan` and `conclusions` checkpoints, for 45 labeled cases built from real results on the bundled files: 20 test plans (right and wrong tests, swapped or one-sided hypotheses nobody asked for, unrelated columns, an A/B test on the wrong metric or arm) and 25 written claims (correct ones, wrong numbers, significance stated the wrong way round, causal or "proves" wording, a non-significant variant called the winner, Tukey pairs). It writes `jev-eval-report.md` and `.json` with, for Jev alone and combined with Stats Explorer's own checks:

| Measure | Meaning | Good |
|---|---|---|
| False approval | a bad plan or claim that passed: the error that matters | ≤ 5% combined |
| False alarm | a fine plan or claim that was flagged | ≤ 25% |
| AUC | how often Jev scores a good item above a bad one | ≥ 0.9 |
| Brier score | calibration of the probabilities (0 is perfect) | lower is better |
| Latency | median and 95th percentile per call | |

The report ends with a verdict (good / advisory / not reliable yet) and every item the combined check got wrong. Without a key, the dry run shows the baseline: Stats Explorer's own checks catch about two thirds of the bad conclusions (wrong numbers, wrong significance, causal wording) with no false alarms, and none of the bad plans. Judging plans is the part only Jev adds.

If the result is "advisory", raise `STATS_EXPLORER_JEV_PASS_AT` (e.g. 0.9) and run it again: fewer bad items pass, at the cost of more reviews.
