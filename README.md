# loom

A reusable, model-agnostic agent harness. Use it as a library (agent loop, tools, context manager, session store, provider layer, memory interface) or as the `loom` command, which comes with a terminal UI, a headless print mode and an HTTP server. It works with Anthropic, OpenAI (Responses and Chat Completions), Google Gemini, OpenRouter and any OpenAI-compatible server (Ollama, LM Studio, vLLM, Groq, DeepSeek, xAI). Durable memory comes from [engram](../engram) through a pluggable `MemoryProvider` interface.

It runs on Node 23.6 or later with TypeScript type stripping, so there is no build step. Its only dependencies are dev ones (`typescript`, `@types/node`).

```
npm install
node bin/loom.js doctor
node bin/loom.js -m ollama/qwen3:8b "explain this repo"
```

To get a `loom` command, link it (`npm link`) or add an alias: `alias loom="node ~/dev/loom/bin/loom.js"`.

## Why it looks the way it does

The design is the result of teardowns of twelve harnesses (Claude Code, Codex CLI, OpenCode, Pi, Hermes Agent, Letta Code, Gemini CLI, Goose, Aider, OpenClaw, Amp, Cursor). The notes are in `~/dev/research_notes/Agent harnesses/`, and `00-synthesis.md` there has the comparison tables and design lessons. These lessons shaped the code most:

- **The prompt is an append-only log.** The system prompt and tool list are frozen when a session starts. Per-turn context (memory recall, hook context) is stored inside the user message it belongs to and replayed byte for byte on later requests. History is never edited between requests. This keeps the provider prompt cache warm and keeps Anthropic's preserved-thinking signatures valid. History is only rewritten at explicit boundaries (pruning, compaction), and then the thinking blocks before the boundary are removed.
- **Providers are data.** There is one normalized message, tool-call and stream-event model. Each wire protocol (`anthropic-messages`, `openai-responses`, `openai-chat`, `google-generative`) has one adapter. Each model is a registry entry with capability flags and `compat` quirks, so adding a vendor does not mean writing a new adapter.
- **Memory is a lifecycle, not a tool.** It follows the Hermes `MemoryProvider` shape: a frozen digest at session start, recall on each turn, an ordered write queue after each turn, a flush before compaction, a re-injection after it, and a final flush at session end.
- **Hooks intercept, not just observe.** They use Claude Code's event names and JSON shapes, so existing hook scripts and engram's hook adapter work unchanged.

## Architecture

```
            +-----------------------------------------------------------+
  cli/      |  loom (TUI)   loom -p (text/json/stream-json)   loom rpc     |
  server/   |  loom serve (HTTP + SSE, remote permission approval)       |
            +------------------------------+----------------------------+
                                           |
  runtime.ts  Runtime: config layers, model registry, tools, MCP, skills,
              subagents, plugins, memory providers -> createAgent()
                                           |
  agent/    Agent loop -------- HookBus (SessionStart ... SessionEnd)
            |  context: prompt.ts (cache-ordered system blocks),
            |           instructions.ts (AGENTS.md / LOOM.md / CLAUDE.md),
            |           compaction.ts (prune, summarize, keep tail)
            |  tools:   tool.ts registry, schema validation, permissions.ts
            |  session.ts JSONL tree: resume, rewind, fork
            |
  memory/   MemoryManager -> EngramProvider (REST -> CLI -> spool; MCP tools)
  tools/    read, write, edit, bash (+ Seatbelt), grep, glob, fetch
  mcp/      MCP client (stdio, Streamable HTTP) -> mcp__server__tool
  ai/       types.ts normalized model, registry.ts, providers/*, transform.ts
```

Dependencies only point downward: `ai/` knows nothing about agents, and `agent/` knows nothing about the CLI. Anything below `runtime.ts` can be embedded on its own.

### The turn lifecycle

