import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { apply, resolveConfig } from '../index.js';
import { summarize, parseStatus, parseNumstat } from '../review.js';

const exec = promisify(execFile);
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-git-review-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = (...args) => exec('git', args, { cwd });
  await git('init', '-q');
  await git('config', 'user.name', 'Fixture');
  await git('config', 'user.email', 'fixture@example.invalid');
  return { cwd, git, write: (path, value) => writeFile(join(cwd, path), value) };
}
function toolFor(shell, config) {
  let tool;
  apply({ shell, tools: { register(value) { tool = value; } }, get() {} }, config);
  return tool;
}
function realShell() {
  return {
    resolve: request => request,
    async execute(spec) {
      return { async result() {
        let stdout = '', stderr = '', exitCode = 0;
        try {
          ({ stdout, stderr } = await exec('bash', ['-c', spec.command], {
            cwd: spec.workdir, env: { ...process.env, ...spec.env },
            signal: spec.signal, timeout: spec.timeoutMs, maxBuffer: spec.stdoutMaxBytes,
          }));
        } catch (error) {
          if (typeof error.code !== 'number') throw error;
          ({ stdout, stderr } = error); exitCode = error.code;
        }
        return { exitCode, stdout: { text: stdout, truncated: false }, stderr: { text: stderr }, timedOut: false, aborted: false };
      } };
    },
  };
}
const run = (tool, cwd) => tool.execute({}, { agent: { session: { header: { cwd } } }, signal: new AbortController().signal }).then(JSON.parse);

test('one overview covers staged, unstaged, untracked and binary edits without changing Git or files', async t => {
  const f = await fixture(t);
  await f.write('both.txt', 'original\n');
  await f.write('binary.bin', Buffer.from([0, 1, 2]));
  await f.write('.gitignore', 'ignored.txt\n');
  await f.git('add', '.'); await f.git('commit', '-qm', 'fixture');
  await f.write('both.txt', 'original\nstaged\n'); await f.git('add', 'both.txt');
  await f.write('both.txt', 'original\nstaged\nunstaged\n');
  await f.write('binary.bin', Buffer.from([0, 2, 3, 4]));
  await f.write('new\t中文\nfile.txt', 'not read\n');
  await f.write('ignored.txt', 'ignored\n');
  const before = (await f.git('status', '--porcelain=v1', '-z')).stdout;
  const indexBefore = await readFile(join(f.cwd, '.git/index'));
  const report = await run(toolFor(realShell()), f.cwd);
  assert.deepEqual(report.totals, { files: 3, staged: 1, unstaged: 2, untracked: 1, conflicts: 0 });
  const both = report.files.find(file => file.path === 'both.txt');
  assert.deepEqual(both.stagedLines, { added: 1, deleted: 0 });
  assert.deepEqual(both.unstagedLines, { added: 1, deleted: 0 });
  assert.deepEqual(report.files.find(file => file.path === 'binary.bin').unstagedLines, { added: null, deleted: null });
  assert.ok(report.files.some(file => file.path === 'new\t中文\nfile.txt'));
  assert.equal((await f.git('status', '--porcelain=v1', '-z')).stdout, before);
  assert.deepEqual(await readFile(join(f.cwd, '.git/index')), indexBefore);
  assert.equal(await readFile(join(f.cwd, 'both.txt'), 'utf8'), 'original\nstaged\nunstaged\n');
});

test('staged renames preserve source and destination, and deletions remain visible', async t => {
  const f = await fixture(t);
  await f.write('old name.txt', 'one\ntwo\n'); await f.write('delete.txt', 'delete\n');
  await f.git('add', '.'); await f.git('commit', '-qm', 'fixture');
  await f.git('mv', 'old name.txt', 'new name.txt'); await f.git('rm', '-q', 'delete.txt');
  const report = await run(toolFor(realShell()), f.cwd);
  assert.equal(report.files.find(file => file.path === 'new name.txt').previousPath, 'old name.txt');
  assert.deepEqual(report.files.find(file => file.path === 'delete.txt').stagedLines, { added: 0, deleted: 1 });
});

test('repositories without a first commit and clean repositories work', async t => {
  const f = await fixture(t);
  await f.write('first.txt', 'first\n'); await f.git('add', '.');
  const tool = toolFor(realShell());
  assert.equal((await run(tool, f.cwd)).totals.staged, 1);
  await f.git('commit', '-qm', 'first');
  assert.equal((await run(tool, f.cwd)).totals.files, 0);
});

test('nested session directories still report whole-repository paths', async t => {
  const f = await fixture(t);
  await f.write('root.txt', 'root\n'); await f.git('add', '.'); await f.git('commit', '-qm', 'fixture');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(f.cwd, 'nested')); await f.write('root.txt', 'changed\n');
  assert.equal((await run(toolFor(realShell()), join(f.cwd, 'nested'))).files[0].path, 'root.txt');
});

test('conflicts have their own count and capped rows do not hide total counts', () => {
  const report = summarize('UU conflicted.txt\0?? new.txt\0', '', '', 1);
  assert.deepEqual(report.totals, { files: 2, staged: 0, unstaged: 0, untracked: 1, conflicts: 1 });
  assert.equal(report.omittedFiles, 1);
});

test('malformed NUL records are rejected instead of silently dropping files', () => {
  assert.throws(() => parseStatus('R  renamed\0'), /rename/);
  assert.throws(() => parseNumstat('garbled\0'), /line-count/);
});

test('invalid config fails at load, and model arguments cannot inject a command or change paths', async () => {
  assert.throws(() => resolveConfig({ maxFiles: 0 }), /configuration/);
  assert.throws(() => resolveConfig({ extra: true }), /configuration/);
  const tool = toolFor({ resolve() { throw new Error('must not execute'); } });
  await assert.rejects(tool.execute({ command: 'anything' }, {}), /empty object/);
  await assert.rejects(tool.execute({}, {}), /workspace/);
});

test('non-Git workspaces return a clear failure', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-not-git-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await assert.rejects(run(toolFor(realShell()), cwd), /Git overview failed/);
});

test('truncation, timeout and cancellation fail without a partial summary', async () => {
  for (const [flag, expected] of [['truncated', /limit/], ['timedOut', /timed out/], ['aborted', /cancelled/]]) {
    const tool = toolFor({ resolve: value => value, execute: async () => ({ result: async () => ({
      exitCode: 0, stdout: { text: '', truncated: flag === 'truncated' }, stderr: { text: '' },
      timedOut: flag === 'timedOut', aborted: flag === 'aborted',
    }) }) });
    await assert.rejects(run(tool, '/workspace'), expected);
  }
});

test('standing session sandbox policy and caller cancellation reach every shell request', async () => {
  const requests = [], signal = new AbortController().signal;
  const session = { header: { cwd: '/workspace' } };
  const sandboxPolicy = { mode: 'read-only', workspaceRoot: '/workspace' };
  let tool;
  apply({
    tools: { register(value) { tool = value; } },
    get(name) { assert.equal(name, 'sandboxPolicy'); return { resolve(value) { assert.equal(value.session, session); return sandboxPolicy; } }; },
    shell: { sandboxMode: 'read-only', resolve: value => value, async execute(spec) {
      requests.push(spec); return { result: async () => ({ exitCode: 0, stdout: { text: '', truncated: false }, stderr: { text: '' } }) };
    } },
  });
  await tool.execute({}, { agent: { session }, signal });
  assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.equal(request.signal, signal); assert.equal(request.sandboxPolicy, sandboxPolicy);
    assert.equal(request.env.GIT_OPTIONAL_LOCKS, '0');
  }
});
