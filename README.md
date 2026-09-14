# Business Logic Graph（BLG）

中文 · [English](README.en.md)

**让人看懂业务，让模型按需核实业务。**

BLG 是一个 Codex 插件：先生成粗粒度业务骨架，再根据问题逐步下钻，把经过源码、配置和测试核实的结论保存为可展开的业务积木。人通过 HTML 阅读；模型通过同一份结构获取长期、渐进式上下文。

它不是调用图换皮，也不是一次性全仓库文档。函数调用属于证据，业务场景、规则、判断和数据变化才是地图主体。

> 当前为本地 MVP：Skill 编排分析，Core/CLI 管理数据与核实门禁，Viewer 展示已保存的逻辑。双击不会自动调用模型生成新逻辑。

## 已实现

- 任意层级业务图、需求定位和按需上下文：默认深度 1、最多 32 个节点、24,000 字符；预算不足会明确报错。
- 分开保存业务节点、代码事实、模型推断、业务确认和代码/配置/测试证据。
- 每个项目的数据单独使用本地 Git，放在目标代码仓库外，不修改目标 `.gitignore`。
- 默认以 `master` 为业务基线，也可配置 `main`；开发分支和 worktree 保存独立 overlay，不自动覆盖基线。
- 新增节点蓝色、修改橙色、删除红色虚线；核实状态另用标签。删除节点仅用于对比，不进入模型的当前业务上下文。
- 整文件 SHA-256 指纹检测；未变更证据可复用，本次需求直接影响的逻辑仍需读源码核实。
- RFC 6902 Patch、图版本检查、用户锁、实体级三方比较及冲突阻断。
- 双击展开/折叠、刷新保留展开状态、自包含 HTML 和本地自动编译预览。

## 工作方式

```text
源码 / 配置 / 测试 → 证据候选 → 模型读取并核实 → 业务图
                                               ├─ context → 模型按需阅读
                                               └─ HTML    → 人逐层展开
```

开发前：定位业务区域 → 读取相关子图 → 核实受影响证据 → 更新业务图 → 检查门禁 → 输出最终开发计划。

CodeGraph 是**可选 Evidence Provider**，负责缩小阅读范围、提供文件/符号/调用链候选。候选不等于已核实事实。BLG 维护自己的定位、指纹和业务图，并完成最终源码核实。本版尚未实现实时 CodeGraph 连接。

## 快速开始

构建 Viewer 使用 Node.js **22.12+** 或满足 Vite 要求的 20.19+，需要 npm 和 Git。Core/CLI 没有第三方运行时包依赖。

克隆后，在本仓库根目录执行：

```sh
npm --prefix apps/viewer ci
npm run check
```

`check` 运行 Core 测试、合成示例校验、Viewer Lint、TypeScript 和生产构建。

体验内置的**虚构订单处理示例**：

```sh
npm run validate:example
npm run context:example
npm run gate:example
npm --prefix apps/viewer run dev
```

示例不来自真实业务仓库，其中的核实版本只用于演示，不代表目标仓库事实。

### 安装为 Codex 插件

本仓库包含 `.codex-plugin/plugin.json` 和 `skills/business-logic-graph/`。构建完成后，在 Codex 打开本仓库，请求内置 Plugin Creator 注册个人 marketplace 并安装：

> 请使用 Plugin Creator，将当前项目注册并安装为个人 Codex 插件 business-logic-graph，验证 manifest 和 Skill，保留已有 marketplace 条目。

安装后新开一个 Codex 任务加载 Skill。也可以直接运行 CLI，无需安装插件。仅克隆或打开 HTML 不会启用 Agent 工作流。

### 为目标仓库建立业务图

```sh
node scripts/blg.mjs init /path/to/source --baseline master
# 主分支为 main 时，改用 --baseline main
node scripts/blg.mjs status /path/to/source
```

初始化创建独立数据 Git 及首次本地提交，但不会自动生成业务结论。随后在已加载插件的 Codex 任务里请求：

> 用 BLG initialize 梳理这个仓库：先看入口、路由、关键配置和测试，只生成一级业务骨架，不全量阅读源码。

进一步下钻：

> 用 BLG explain 解释“组织与成员”：代码如何组织，关键文件和函数有哪些？读取相关代码核实，并把新逻辑与证据补回业务图。

### HTML 与自动刷新

```sh
node scripts/blg.mjs render /path/to/source
node scripts/blg.mjs preview /path/to/source --port 5182 --reuse
```

`render` 输出自包含 HTML，无需部署、无需服务持续运行。`preview` 是本地便利工具：监控 Viewer 源码、业务图与源码证据，编译并刷新投影，不自动修改业务结论、不调用模型。从源码克隆后需先安装 Viewer 依赖并构建；`--no-build` 不会生成缺失的构建产物。

Windows **CMD** 示例：

```bat
cd /d "D:\projects\business-logic-graph"
npm --prefix apps/viewer ci
npm run build:viewer
node scripts\blg.mjs init "D:\projects\my-app" --baseline main
scripts\blg.cmd preview "D:\projects\my-app" --port 5182 --reuse
```

