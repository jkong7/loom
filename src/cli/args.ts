export interface CliArgs {
  command: string | null;
  positional: string[];
  print: boolean;
  prompt?: string;
  model?: string;
  outputFormat: 'text' | 'json' | 'stream-json';
  resume?: string | true;
  continue: boolean;
  fork?: string;
  mode?: 'default' | 'acceptEdits' | 'plan' | 'yolo';
  reasoning?: string;
  cwd?: string;
  memory: boolean;
  mcp: boolean;
  maxTurns?: number;
  sandbox?: boolean;
  port?: number;
  host?: string;
  verbose: boolean;
  help: boolean;
  version: boolean;
  systemAppend?: string;
  allow: string[];
  deny: string[];
}

const COMMANDS = new Set(['serve', 'rpc', 'sessions', 'models', 'doctor', 'mcp', 'help', 'version']);

export function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = { command: null, positional: [], print: false, outputFormat: 'text', continue: false, memory: true, mcp: true, verbose: false, help: false, version: false, allow: [], deny: [] };
  const take = (i: number, name: string): string => {
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`${name} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const val = (name: string) => (inline !== undefined ? inline : take(i++, name));
    switch (flag) {
      case '-p':
      case '--print':
        a.print = true;
        if (inline !== undefined) a.prompt = inline;
        break;
      case '-m':
      case '--model':
        a.model = val(flag);
        break;
      case '--output-format':
      case '-o':
        a.outputFormat = val(flag) as CliArgs['outputFormat'];
        break;
      case '--json':
        a.outputFormat = 'json';
        break;
      case '-r':
      case '--resume': {
        const next = inline ?? argv[i + 1];
        if (next && !next.startsWith('-') && inline === undefined && /^[0-9a-f-]{4,}$|\.jsonl$/i.test(next)) {
          a.resume = next;
          i++;
        } else a.resume = inline ?? true;
        break;
      }
      case '-c':
      case '--continue':
        a.continue = true;
        break;
      case '--fork':
        a.fork = val(flag);
        break;
      case '--mode':
      case '--permission-mode':
        a.mode = val(flag) as CliArgs['mode'];
        break;
      case '--yolo':
      case '--dangerously-skip-permissions':
        a.mode = 'yolo';
        break;
      case '--accept-edits':
        a.mode = 'acceptEdits';
        break;
      case '--plan':
        a.mode = 'plan';
        break;
      case '--reasoning':
      case '--effort':
        a.reasoning = val(flag);
        break;
      case '--cwd':
      case '-C':
        a.cwd = val(flag);
        break;
      case '--no-memory':
        a.memory = false;
        break;
      case '--no-mcp':
        a.mcp = false;
        break;
      case '--max-turns':
        a.maxTurns = Number(val(flag));
        break;
      case '--sandbox':
        a.sandbox = true;
        break;
      case '--port':
        a.port = Number(val(flag));
        break;
      case '--host':
        a.host = val(flag);
        break;
      case '--append-system-prompt':
        a.systemAppend = val(flag);
        break;
      case '--allow':
        a.allow.push(val(flag));
        break;
      case '--deny':
        a.deny.push(val(flag));
        break;
      case '-v':
      case '--verbose':
        a.verbose = true;
        break;
      case '-h':
      case '--help':
        a.help = true;
        break;
      case '--version':
        a.version = true;
        break;
      default:
        if (arg.startsWith('-') && arg !== '-') throw new Error(`unknown option ${arg}`);
        if (a.command === null && a.positional.length === 0 && COMMANDS.has(arg)) a.command = arg;
        else a.positional.push(arg);
    }
  }
  if (a.print && a.prompt === undefined && a.positional.length) a.prompt = a.positional.join(' ');
  return a;
}

export const HELP = `loom: a model-agnostic agent harness

Usage
  loom                          interactive session in the current directory
  loom "fix the failing test"   interactive session that starts with a prompt
  loom -p "prompt"              run once and print the answer (headless)
  echo "prompt" | loom -p       prompt from stdin
  loom serve [--port 7433]      HTTP + SSE server for other programs
  loom rpc                      JSON lines over stdin/stdout
  loom sessions                 list sessions for this directory
  loom models                   list known models and providers
  loom doctor                   check providers, engram, MCP and config

Options
  -m, --model <spec>            provider/model or alias (sonnet, opus, gpt-5, gemini, qwen, mock)
  -o, --output-format <f>       text | json | stream-json (print mode)
  -c, --continue                resume the latest session here
  -r, --resume [id]             resume a session by id prefix (or pick the latest)
      --fork <id>               fork a session into a new one
      --mode <m>                default | acceptEdits | plan | yolo
      --accept-edits | --plan | --yolo
      --allow <rule>            allow rule, for example "bash(npm test:*)" or "edit(src/**)"
      --deny <rule>             deny rule
      --reasoning <level>       off | minimal | low | medium | high | xhigh | max
      --max-turns <n>           stop after n model turns
      --sandbox                 run bash in an OS sandbox (Seatbelt on macOS, bubblewrap on Linux)
      --no-memory               do not connect engram
      --no-mcp                  do not start MCP servers
      --append-system-prompt <t>
  -C, --cwd <dir>               working directory
  -v, --verbose                 show thinking and full tool output

Config: ~/.loom/config.json, <repo>/.loom/config.json, <repo>/.loom/config.local.json, <repo>/.mcp.json
Instructions: AGENTS.md, LOOM.md or CLAUDE.md from ~/.loom and from the repo root down to the cwd
Sessions: ~/.loom/sessions/<cwd>/<time>_<id>.jsonl
Environment: ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY, OLLAMA_HOST, LOOM_MODEL, LOOM_HOME, ENGRAM_URL, ENGRAM_BIN`;
