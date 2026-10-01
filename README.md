# dsh-git-review

DeepSeek Harness 的只读 Git 改动总览插件。提交前一次查看已暂存、未暂存、新增文件、冲突，以及每个文件的增删行数，无需翻完整条工具调用记录。

Read-only Git change overview for DeepSeek Harness. One tool call summarizes the current index and working tree, including staged/unstaged edits, untracked files, conflicts and per-file line counts.

## 安装 / Install

需要 Git、DeepSeek Harness **0.2.0-rc.2**（本版本的兼容性验证目标），以及提供 `tools` 和 `shell` 的 profile。无需构建，无需额外 API key，无 npm 安装脚本。

```sh
dsh plugin --profile web add github:nanami7777777/dsh-git-review#v0.1.0
```

安装后重启当前 Harness。发行页也提供打包的 `.tgz`，可下载后用 `dsh plugin --profile web add ./dsh-git-review-0.1.0.tgz` 安装。

## 使用 / Use

在会话中选择 Git 项目作为工作区，然后发送：

> 调用 git_review，列出当前项目改了哪些文件，有哪些已暂存、未暂存和新增文件，并指出是否有冲突。不要提交。

English: “Call git_review and summarize the workspace changes before I commit.”

插件提供 `git_review` 工具；参数是空对象 `{}`。结果出现在普通工具结果卡片中，本版没有额外侧栏按钮。

```json
{
  "totals": { "files": 3, "staged": 1, "unstaged": 2, "untracked": 1, "conflicts": 0 },
  "files": [{ "path": "src/app.js", "index": "M", "worktree": "M", "staged": true, "unstaged": true,
    "stagedLines": { "added": 4, "deleted": 1 }, "unstagedLines": { "added": 2, "deleted": 0 } }],
  "omittedFiles": 0
}
```

上面仅展示结果字段示例；实际文件数组包含所有报告行（受 `maxFiles` 上限限制）。

## 范围 / Scope

- 报告当前 Git 工作树和暂存区，**包含会话开始前已有的改动**。不声称这些改动都是 AI 或当前会话造成的。已提交的改动不在报告中。
- 不暂存、不提交、不 reset，不读取新增文件内容、不返回 diff 正文。文件名和行数会通过正常工具结果返回给当前模型。
- 沿用 Harness 的 shell 执行器、会话工作目录、取消信号和现有沙箱策略；不申请更高权限。
- 已暂存与未暂存文件数量可能重叠；忽略文件不计入；二进制行数为 `null`。
- 重命名保留 `previousPath`，行数使用 `--no-renames`，因此目标文件可能按全部新增计数。
- Git 命令按顺序读取，结果不是原子快照，采集期间请避免编辑文件。子模块内部文件不展开。
- Git 输出超限、超时、取消或命令失败时直接报错，不输出看起来完整的部分结果。

## 配置 / Configuration

可在 profile 的 `cordis.patch.yml` 中覆盖本插件行：

```yaml
- id: community-git-review
  config:
    maxFiles: 100
    timeoutMs: 10000
    outputBytes: 1048576
```

`maxFiles` 范围 1–1000，`timeoutMs` 为每条 Git 命令的超时（100–60000 毫秒），`outputBytes` 为每条命令的 stdout 上限（1024–16777216 字节）。shell 执行器仍可应用自己的限制。文件列表被截短时保留完整总数与 `omittedFiles`。

## Development

```sh
npm install --ignore-scripts
npm test
npm run test:harness
npm pack
```

The bundle ships plain ESM JavaScript, with no third-party runtime imports or build step. The devDependency is only for the Harness integration smoke test. Registration uses the host `ctx.tools` registry and execution uses `ctx.shell`; it does not instantiate a second copy of Harness services. Tests cover real Git repositories plus error handling and policy forwarding. `test:harness` mounts the released 0.2.0-rc.2 Cordis, tools, subprocess and Bash services, executes the tool, checks its rendered result, and verifies unregistration on disposal. Verified on macOS; no live model API call is required or included in this check. MIT license.

## 社区需求来源

- [官方 Discussions #172：整场会话后需要按文件汇总改动](https://github.com/deepseek-ai/deepseek-harness/discussions/172)。本插件采取 Git 工作树总览的方式，不替代会话轨迹或历史回放。
- [官方插件打包与安装规范](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)。
