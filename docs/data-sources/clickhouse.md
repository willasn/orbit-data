# ClickHouse 连接说明

> 文档状态：**已实现（v0.1.7）**，`npx tsc --noEmit`、`cargo check` 与单测通过；已在 ClickHouse 26.8.36.3（HTTP 8123）完成连接测试、对象树、复杂类型查询与建表 / 写入 / 删除的真实环境联调
> 更新日期：2026-11-10
> 所属大类：`sql`（关系型 / OLAP，第 1 大类）
> 连接类型：`clickhouse`
>
> 本文档是「ClickHouse」连接类型的长期说明，覆盖连接配置、层级模型、界面展示、功能清单、接口设计、安全要求与测试清单。
> 实现状态以 `FEATURE.md` 为准；完成后需同步更新本文件头部的「文档状态」。

---

## 一、概述

ClickHouse 是列式 OLAP 数据库，使用 SQL 作为查询语言，通过 HTTP 接口（默认 `8123`，HTTPS 常用 `8443`）或原生 TCP 接口（`9000`）访问。OrbitData 将其作为 `sql` 大类的新连接类型接入，复用现有的对象树、右键菜单、SQL 编辑器、结果表格与 AI 对话能力。

第一期提供：

- 连接配置与连通性测试
- 数据库 → 表 / 视图 / 物化视图 / 字典 → 字段 的对象树浏览
- 通过 SQL 编辑器执行任意 SQL（含手写 DDL / DML）
- 右键菜单常用操作：预览前 100 行、查看结构、查看 DDL、SELECT 模板、执行计划、行计数、复制表名、刷新元数据
- 建库与建表设计器（ClickHouse 方言：引擎 + 排序键模型）
- AI 对话生成 ClickHouse 语法 SQL 并一键运行

第一期不提供：原生 TCP `9000` 协议、集群 / 分片拓扑视图、分区可视化、物化视图与字典的专属管理、导入导出。

### 1.1 支持状态

| 项目 | 状态 |
|---|---|
| 能力注册表 `src/db/drivers.ts` | ✅ 已登记（`sql` 大类，`caps.partition / mv`，`index: false`） |
| 右键菜单 `src/db/menuItems.ts` | ✅ 已有方言分支（`SHOW CREATE TABLE`、`LIMIT n`、`EXPLAIN`） |
| 左栏对象树 `src/components/LeftPanel.tsx` | ✅ `caps` 驱动，无需改动 |
| 新建连接入口 `ConnectionDialog.tsx` | ✅ 已实现 |
| 后端连接器 `src-tauri/src/db/clickhouse.rs` | ✅ 已实现 |
| 后端分发 `src-tauri/src/db/mod.rs` | ✅ 已实现 |
| 建库 / 建表设计器 | ✅ 已实现（ClickHouse 方言：Engine + ORDER BY） |
| 真实环境联调 | ✅ 已通过（ClickHouse 26.8.36.3，HTTP 8123） |

> 通用命令 `list_databases` / `list_tables` / `list_columns` / `run_query` 已存在，**不需要新增 Tauri 命令**。

---

## 二、连接配置

### 2.1 协议选型

第一期走 **HTTP 接口（默认 8123）**，理由：

- 复用现有 `reqwest` 依赖，不引入新的 ClickHouse 协议 crate，不增加编译体积与构建复杂度；
- HTTP 接口能力足够覆盖元数据浏览与 SQL 执行；
- HTTPS 证书沿用系统信任链，与 Elasticsearch / OSS 的处理方式一致。

原生 TCP `9000` 不在第一期范围内。用户把端口填成 `9000` 时应给出明确提示：「ClickHouse 使用 HTTP 端口 8123（HTTPS 常用 8443），原生 TCP 9000 暂不支持」。

### 2.2 配置字段

| 界面字段 | 存储字段 | 必填 | 说明 |
|---|---|---|---|
| 连接名称 | `name` | 是 | 用户自定义名称 |
| 连接类型 | `db_type` | 是 | 固定为 `clickhouse` |
| 主机 | `host` | 是 | 主机名或 IP；允许带 `http(s)://` 前缀，但不得包含凭据、路径或查询参数 |
| 协议 | `clickhouse.scheme` | 是 | `http`（默认）/ `https` |
| 端口 | `port` | 是 | 默认 `8123`；切换协议时联动为 `8123` / `8443` |
| 用户名 | `username` | 否 | 默认 `default` |
| 密码 | `password` | 否 | 密码框输入，可留空 |
| 默认数据库 | `database` | 否 | 默认 `default`；用于对象树初始选择与查询上下文 |
| 分组 | `group` | 否 | 复用现有连接分组 |
| 标识颜色 | `color` | 否 | 取注册表颜色（`#facc15`） |