1. The `UserPromptSubmit` hooks run. They can block the prompt or add context.
2. `memory.prefetch(prompt)` returns recall fenced as `<memory-context>`. It becomes the first block of the user message (`meta: "memory"`), followed by any hook context as `<system-reminder>` blocks, and then the user's own text. All of it is persisted.
3. The turn loop starts. If the context is over the compaction threshold, loom prunes or compacts first (see below). It then streams one model call with the frozen system prompt and tools plus the session's context messages, and persists the assistant message.
4. Tool calls run in the order the model made them. Consecutive concurrency-safe calls (reads, searches, subagents, read-only MCP tools) run in parallel batches of up to 10; anything that changes state runs alone. Each call goes through argument validation, then the `PreToolUse` hooks (which can deny, allow or rewrite the input), then the permission policy, then execution, then output truncation (head and tail, with the full output spilled to a file), then the `PostToolUse` hooks. Results are appended in call order.
5. Steering messages typed during the run are appended after the tool batch, and the loop continues.
6. Tool calls from a response that hit `max_tokens` are never executed; the model gets an error and retries smaller. A third identical call triggers a loop warning. A context-overflow error compacts the context and retries once.
7. With no tool calls left, the `Stop` hook can send the model back to work (up to 3 times). After that, `memory.syncTurn` is queued and the run ends. Queued follow-ups run next.

### Context engineering

The system prompt has two blocks: a stable block (the base prompt, any appended prompt, the environment, instruction files, the subagent index, the skill index, plugin text, MCP server instructions) and the memory digest block. The cache breakpoint sits on the last of them. Anthropic requests also mark the last tool and the last two user messages. OpenAI requests send `prompt_cache_key` set to the session id.

Instruction files come from `~/.loom/AGENTS.md`, then from every directory between the git root and the cwd. In each directory loom takes the first of `AGENTS.md`, `LOOM.md` or `CLAUDE.md`, plus `AGENTS.local.md`. An `@path` import on its own line pulls in another file.

Compaction is triggered at `min(contextWindow * 0.85, contextWindow - 16384)`. Token counts use the provider's reported usage plus an estimate for anything appended since.

1. **Prune first.** If removing tool outputs older than the newest 40k tokens frees at least 20k tokens, loom writes a `prune` entry. Those outputs are replaced by a marker, and the thinking blocks before the prune point are stripped.
2. **Otherwise compact.** The `PreCompact` hook runs and the memory providers flush. A structured checkpoint summary is written (Goal, Constraints and preferences, Progress, Key decisions, Files and code, Errors and fixes, Next steps, Durable facts). It is merged with any earlier summary and can run on `smallModel`. The newest turns (about 20k tokens, cut on a user-message boundary so a tool call is never separated from its result) are kept verbatim with their thinking blocks removed. Then the `PostCompact` and `SessionStart(source=compact)` hooks run, the memory digest is refreshed, and the system prompt is rebuilt once.

### Sessions

Sessions are stored at `~/.loom/sessions/<encoded-cwd>/<iso-time>_<session-id>.jsonl`. Line 1 is the header (`type: "session"`, `session_id`, `cwd`, `harness: "loom"`, `model`, and `parent_session_id` or `forked_from` where relevant). Every later line is an entry with `id` and `parentId`, so the file is a tree:

```json
{"type":"message","id":"a1b2c3","parentId":"f00ba4","ts":"2026-10-08T00:52:47.275Z","session_id":"...","cwd":"/Users/me/proj","role":"user","text":"fix the test","message":{"role":"user","content":[...],"ts":1791334367275}}
```

