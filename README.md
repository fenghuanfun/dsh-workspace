# dsh-workspace

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that adds **extra source directories** to a workspace, beside the workspace directory itself.

Repository: <https://github.com/fenghuanfun/dsh-workspace>

DSH gives every workspace exactly one directory (the registry `path`, which is also a session's `cwd`). This plugin lets you add more directories to that same workspace from the workspace actions menu. Sessions then treat them as part of the workspace, with **the same permissions and policy** as the workspace directory.

## Features

- A **Source directories** entry in a workspace's `…` / right-click menu, next to *Rename* and *Delete*.
- Add by native directory picker, remove, then save — one list per workspace.
- Applies to **already running sessions** of that workspace immediately: each directory gets a session-scoped writable-root grant and one line of runtime context.
- Validation on the Host side: absolute paths only, existing directories only, `realpath`-canonicalized, duplicates and nested directories folded, 32 directories per workspace.
- Durable and atomic: `$DSH_HOME/storages/dsh-workspace.json`, written via temp file + `rename`; a failed write never publishes state.

## Install

Clone this repository, then in DSH Desktop open **Plugins → Add plugin** and choose the checkout, or install it from a shell:

```bash
git clone https://github.com/fenghuanfun/dsh-workspace.git
```

```
plugin_manager install_bundle target=/absolute/path/to/dsh-workspace
```

Restart-free after install; reload the page to pick up the browser half.

## Usage

1. Hover a workspace row in the sidebar and click `…`, or right-click the row.
2. Choose **Source directories**.
3. **Add** a directory, **Remove** one, then **Save**.

Saving with an empty list removes the workspace's record entirely.

## Test

```
npm test
```

`test/host.mjs` drives the two routes and the per-agent effects through a fake Cordis context: validation, dedupe and nesting, per-workspace isolation, atomic writes, serialized concurrent saves, failed-write rollback, session grants and prompt text.

## Behaviour and limits

- The session working directory stays the workspace directory: relative paths, `bash` cwd and the file tree still follow it.
- Reading and writing are still bounded by the current permission mode (read-only stays read-only).
- Grants are runtime, session-scoped: resumed or forked sessions are re-registered; disabling the plugin drops them.
- The action is user-only. The model cannot add or remove workspace sources.

## How it works

| Part | Responsibility |
| --- | --- |
| `index.js` | Host plugin. Two JSON routes behind the connection trust fence (`GET /dsh-workspace/list`, `POST /dsh-workspace/set`), the durable document, per-session `sandboxPolicy.registerWritableRoot()` grants, and a short `systemPrompt` runtime context. |
| `client.js` | Browser half. Registers the workspace menu contribution (`contextMenus`), its icon (`contextMenu.icon`), and the dialog (`shell.overlay`). |
| `cordis.patch.yml` | Bundle patch inserting the Host row. |
| `locale/*.json` | Plugin Manager display metadata (EN / ZH). |
| `docs/DETAIL.md` | Detail page content. |

Routes are relative to the document, so the page works under any mount path.

## Layout

```
package.json        bundle manifest (dsh.bundle + dsh.client)
cordis.patch.yml    Host row
index.js            Host half
client.js           Browser half
locale/en.json      display metadata
locale/zh.json      display metadata
docs/DETAIL.md      detail page
icon.svg            plugin icon
test/host.mjs       Host-half tests (npm test)
```

## 中文简介

给一个工作区追加额外的 **源目录**：在侧边栏工作区行的「…」/ 右键菜单里选「源目录」，添加目录、移除目录并保存。保存后该工作区已开启的会话立即生效——每个目录获得与会话工作目录同策略的可写授权，并在运行时上下文里被声明为工作区的一部分。

- 校验：绝对路径、目录必须存在、`realpath` 规范化、去重与父子折叠、每个工作区最多 32 个。
- 存储：`~/.dsh/storages/dsh-workspace.json`（原子写入，写盘失败不改内存）。
- 限制：相对路径、`bash` 的默认 `cwd`、右侧文件树仍以工作区目录为准；操作仅对用户开放，模型不能自行修改。

安装：DSH Desktop 的 **插件 → 添加插件** 选择本目录；或 `plugin_manager install_bundle target=<本目录绝对路径>`。

## License

MIT