示例（占位符，禁止在仓库中填写真实凭据）：

```text
主机:      ck.example.com
协议:      http
端口:      8123
用户名:    default
密码:      your-password
默认数据库: default
```

### 2.3 配置持久化

- 新增可选结构 `ClickHouseConfig { scheme }`，Rust 侧使用 `serde(default)`，兼容既有 `config.json` 与 Git 同步文件；
- 仅保存协议，不额外保存任何派生值；
- 连接信息（含明文密码）只写本机应用配置目录，Git 同步时提示使用私有仓库。

### 2.4 连通性测试

- 请求 `SELECT version()`，超时沿用全局 5 秒；
- 成功展示 `ClickHouse <version> 连接成功`；
- 失败按类型区分提示：连接被拒绝 / 超时 / 鉴权失败（HTTP 401/403）/ 服务端 SQL 报错。

---

## 三、层级模型

| 抽象层级 | ClickHouse 对应 | 数据来源 |
|---|---|---|
| 连接 | 一个 ClickHouse 服务地址 | 连接配置 |
| 库级 | database | `system.databases` |
| 表级 | 表 / 视图 / 物化视图 / 字典 | `system.tables`（按 `engine` 归类） |
| 列级 | column | `system.columns` |

映射规则：

- 数据库：列出 `system.databases` 全部名称（保留 `system`，与 MySQL 展示 `mysql` / `information_schema` 的做法一致），按名称排序；
- 表级按引擎归类：
  - `View` → 视图（`view`）
  - `MaterializedView` → 物化视图（`mv`）
  - `Dictionary` → 字典（`dictionary`）
  - 其余 → 表（`table`）
- 列级字段：
  - `name`：字段名
  - `type`：原始类型字符串（如 `Nullable(String)`、`LowCardinality(String)`）
  - 可空：类型包裹 `Nullable(...)` 即为可空
  - `key`：`is_in_primary_key = 1` 时标记为主键
  - `comment`：`system.columns.comment`
  - 默认值：`system.columns.default_expression`（用于详情展示）

标识符统一使用反引号转义（注册表 `quote: "`"`），限定名形如 `` `db`.`table` ``。

---

## 四、界面展示

整体沿用现有三列布局：左栏对象树 / 中栏对话与结果 / 右栏 SQL 编辑器与结果面板。

### 4.1 左栏对象树

```text
ClickHouse(生产) ●
├─ default
│  ├─ events              表
│  ├─ events_mv           物化视图
│  ├─ daily_view          视图
│  └─ events → 展开字段    name / type / 可空 / 主键 / 注释
└─ system
   └─ …
```

- 交互与现有 SQL 类型一致：展开加载态、失败重试、长列表按批渲染（100 条 / 批）；
- 连接级 / 库级 / 表级 / 列级右键菜单全部由 `caps` 驱动，ClickHouse 不新增任何按类型名分支的菜单条目。

### 4.2 结果面板

- 查询结果进入现有结果表格，支持表格 / 图表切换、行号、NULL 识别、数值高亮；
- 结果行沿用现有 500 行上限截断；
- 执行耗时与行数统计沿用现有展示。

---

## 五、功能清单

图例：`[x]` 已完成 · `[~]` 部分完成 · `[ ]` 规划中

### 5.1 连接管理

- [x] 新建 / 编辑 / 删除 ClickHouse 连接（名称、主机、协议、端口、用户名、密码、默认库、分组）
- [x] 测试连接（`SELECT version()`）
- [x] 协议与端口联动（http = 8123 / https = 8443）
- [x] 端口误填 9000 时给出「暂不支持原生 TCP」提示

### 5.2 对象树

- [x] 数据库列表（`system.databases`）
- [x] 表 / 视图 / 物化视图 / 字典 列表（`system.tables` 按 engine 归类）
- [x] 字段列表（`system.columns`：名称 / 类型 / 可空 / 主键 / 注释）
- [x] 连接级「刷新元数据」、库级「刷新」复用现有实现
- [x] 断开连接后清空该连接缓存、执行查询时自动重连（复用 `session`）

### 5.3 查询执行

- [x] SQL 编辑器执行任意 SQL（SELECT / SHOW / DESCRIBE / EXPLAIN / INSERT / CREATE / ALTER / DROP）
- [x] `Cmd/Ctrl + Enter` 快捷运行
- [x] DDL / DML 无结果集时返回空结果并提示执行成功
- [x] 错误信息回显 ClickHouse 报错文本（不含凭据）
- [x] 查询超时 60 秒；测试连接沿用 5 秒
- [x] 多语句不支持时给出明确提示（一次执行一条语句）

### 5.4 右键菜单（复用现有条目）

