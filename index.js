import { summarize } from './review.js';

export const name = 'git-review';
export const inject = ['tools', 'shell'];

/** Validate deployment settings before registering the tool. */
export function resolveConfig(config = {}) {
  const resolved = { maxFiles: 100, timeoutMs: 10000, outputBytes: 1048576, ...config };
  const limits = { maxFiles: [1, 1000], timeoutMs: [100, 60000], outputBytes: [1024, 16777216] };
  for (const [key, value] of Object.entries(resolved)) {
    if (!limits[key] || !Number.isInteger(value) || value < limits[key][0] || value > limits[key][1]) {
      throw new Error(`git-review: invalid configuration ${key}`);
    }
  }
  return resolved;
}

/** Register a read-only tool using the host shell and standing sandbox policy. */
export function apply(ctx, config = {}) {
  const settings = resolveConfig(config);
  const policy = ctx.shell.sandboxMode === undefined ? undefined : ctx.get('sandboxPolicy');
  if (ctx.shell.sandboxMode !== undefined && !policy) {
    throw new Error('git-review: sandboxed shell requires sandboxPolicy.');
  }
  ctx.tools.register({
    name: 'git_review',
    description: 'Get one read-only overview of the current workspace Git changes before reviewing or committing: staged, unstaged, untracked, conflicts and per-file line counts. Includes pre-existing edits; does not attribute edits to this session. Never commits, stages, resets or reads untracked file contents.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length) {
        throw new Error('git_review takes an empty object.');
      }
      const session = exec.agent?.session;
      const cwd = session?.header.cwd;
      if (!cwd) throw new Error('Select a workspace for this session before using git_review.');
      const sandboxPolicy = policy?.resolve({ session });
      // No model or filename input is interpolated into shell commands.
      const git = 'git --no-optional-locks -c core.fsmonitor=false -c core.untrackedCache=false -c diff.relative=false';
      async function run(command) {
        const handle = await ctx.shell.execute(ctx.shell.resolve({
          command: `${git} ${command}`, workdir: cwd,
          timeoutMs: settings.timeoutMs, onExpiry: 'kill', stdoutMaxBytes: settings.outputBytes,
          signal: exec.signal, sandboxPolicy,
          env: { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' },
        }));
        const result = await handle.result();
        if (result.aborted) throw new Error('Git overview cancelled.');
        if (result.timedOut) throw new Error('Git overview timed out.');
        if (result.exitCode !== 0) throw new Error(`Git overview failed: ${result.stderr.text || 'Git is missing, the workspace is not a repository, or access was denied.'}`);
        if (result.stdout.truncated) throw new Error('Git output exceeded the configured limit. No partial summary was returned.');
        return result.stdout.text;
      }
      const status = await run('status --porcelain=v1 -z --untracked-files=all --ignore-submodules=none');
      const staged = await run('diff --cached --numstat -z --no-renames --no-ext-diff --no-textconv --ignore-submodules=none');
      const unstaged = await run('diff --numstat -z --no-renames --no-ext-diff --no-textconv --ignore-submodules=none');
      return JSON.stringify(summarize(status, staged, unstaged, settings.maxFiles), null, 2);
    },
  });
}
