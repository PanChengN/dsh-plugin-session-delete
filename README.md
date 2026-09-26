# dsh-plugin-session-delete

给 DeepSeek Harness 的 Web UI 侧栏会话右键菜单加一行 **「删除会话」**，并真正从磁盘上删除会话。

> 背景：DSH 0.1.7-rc.2 没有任何删除会话的功能。会话菜单只有 置顶 / 重命名 / 分叉 / 归档，
> 主机端会话控制器也没有 delete RPC（`dsh-session-persistence-jsonl` 的文档原文：
> 「不删除会话文件——日志在 `root` 下累积，直到外部移除；seam 无删除接口」）。
> 本 bundle 用官方 Slot 机制补上这一行，并把「外部移除」做成一个主机端点。

非官方社区插件，与 DeepSeek 官方无关。

## 组成

| 文件 | 作用 |
| --- | --- |
| `package.json` | bundle 清单：`dsh.bundle.patch` + `dsh.client`（客户端半） |
| `cordis.patch.yml` | 插入主机行 `session-delete` |
| `index.js` | **主机半**：注册 `POST /api/dsh-session-delete` |
| `client.js` | **客户端半**：向 `sidebar.workspaces.session.menu.item` 座位注册菜单行（order 500） |
| `locale/{zh,en}.json` | 插件卡片标题与描述 |
| `icon.svg` | 插件卡片图标 |

仓库根目录**就是**插件目录（`package.json` 在根上），clone 下来即可直接安装，无需构建步骤。

## 安装

### 1. 取得插件目录

```sh
git clone https://github.com/PanChengN/dsh-plugin-session-delete.git
```

### 2. 在 GUI 里添加（桌面版必须走 GUI）

CLI 明确拒绝桌面 profile：

```
$ dsh plugin --profile desktop add <...>
error: profile "desktop" is managed exclusively by the Electron application
```

所以在侧栏 **Plugins** 页面 → **Add plugin** 里粘贴 clone 出来的目录的**绝对路径**，
装完点 **Enable now**，然后重启 DeepSeek Harness（新 bundle 的浏览器模块需要一次进程重启才会进入模块表）。

## ⚠️ 卸载与换设备（必读）

path 安装会把**绝对路径**写进 profile，所以规则只有一条：**先在 GUI 里卸载，再删目录。**

### 正确顺序

1. 侧栏 **Plugins** 页面里把本插件 **Disable / Remove**（桌面版必须走 GUI；DSH 的 `removeBundle` 会停用 → 热重载 → `pnpm remove`，同步清理 profile 清单）
2. 再删掉 clone 出来的目录

### 目录已经被删掉了会怎样

症状：启动异常、插件清单里出现失败条目、界面提示「加载失败；点击重试」，宿主日志里是

```
dsh: cannot resolve profile bundle "@local/dsh-bundle-session-delete" from the dsh installation or
<profile 目录>; run 'dsh plugin --profile <name> install' if its dependency is not installed
```

原因：删目录只删掉了代码，profile 里留下的引用全部悬空。一共三处（外加一处无害的锁文件）：

| 位置 | 内容 |
| --- | --- |
| `$DSH_HOME/profiles/<profile>/package.json` | `dependencies` 的 `link:<已删路径>` 与 `dsh.profile.bundles` 里的条目 |
| `$DSH_HOME/profiles/<profile>/node_modules/@local/dsh-bundle-session-delete` | 指向已删目录的符号链接 |
| `$DSH_HOME/profiles/<profile>/cordis.yml` | Loader 真正启动的 leaf 配置里那一行 `- id: session-delete` |
| `pnpm-lock.yaml` / `node_modules/.pnpm/lock.yaml` | 只是记录，下次组合刷新会被重写（脚本不改它） |

补充机制：`loadProfileDirectory()` 对每个 bundle 是逐个 `try/catch` 的，解析失败的 bundle 会被跳过并记进
`skippedBundles`，**不会**让整个 profile 起不来；真正让界面异常的是上面那些残留引用。

### 救援：跑仓库自带脚本

```sh
git clone https://github.com/PanChengN/dsh-plugin-session-delete.git   # 或直接用你手上那份
python3 dsh-plugin-session-delete/scripts/fix-stale-install.py            # 先只检查
python3 dsh-plugin-session-delete/scripts/fix-stale-install.py --apply    # 确认后执行
```