- [x] 连接级：新建查询、新建数据库…、刷新元数据、编辑 / 重命名 / 复制为新建、测试连接、复制地址（不含密码）、复制 AI 上下文、移动到分组…、删除连接
- [x] 库级：新建数据库…、新建表…、删除库（手输库名确认）、刷新
- [x] 表级：预览前 100 行（`LIMIT 100`）、查看结构（`SHOW CREATE TABLE`）、查看 DDL、SELECT 模板、执行计划（`EXPLAIN`）、行计数、复制表名
- [x] 保持「规划中」灰显：库概览、导出 DDL、分区 / 分片信息、物化视图管理、索引与约束

### 5.5 建库 / 建表设计器

- [x] 建库：`CREATE DATABASE \`db\``（成功后刷新对象树）
- [x] 建表窗口改为 ClickHouse 模型：
  - 字段：名称 / 类型 / 长度或精度 / 可空（生成 `Nullable(...)`）/ 默认值 / 注释
  - 表级：`ENGINE`、`ORDER BY`（必填）、`PARTITION BY`（可选）、`PRIMARY KEY`（可选，留空同 `ORDER BY`）、`TTL`（可选）
  - 隐藏「自增」「主键」列（ClickHouse 无自增列，主键由 `ORDER BY / PRIMARY KEY` 表达）
  - 实时 SQL 预览
- [x] 支持字段类型：`UInt8/16/32/64`、`Int8/16/32/64`、`Float32/64`、`Decimal`、`String`、`FixedString`、`Date`、`Date32`、`DateTime`、`DateTime64`、`UUID`、`Bool`、`Array(...)`、`Map(...)`
- [x] 引擎选项：`MergeTree`（默认）、`ReplacingMergeTree`、`SummingMergeTree`、`AggregatingMergeTree`、`Memory`、`Log`、`TinyLog`
- [x] 校验：表名 / 字段名控制字符与重复、字符串长度与精度范围、MergeTree 系列必须有 `ORDER BY`

生成的 SQL 示例：

```sql
CREATE TABLE `db`.`events` (
  `id` UInt64,
  `name` Nullable(String) DEFAULT '',
  `created_at` DateTime DEFAULT now(),
  `payload` Map(String, String)
) ENGINE = MergeTree
PARTITION BY toYYYYMM(created_at)
ORDER BY (`id`)
COMMENT '示例表';
```

### 5.6 AI 对话

- [x] 现有上下文注入已按 `driver.label` + `caps.sql` 追加「请使用 ClickHouse 语法」，无需改代码
- [x] AI 生成的 ```sql 代码块可一键运行
- [x] 注入内容仅含类型、`host:port`、当前库 / 表 / 字段，不含密码

---

## 六、后端实现设计

### 6.1 文件与分发

| 文件 | 动作 |
|---|---|
| `src-tauri/src/db/clickhouse.rs` | 新增：HTTP 请求封装、`test`、`list_databases`、`list_tables`、`list_columns`、`query`、JSON 解析与单测 |
| `src-tauri/src/db/mod.rs` | 改：`test_connection` / `list_databases` / `list_tables` / `list_columns` / `run_query` 增加 `clickhouse` 分支 |
| `src-tauri/src/config.rs` | 改：新增可选 `ClickHouseConfig { scheme }`，`serde(default)` |
| `src/types.ts` | 改：`ClickHouseConfig` 类型 + `Connection.clickhouse?` |
| `src/components/ConnectionDialog.tsx` | 改：类型卡片、表单字段、默认值与联动 |
| `src/components/DbTypeIcon.tsx` | 改（可选）：ClickHouse 品牌图标；不加则回退通用数据库图标 |
| `src/db/drivers.ts` | 改：`createDialect` 增加 `"clickhouse"` |
| `src/db/menuItems.ts` | 改：建库 / 建表入口的 `createDialect` 放行条件加入 `clickhouse` |
| `src/db/createTable.ts` | 改：`COLUMN_TYPES.clickhouse`、ClickHouse 建表 SQL 生成与校验 |
| `src/components/CreateObjectDialog.tsx` | 改：ClickHouse 表设计 UI（引擎 / 排序键 / 分区键） |

### 6.2 HTTP 调用约定

- 地址：`{scheme}://{host}:{port}/`
- 认证：请求头 `X-ClickHouse-User` / `X-ClickHouse-Key`（用户名、密码为空时不发送）
- 数据库：URL 查询参数 `database`
- 结果格式：`default_format=JSON`，返回 `meta`（列名 / 类型）与 `data`（行数组）
- 请求方法：`POST`，SQL 放在请求体，避免 SQL 出现在 URL 与日志中
- 重定向关闭；连接超时与读超时分别设置，查询超时 60 秒