PowerShell 使用 `Set-Location -LiteralPath "D:\projects\business-logic-graph"` 切换目录。不要在 CMD 执行 `Set-Location`。

## 数据在哪里？

默认根目录为 `<用户目录>/BLG/data`，可通过 `BLG_DATA_HOME` 或 `--data-root` 覆盖。

```text
BLG/data/
├─ registry.json                 本机源码路径绑定，不进入项目数据 Git
└─ projects/<repo-id>/            独立 Git 仓库
   ├─ repository.json            项目与基线配置
   ├─ baseline/graph.json        主分支业务基线
   ├─ overlays/                  分支 / worktree 增量记录
   ├─ history/                   内容寻址的图快照
   ├─ imports/                   迁移归档：分享前检查内容
   └─ viewer/<worktree-id>/       生成的 HTML，不进入数据 Git
```

图采用 `nodes / edges / claims / evidence` 扁平 ID 映射。`parentId` 支持任意层级，边描述业务顺序和条件。上下文与 HTML 是可重建投影，不是第二份可编辑真相。

切换源码分支不会删除外部数据，页面选择对应基线或 overlay。同一源码 Git 的多个 worktree 共享基线，但不隐式共享可变 overlay。ZIP 源码使用明确的 SHA-256 快照模式，不创建源码 `.git`、不伪造 master。

## 日常命令

```sh
node scripts/blg.mjs context /path/to/source "成员" --depth 1 --max-nodes 32 --max-chars 24000
node scripts/blg.mjs source /path/to/source src/example.ts --start-line 1 --end-line 120
node scripts/blg.mjs patch /path/to/source /external/path/patch.json
node scripts/blg.mjs patch /path/to/source /external/path/patch.json --write
node scripts/blg.mjs validate /path/to/source
node scripts/blg.mjs gate /path/to/source <affected-node-id>
node scripts/blg.mjs commit /path/to/source --message "核实成员管理规则"
```

`patch` 默认 dry-run，写入通过目标源码路径入口检查真实 Git 上下文。基线写入要求主分支的干净工作区，开发分支只写 overlay。Patch 文件也应保存在源码仓库外。

基线推进后，显式 `rebase` 进行实体级三方比较；冲突或新增用户锁会阻止规划。本版不自动裁决冲突，也不自动合入分支结论：代码合并后需重新核实主分支。

```sh
node scripts/blg.mjs rebase /path/to/source
node scripts/blg.mjs overlays /path/to/source
node scripts/blg.mjs adopt /path/to/source <overlay-filename>
node scripts/blg.mjs bind /path/to/source <repo-id>
node scripts/blg.mjs export /path/to/source /new/export-directory
```

跨设备单独克隆**数据仓库**后重新 `bind`。分支改名或 worktree 移动后，先列出记录，再显式 `adopt`，原记录保留。导出不包含源码、本机路径和 Git 历史。

## 模型用量与隐私

- 点击、缩放、展开已保存节点、HTML 渲染和本地指纹检查不调用模型。
- 初始化、解释、核实和补图会消耗模型用量；不保证固定的节省百分比。
- 用小范围上下文和读取预算避免全图加载；新提交不代表所有节点都要重读。
- BLG 自身不上传源码或业务图；Codex 发给模型的上下文遵循你使用的服务及配置。
- **工具开源不等于业务数据公开。** 本仓库只含工具、协议和合成示例。真实业务图可能含内部规则，分享前应审查迁移归档与历史。
- CLI 不自动配置远程或 push；数据提交、远程配置、推送需要明确请求。

## 项目结构与边界

```text
.codex-plugin/                  Codex 插件 manifest
skills/business-logic-graph/     Agent 工作流与核实规则
packages/protocol/              图 / overlay / Patch JSON Schema
packages/core/                  校验、上下文、门禁、外部存储与 Git 检查
scripts/                        Node CLI / Windows CMD 入口
examples/order-demo/            合成示例、演示源码、配置和测试
apps/viewer/                    React Flow + ELK 业务积木前端
```

已实现本地闭环。`initialize / inspect / explain / plan / sync` 是 Skill 驱动的模型工作流，不是独立 CLI 子命令。

后续方向：实时 CodeGraph 适配器、更丰富的稳定符号定位、依赖传播核实、人工冲突处理界面、合并后基线同步和可视化业务编辑。当前业务前端以只读浏览为主。

## 贡献与许可证

欢迎提交 Issue 和 PR。提交前运行 `npm run check`，不要提交真实客户代码、业务地图、访问凭据或本机路径。

BLG 使用 [MIT License](LICENSE)。前端起源于 [CodeSee](https://github.com/Kaka-cheaper/codeSee) 的 MIT Viewer，原许可证保存在 [LICENSES/CodeSee-MIT.txt](LICENSES/CodeSee-MIT.txt)，说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。React Flow 和 ELK.js 保留各自许可证；CodeGraph 不是捆绑依赖。
