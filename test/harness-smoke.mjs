import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import Subprocess from '@deepseek-ai/dsh-subprocess-local';
import Bash from '@deepseek-ai/dsh-bash-local';
import * as Plugin from '../index.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const cwd = await mkdtemp(join(tmpdir(), 'dsh-live-smoke-'));
const ctx = new Context();
try {
  execFileSync('git', ['init', '-q'], { cwd });
  await writeFile(join(cwd, 'new.txt'), 'hello\n');
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(Tools, { mode: 'native' });
  await ctx.plugin(Subprocess);
  await ctx.plugin(Bash);
  const fiber = await ctx.plugin(Plugin);
  assert.ok(ctx.tools.schemas().some(tool => tool.name === 'git_review'));
  const result = await ctx.tools.execute({
    callId: 'smoke-1', name: 'git_review', arguments: {},
    signal: new AbortController().signal,
    agent: { session: { header: { id: 'smoke-session', cwd }, requestHeader: () => undefined } },
  });
  assert.equal(result.isError, false, JSON.stringify(result));
  const report = JSON.parse(result.content[0].text);
  assert.equal(report.totals.untracked, 1);
  assert.equal(report.files[0].path, 'new.txt');
  await fiber.dispose();
  assert.ok(!ctx.tools.schemas().some(tool => tool.name === 'git_review'));
  console.log('PASS: published Harness 0.2.0-rc.2 services registered, executed, rendered and disposed git_review using a real Git repository.');
} finally {
  await ctx.fiber.dispose();
  await rm(cwd, { recursive: true, force: true });
}