### 6.3 元数据 SQL（参数化，避免拼接注入）

| 用途 | SQL |
|---|---|
| 连通性测试 | `SELECT version()` |
| 数据库列表 | `SELECT name FROM system.databases ORDER BY name` |
| 表列表 | `SELECT name, engine FROM system.tables WHERE database = {db:String} ORDER BY name` |
| 字段列表 | `SELECT name, type, default_expression, comment, is_in_primary_key FROM system.columns WHERE database = {db:String} AND table = {table:String} ORDER BY position` |

参数通过 ClickHouse HTTP 的 `param_<name>` 查询参数传递，配合 `{name:Type}` 占位符使用。

### 6.4 结果解析规则

| ClickHouse 类型 / 输出 | 表格展示 |
|---|---|
| `UInt64` / `Int64` 大整数 | 保留字符串（ClickHouse 默认对 64 位整数加引号，避免 JS 精度丢失） |
| `Float32/64` | 数字 |
| `Decimal` | 字符串（保留精度） |
| `Date` / `DateTime` / `DateTime64` | 原样字符串 `YYYY-MM-DD HH:mm:ss` |
| `Array` / `Map` / `Tuple` | JSON 文本 |
| `Nullable(...)` 为空 | `null` |
| DDL / DML 空响应 | 空结果集 + 成功提示 |

### 6.5 方言差异

| 场景 | ClickHouse 语法 |
|---|---|
| 取前 N 行 | `LIMIT n`（末尾） |
| 查看结构 / DDL | `SHOW CREATE TABLE` |
| 执行计划 | `EXPLAIN SELECT ...` |
| 标识符转义 | `` `name` `` |
| 建库 | `CREATE DATABASE \`db\``（无字符集 / 排序规则） |
| 建表 | 必须有 `ENGINE`；MergeTree 系列必须有 `ORDER BY` |
| 自增列 | 不支持（无 `AUTO_INCREMENT`） |
| 一次多语句 | 不支持，一次一条 |

---

## 七、安全要求

1. 主机字段只接受主机名 / IP，可带 `http(s)://` 前缀；拒绝内嵌凭据、路径、查询参数与片段；
2. 用户名、密码只保存在本机 `config.json`，日志与错误信息中禁止出现密码与完整连接串；
3. AI 上下文只注入类型、`host:port`、库 / 表 / 字段名，不注入凭据；
4. Git 同步会导出明文连接配置，UI 与文档保留「请使用私有仓库」的提示；
5. 元数据查询使用 ClickHouse 参数占位符，不直接拼接用户输入的库名 / 表名；
6. 查询结果可能包含业务敏感数据，导出与截图需自行控制范围。

---

## 八、测试清单

### 8.1 自动化

- [x] `npx tsc --noEmit` 通过
- [x] `cd src-tauri && cargo check` 通过
- [x] `cd src-tauri && cargo test`：JSON 结果解析（数组行 / 对象行）、引擎归类、主机地址校验、64 位整数保精度等 7 项单测通过（样例数据不含任何真实凭据）
- [x] 真实环境联调测试 `clickhouse::tests::live_smoke`：仅在设置 `CK_TEST_HOST` 等环境变量时执行，凭据只从环境变量读取

### 8.2 联调（需真实实例）

本地可用容器启动（凭据通过环境变量注入，不写入仓库）：

```bash
docker run -d --name orbit-ck -p 8123:8123 \
  -e CLICKHOUSE_USER=default -e CLICKHOUSE_PASSWORD=your-password \
  clickhouse/clickhouse-server
```

- [x] 连接测试成功并显示版本号
- [x] 后端返回 `default` / `system` 下的表、视图、物化视图与字段（对象树数据源）
- [ ] 右键「预览前 100 行」「查看结构」「查看 DDL」「执行计划」「行计数」的界面操作
- [x] 手写 `CREATE TABLE` / `INSERT` / `SELECT` / `DROP` 可执行
- [ ] 建表设计器在界面中生成的 SQL 与实际执行一致（含 `Nullable`、`Map`、`PARTITION BY`）
- [x] 大整数、DateTime、Array / Map 字段解析与展示正确
- [x] 错误 SQL 返回 ClickHouse 原始报错且不泄漏凭据
- [ ] 断开连接后查询自动重连（界面）
- [ ] AI 对话生成的 ClickHouse SQL 一键运行（界面）

---

## 九、本期不做

- 原生 TCP `9000` 协议连接
- 集群 / 分片 / 副本拓扑视图
- 分区可视化（`system.parts`）与分区维护操作
- 物化视图、字典的专属管理入口（菜单保持「规划中」灰显）
- CSV / JSON 导入导出、数据编辑与提交
- ClickHouse Cloud 专属认证与配置