脚本会：删除悬空的 `link:` 依赖与对应的 `dsh.profile.bundles` 条目、删掉 profile 私有层的悬空符号链接、
摘掉 `cordis.yml` 里的残留行，**每个被改动的文件都先备份为 `*.bak-<时间戳>`**（回滚就是覆盖回去）。
默认是 dry-run，加 `--apply` 才写入。`$DSH_HOME` 不是 `~/.dsh` 时用 `--dsh-home /path` 指定。

`profiles/node_modules/`（共享挂载层）里的历史悬空链接脚本**只统计、不删** —— 那层是 DSH 自己的挂载点，
解析时按候选目录逐个探测 `package.json`，悬空项会被跳过，无害。

改完重启 DeepSeek Harness 即可；如仍报 pnpm 相关错误，删掉该 profile 的 `node_modules/.pnpm/lock.yaml` 再启动。

### 手工救援（不想跑脚本时）

关掉 App，然后：

1. 编辑 `$DSH_HOME/profiles/<profile>/package.json`：从 `dependencies` 删掉 `"@local/dsh-bundle-session-delete": "link:..."`，并从 `dsh.profile.bundles` 数组里删掉 `"@local/dsh-bundle-session-delete"`
2. 删掉 `$DSH_HOME/profiles/<profile>/node_modules/@local/dsh-bundle-session-delete`（悬空符号链接）
3. 编辑 `$DSH_HOME/profiles/<profile>/cordis.yml`，删掉结尾那两行：

   ```yaml
   - id: session-delete
     name: '@local/dsh-bundle-session-delete'
   ```

4. 重新打开 DeepSeek Harness

### 两条禁令

- **别直接 `rm -rf` 一个已启用插件的目录**（本插件、任何 path 安装的插件都一样）
- **别同时装两份**：本插件的包名是 `@local/dsh-bundle-session-delete`，cordis 行 id 是 `session-delete`，
  HTTP 路由是 `/api/dsh-session-delete`。同一 profile 里装两份会撞上 `ambiguous-install`，
  即使装上也会因重复注册同一路由而让插件加载失败。要换成 GitHub 那份，就先在 GUI 里移除本地那份。

## 删除范围

一次删除会清掉四处，全部基于 `$DSH_HOME`（默认 `~/.dsh`）：

1. `sessions/<工作区>/<session-id>/` —— 会话正文与写锁
2. `storages/session_projcache/sessions/<id>.json` —— 派生缓存（标题等）
3. `storages/workspace.json` —— `global.archivedSessionIds` 与各工作区的 `sessionIds` 引用
4. **子智能体会话** —— 当 `zlib.zstdDecompressSync` 可用时，连带删除 `header.parentSession`
   指向被删会话的会话；不可用时跳过并在响应里报告 `zstd: false`

会话 id 的两种落盘形式（`session-<uuid>` 与裸 `<uuid>`）都会识别。

## 接口

```http
POST /api/dsh-session-delete
content-type: application/json

{ "sessionId": "session-xxxxxxxx-...." }
```

成功：

```json
{
  "ok": true,
  "sessionId": "session-....",
  "removedSessions": 1,
  "removedChildren": 0,
  "removedCaches": 1,
  "workspace": { "archived": 0, "groups": 1 },
  "emitted": 2,
  "zstd": true
}
```

失败：`400 missing-session-id` / `400 invalid-json` / `405 method-not-allowed` / `500 <message>`。

## 删除后界面如何更新（不整页刷新）

删除成功后，主机半会向客户端发 **`api-session/removed`**（`dsh-api-remotes` 的转发事件之一），
客户端 `ClientSessions.handleSessionRemoved` 收到后把该 id 从列表快照里移除；
侧栏在按工作区拼行时对「没有 summary 的 id」直接 `continue` 跳过，所以那一行会立刻消失。

客户端半只在事件没生效时（400ms 后该 id 仍在快照里）才退一步调用一次
`sessions.refresh()` 重新拉取列表基线，**任何情况下都不再 `location.reload()`**。

> 主机内存里的工作区注册表仍保留着已删除 id 的成员关系，但因为它没有对应的 session
> summary，侧栏不会渲染；下次启动时 `workspace.json` 已经是干净的。

## 已知限制

- 菜单行的确认框用的是浏览器原生 `confirm()`，样式不是 DSH 风格；要换成 `shell.overlay`
  自定义对话框是下一步。
- 没有阻止删除「当前正在进行的对话」——确认框里有提示，但没有硬性拦截。
- 主机内存中的工作区成员关系要等重启才彻底清掉（界面表现不受影响）。

## 许可

MIT © 2026 NIUpc
