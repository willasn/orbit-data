---
description: OrbitData 项目开发约定：上下文最小化、改动一致性、敏感信息隔离
globs: "**/*"
alwaysApply: true
---

# 上下文最小化：按需读文件

项目为 **Tauri 2（Rust 后端）+ React 18 / TS / Vite / Zustand 前端** 的桌面应用（OrbitData）。
任何任务开始前遵守以下流程，最小化文件读取、降低上下文与限流消耗：

1. 先读 `README.md` 的「技术栈 / 界面布局」段，确认目标改动落在后端还是前端、哪个模块。
2. 功能点与进度对应关系查 `FEATURE.md`（图例 `[x]` 已完成 / `[~]` 部分完成 / `[ ]` 规划中）。
   > 注意：本项目**没有** feature_flags 注册表（如 `feature_flags.rs`），不要臆造开关文件；确需开关再按模块内常量实现。
3. 定位代码一律优先用 Grep / Glob / 符号搜索（命令名、函数名、组件名），**禁止一次性 Read 整个目录**。
4. 只读与本次改动直接相关的文件：
   - 改数据库驱动：只读 `src-tauri/src/db/<driver>.rs`（`mysql.rs` / `pg.rs` / `redis.rs`）+ `db/mod.rs`。
   - 改命令注册：只读 `src-tauri/src/lib.rs` 的 `invoke_handler` 列表。
   - 改 AI 接入：只读 `src-tauri/src/ai.rs`。
   - 改配置持久化：只读 `src-tauri/src/config.rs`。
   - 改 Git 同步：只读 `src-tauri/src/gitsync.rs`。
   - **涉及数据库连接相关操作**（连接列表 / 连接树 / 右键菜单 / 连接增删改 / 新增或适配数据库类型 / 左栏 `LeftPanel.tsx`）：必须**先读根目录 `CONTEXT_MENU.md`**，按其「连接级统一 + 库表级按大类 + 能力位 `caps` 驱动」的约定实现，禁止按 `db_type` 直接写分支。该文件为设计稿，实现状态以文件头部标注为准。
   - 改前端：只读 `src/components/<对应>.tsx`；涉及全局状态时再读 `src/store.ts`、`src/types.ts`；涉及后端调用时再读 `src/api.ts`；涉及样式时读 `src/styles.css`。
5. 禁止读取 / 搜索构建产物与依赖目录：`src-tauri/target/`、`node_modules/`、`dist/`。
6. 仅在**新增功能**时更新 `FEATURE.md`（对应章节登记并更新日期/版本）；目录结构或技术栈变动时更新 `README.md`。

## 改动一致性要求

- 新增/重命名 Rust 命令：必须在 `src-tauri/src/lib.rs` 的 `tauri::generate_handler![...]` 注册，
  同时在 `src/api.ts` 暴露封装、在 `src/types.ts` 定义入参/返回类型。
- 新增数据库类型：改 `src/types.ts` 的类型联合 + `src/components/ConnectionDialog.tsx` + `db/mod.rs` 分发 + `db/<driver>.rs`；
  并按 `CONTEXT_MENU.md` 的「层级映射表」确认该类型的库级 / 表级 / 列级概念与所需 `caps`（能力位），菜单条目只按 `caps` 显隐。
- 前端组件命名与目录保持现有风格：功能组件放 `src/components/`，跨组件状态放 `src/store.ts`。

## 冒烟验证（改动后）

- 前端：`npx tsc --noEmit`
- 后端：`cd src-tauri && cargo check`
- 不要求跑完整 `tauri dev/build`，除非用户明确要求。

# 敏感信息隔离（强制）

应用会把**数据库连接信息（主机、端口、用户名、密码）**与 **AI 模型 API Key、接口地址**持久化到本机
`app_config_dir/config.json`，并可通过 Git 同步导出为 `orbit-data-sync.json`。因此：

1. **严禁把敏感数据写入任何可能被 git 提交的内容**。判定标准：只要文件位于仓库工作区且不在 `.gitignore` 中，就视为「可能被提交」，一律不得出现真实敏感值。覆盖范围包括但不限于：
   - 源码、注释、单元测试 / 集成测试、测试 fixture 与种子数据、Mock 数据
   - 示例、demo、脚本、CI 配置、构建配置
   - 文档（README / FEATURE / CONTEXT_MENU / 变更说明）、提交信息与 PR 描述
   - 日志、错误报告、调试 dump、崩溃堆栈、查询结果快照、导出文件（`.csv` / `.json` / `.sql`）、截图与录屏
   - 由 AI 会话、自动修复、代码生成产出的任何文件同样适用此约束
2. 严禁硬编码的个人账号信息与配置信息包括但不限于：
   - 数据库主机 / 端口 / 用户名 / 密码 / 连接串
   - AI 接口地址（Base URL）、API Key、模型私有 ID
   - Git 同步仓库本地路径、远程 URL（含 token 的 `https://user:token@host/...`）、分支名等个人偏好
   - 本机绝对路径（如 `/Users/<name>/...`）、个人邮箱、个人仓库地址
3. 这些值只允许来自：应用配置目录的 `config.json`、用户运行时输入、环境变量或配置读取接口（`src-tauri/src/config.rs`）。不得为了「方便调试」在代码中填入真实值兜底。
4. 运行时 / 调试产生的敏感数据**只写**应用配置目录或系统临时目录，禁止落到仓库目录；确需在工作区留档（如调试日志、导出样本），必须先加入 `.gitignore` 再生成，且文件中不得含真实凭据。
5. 文档与示例中一律使用占位符，例如：`your-api-key`、`https://api.example.com/v1`、`127.0.0.1:3306`、`your-user`、`your-password`。
6. AI 上下文注入（`ai.rs` 中注入连接类型/地址/库名）与日志输出必须脱敏：**禁止**带出密码、API Key、完整连接串；日志中的主机 / 库名也应做必要遮蔽。
7. `config.json`、`orbit-data-sync.json`、`.env*` 等含真实配置的文件必须写入 `.gitignore`，绝不随 git 提交
   （当前 `.gitignore` 已含 `node_modules`、`dist`、`src-tauri/target`、`*.log`、`.DS_Store`、`config.json`、`orbit-data-sync.json`、`.env*`；新增含敏感数据的文件类型后需同步追加）。
8. 提交前必须自检，三项都要通过：
   - `git status --short` 中不含上述文件；
   - 已跟踪文件无敏感命中，例如：
     `git grep -nIE "(sk-[A-Za-z0-9]{8,}|ghp_|github_pat_|AKIA[0-9A-Z]{16}|https?://[^/\"' )]*@|/Users/)" -- . ':!package-lock.json' ':!src-tauri/Cargo.lock'`
   - 真实凭据只出现在被忽略的文件中。发现误加立即移出并撤销暂存；若已推送，必须轮换该凭据，不能只删文件。
9. Git 同步功能导出的是明文敏感数据，文档与 UI 提示中必须保留「请使用私有仓库」的警告。