`role`, `text`, `ts`, `session_id` and `cwd` are top-level fields, so other tools (engram's transcript scanner among them) can read the file without knowing loom's message model. `text` leaves out recalled memory and hook context. The file also records `compaction`, `prune`, `model_change` and `label` entries.

- Resume: `loom -c` picks up the latest session in this directory, and `loom -r <id-prefix>` a specific one. The last model used comes back with it.
- Fork: `loom --fork <id>` or `/fork` copies the active branch into a new file that records `forked_from`. `Session.rewindTo(entryId)` branches inside the same file.
- Subagent runs are separate session files that carry `parent_session_id`.

## Providers and models

| Provider id | Protocol | Key |
|---|---|---|
| `anthropic` | Messages API: adaptive thinking with `output_config.effort` on Claude 4.6 and later, budgets on older models, signatures replayed, `cache_control` | `ANTHROPIC_API_KEY` |
| `openai` | Responses API with `store: false`; encrypted reasoning items replayed | `OPENAI_API_KEY` |
| `openai-chat` | Chat Completions | `OPENAI_API_KEY` |
| `google` | Gemini `streamGenerateContent` with SSE; `thoughtSignature` replayed; `parametersJsonSchema` | `GEMINI_API_KEY` or `GOOGLE_API_KEY` |
| `openrouter`, `groq`, `deepseek`, `xai` | Chat Completions | `<NAME>_API_KEY` |
| `ollama`, `lmstudio`, `vllm` | Chat Completions; `<think>` tags and `reasoning` fields become thinking | none (`OLLAMA_HOST`, `LMSTUDIO_BASE_URL`, `VLLM_BASE_URL`) |
| `mock` | Deterministic scripted provider for tests | none |

Models are named `provider/model`. Any model id works on a known provider; unlisted ids get that provider's default capabilities. Aliases: `opus`, `sonnet`, `haiku`, `fable`, `gpt`, `codex`, `gemini`, `flash`, `qwen`, `mock`. Run `loom models` to see the registry. When moving history between providers, loom drops thinking that belongs to another model, rewrites tool-call ids to fit the target's format, adds an error result for any tool call left without one, drops errored or aborted turns, and replaces images with a placeholder for text-only models.

Add providers and models in config, or from a plugin with `registerProvider` and `registerApi` for an entirely new wire protocol.

## Memory and engram

`MemoryProvider` (`src/memory/provider.ts`) is the extension point:

| Method | Called |
|---|---|
| `isAvailable()` | at session start, before `initialize` |
| `initialize(info)` | once per session (`source`: startup, resume, fork, compact, clear; `agentContext`: primary, subagent, headless) |
| `systemPromptBlock()` | at session start and after each compaction; frozen in between |
| `prefetch(query)` | each user prompt that is not trivial, with a 4 s timeout; fenced as `<memory-context>` |
| `syncTurn(turn)` | after each completed top-level turn, on an ordered background queue |
| `onPreCompress(event)` | before compaction, after the queue is drained; returned notes go into the summary prompt |
| `onPostCompress(summary)` | after compaction; the digest is rebuilt |
| `onSessionSwitch`, `onDelegation` | on session switches and when a subagent finishes |
| `onSessionEnd(messages, reason)` | at close, after the queue is drained |
| `tools()` | registered into the tool registry at session start |
| `shutdown()` | at runtime close |

`EngramProvider` turns this lifecycle into engram's contract using harness name `loom`:

| loom lifecycle | engram call |
|---|---|
| session start, resume, fork | `POST /v1/hooks/loom/SessionStart` (`source`); the `additionalContext` digest becomes the frozen system block |
| each prompt | `POST /v1/hooks/loom/UserPromptSubmit` (`prompt`); the `<memory-context>` recall goes into the user turn |
| turn end | `POST /v1/hooks/loom/Stop` (`prompt`, `last_assistant_message`, `transcript_path`) |
| before compaction | `POST /v1/ingest` with the user and assistant turns, then `POST /v1/hooks/loom/PreCompact` |
| after compaction | `POST /v1/hooks/loom/PostCompact` (`compact_summary`), then `SessionStart` with `source=compact` to refresh the digest |
| session end | `POST /v1/hooks/loom/SessionEnd` (`reason`) |
| memory tools | `memory_context`, `memory_search`, `memory_get`, `memory_write`, `memory_update` and `memory_forget`, proxied from engram's MCP server so engram owns their schemas |

Every payload carries `session_id`, `transcript_path`, `cwd`, `hook_event_name` and `model`, which is the Claude Code shape engram's adapter already reads. Fallbacks, in order:

1. REST on `ENGRAM_URL` (default `http://127.0.0.1:7432`) with the bearer token from `~/.engram/token`. After a failure loom tries REST again after 30 s.
2. `engram hook loom <Event>` with the JSON on stdin (from `ENGRAM_BIN` or `engram` on `PATH`). The CLI tries the daemon and then writes to the SQLite store directly.
3. An append to `~/.engram/spool/<date>.jsonl` in the daemon's replay format.

The memory tools come from MCP over HTTP (`/mcp`) when it answers, otherwise `engram mcp` over stdio, otherwise the REST endpoints. As a last-resort write path, engram's transcript scanner reads `~/.loom/sessions` directly.

Subagents get no memory tools and send no writes. Turn off memory with `--no-memory` or `"memory": {"provider": "none"}`.

## Tools, permissions and sandboxing

Built-in tools are `read` (numbered lines, paging, images), `edit` (exact replace or several edits applied atomically; requires an earlier read and fails if the file changed on disk since), `write`, `bash` (timeouts, kills the whole process group, `run_in_background` together with `bash_output` and `bash_kill`), `grep` (ripgrep, with a JS fallback), `glob`, `fetch`, `task` (subagents) and `skill`, plus MCP and memory tools.

Each tool has a kind: read, edit, execute, network, mcp, agent, memory or other. The policy checks in this order:

1. deny rules
2. plan mode (read only)
3. ask rules
4. allow rules, plus anything approved "always" this session
5. yolo mode
6. the defaults for the tool's kind:
   - read, agent and memory tools are allowed, except `memory_forget`, which asks
   - edits ask, or are allowed in `acceptEdits` mode when inside the cwd or the temp dir
   - commands ask, unless they are recognized as read-only (`ls`, `git status`, `rg` and the like, with no redirects or chaining)
   - everything else asks

Rules look like `bash(npm test:*)`, `edit(src/**)`, `mcp__github__*` or `kind:network`. With no approver attached (print mode, server mode with no client) a call that would ask is denied, and the model is told why. `--sandbox` (or `"sandbox": {"mode": "seatbelt"}`) runs every bash command under macOS `sandbox-exec`, which blocks writes outside the cwd and temp dirs and can block outbound network.

## Hooks, skills, subagents, plugins, MCP

- **Hooks**: Claude Code's event names (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`, `PreCompact`, `PostCompact`, `SessionEnd`) and its config shape (`matcher` plus a list of `command` or `http` hooks). A command hook gets JSON on stdin; exit code 2 blocks, and stdout JSON can carry `decision`, `hookSpecificOutput.additionalContext`, `permissionDecision` or `updatedInput`. HTTP hooks POST the same JSON, and headers expand `${VAR}` and `${file:~/path}`. Every hook input includes `harness: "loom"`.
- **Skills**: `SKILL.md` folders under `~/.loom/skills`, `.loom/skills`, `.agents/skills` and `.claude/skills`, plus any configured paths. The system prompt lists only each skill's name and description; the `skill` tool loads the body and lists the skill's files when the model needs them.
- **Subagents**: `task` runs a child agent with a fresh context, its own session file, a filtered tool set, an optional model, and a depth limit of 2. Built-in agents are `general` and `explore` (read only). Add your own as Markdown files with frontmatter (`name`, `description`, `tools`, `model`, `reasoning`) in `~/.loom/agents` or `.loom/agents`.
- **Plugins**: a `.ts` or `.js` module in `~/.loom/plugins` or `.loom/plugins`, or listed under `plugins`, that exports `default (api) => {}`. The `api` object offers `registerTool`, `on(event, handler)`, `registerProvider`, `registerApi`, `registerModel`, `registerMemoryProvider` and `addSystemPrompt`. See `examples/plugin.ts`.
- **MCP**: `mcpServers` in config or in a Claude-style `.mcp.json`, over stdio or Streamable HTTP. Tools are registered as `mcp__<server>__<tool>`, and server `instructions` go into the system prompt.

## Configuration

loom merges `~/.loom/config.json`, then `<repo>/.loom/config.json`, then `<repo>/.loom/config.local.json`, and then CLI flags. Permission rules, plugins and hook lists are concatenated across layers; scalar values override. `examples/config.json` shows every section.

## Modes

```
loom                                   interactive TUI (/help for slash commands; typing during a run steers it)
loom -p "prompt" [-o text|json|stream-json]
loom -c -p "and now the tests"         continue the latest session headlessly
loom serve --port 7433                 HTTP API, see below
loom rpc                               JSON lines: {"type":"prompt","text":"..."}, steer, abort, compact, permission_response
loom doctor | models | sessions | mcp
```

HTTP API (bind 127.0.0.1; set `LOOM_SERVER_TOKEN` to require a bearer token):

| Endpoint | Purpose |
|---|---|
| `POST /sessions` | create, resume or fork a session (`{model, resume, fork}`) |
| `POST /sessions/:id/prompt` | SSE stream of `text_delta`, `tool_use`, `tool_result`, `assistant`, `permission_request`, ending in `result`; send `{"stream": false}` for a single JSON reply |
| `POST /sessions/:id/steer`, `/abort`, `/compact` | control a running session |
| `GET /sessions/:id`, `GET /sessions/:id/events` | transcript, or a live event stream |
| `GET /permissions`, `POST /permissions/:id` | answer a pending approval (`{"answer":"allow"}`, `"deny"` or `"always"`) |
| `GET /models`, `GET /sessions`, `GET /health` | listings |

## Embedding

```ts
import { Runtime } from 'loom-agent';

const rt = await Runtime.create({ cwd: '/path/to/repo', model: 'anthropic/claude-sonnet-5-5', mode: 'acceptEdits' });
const agent = await rt.createAgent();
agent.subscribe((e) => e.type === 'message_update' && e.event.type === 'text_delta' && process.stdout.write(e.event.delta));
const result = await agent.prompt('Add a test for the date parser');
await rt.close();
```

The pieces work separately as well: `stream()` and `complete()` from `loom-agent/ai` give you just the provider layer. `new Agent({...})` takes your own `ToolRegistry`, `PermissionPolicy`, `HookBus`, `Session` and `MemoryManager`. See `examples/embed.ts`, which has a custom tool and a custom memory provider.

## Tests

```
npm test            unit, integration and end-to-end tests (node:test)
npm run typecheck
```

The suite covers:

- every provider adapter, against recorded-shape SSE served by a local HTTP server
- cross-provider history transforms
- the loop (parallel batching, hooks, steering, permissions, truncation, loop warnings, aborts, overflow recovery)
- compaction and pruning, sessions (resume, rewind, fork) and instruction loading
- the tools, including a real Seatbelt check, and MCP over stdio and HTTP
- the engram provider, three ways: against a fake daemon, with only the spool available, and against the real engram daemon and CLI from `~/dev/engram` (skipped when that checkout is missing)
- skills, subagents, plugins, config layering, the HTTP server and RPC, and CLI processes
- a real Ollama run (skipped when Ollama or the model is missing; `LOOM_OLLAMA_MODEL` overrides the default `qwen3:8b`)

## Limits and next steps

- The model registry is hand-maintained. Prices and limits for non-Anthropic models are best effort, so check them before relying on cost numbers.
- There is no Linux sandbox yet (bubblewrap or landlock), and no network allowlist proxy.
- The TUI is readline-based: no diff view, no syntax highlighting, no multi-pane layout.
- There are no git snapshots for undo; rewind only moves the conversation.
- Gemini `thoughtSignature` on plain text parts is stored as an empty thinking block. That works, but it is not byte-for-byte what Gemini returned.
- The text tool-call shim (used automatically when a model has `tools: false`, or with `compat.toolShim`) has been checked on qwen3:8b only. Weaker models may need a stricter output format.
