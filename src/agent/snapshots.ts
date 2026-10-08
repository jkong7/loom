import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { encodeCwd } from './session.ts';

const EXCLUDES = ['node_modules/', '.git/', '.loom/', 'dist/', 'build/', '.next/', '.venv/', 'venv/', '__pycache__/', '*.log', '.DS_Store', 'target/', 'coverage/'];

export class Snapshots {
  readonly cwd: string;
  readonly gitDir: string;
  private ready = false;
  disabledReason?: string;

  constructor(cwd: string, root: string) {
    this.cwd = resolve(cwd);
    this.gitDir = join(root, `${encodeCwd(this.cwd)}.git`);
    if (this.cwd === homedir() || this.cwd === '/') this.disabledReason = 'snapshots are off in the home or root directory';
  }

  private git(args: string[], input?: string): { ok: boolean; out: string; err: string } {
    const r = spawnSync('git', ['--git-dir', this.gitDir, '--work-tree', this.cwd, ...args], { cwd: this.cwd, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024, timeout: 30000, env: { ...process.env, GIT_INDEX_FILE: join(this.gitDir, 'index'), GIT_AUTHOR_NAME: 'loom', GIT_AUTHOR_EMAIL: 'loom@localhost', GIT_COMMITTER_NAME: 'loom', GIT_COMMITTER_EMAIL: 'loom@localhost' } });
    return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() || (r.error?.message ?? '') };
  }

  private init(): boolean {
    if (this.disabledReason) return false;
    if (this.ready) return true;
    if (!existsSync(join(this.gitDir, 'HEAD'))) {
      mkdirSync(this.gitDir, { recursive: true });
      const r = spawnSync('git', ['init', '--bare', '-q', this.gitDir], { encoding: 'utf8' });
      if (r.status !== 0) {
        this.disabledReason = `git unavailable: ${r.stderr || r.error?.message}`;
        return false;
      }
      mkdirSync(join(this.gitDir, 'info'), { recursive: true });
      writeFileSync(join(this.gitDir, 'info', 'exclude'), EXCLUDES.join('\n') + '\n');
      this.git(['config', 'core.autocrlf', 'false']);
    }
    this.ready = true;
    return true;
  }

  take(): string | null {
    if (!this.init()) return null;
    const add = this.git(['add', '-A', '--', '.']);
    if (!add.ok) {
      this.disabledReason = `snapshot failed: ${add.err.slice(0, 200)}`;
      return null;
    }
    const tree = this.git(['write-tree']);
    return tree.ok ? tree.out : null;
  }

  changedSince(tree: string): string[] {
    const now = this.take();
    if (!now || now === tree) return [];
    const r = this.git(['diff', '--name-only', tree, now]);
    return r.ok ? r.out.split('\n').filter(Boolean) : [];
  }

  restore(tree: string): { restored: string[]; removed: string[] } {
    const now = this.take();
    if (!now) throw new Error(this.disabledReason ?? 'snapshots unavailable');
    const added = this.git(['diff', '--name-only', '--diff-filter=A', tree, now]).out.split('\n').filter(Boolean);
    const changed = this.git(['diff', '--name-only', '--diff-filter=MDT', tree, now]).out.split('\n').filter(Boolean);
    if (changed.length) {
      const r = this.git(['checkout', tree, '--', ...changed]);
      if (!r.ok) throw new Error(`restore failed: ${r.err}`);
    }
    for (const f of added) rmSync(join(this.cwd, f), { force: true });
    this.git(['read-tree', tree]);
    return { restored: changed, removed: added };
  }
}
