# 右键菜单分类方案（连接级统一 + 下层按大类）

> 状态：**框架已实现，条目分批落地；第八大类 `messaging` 与 Kafka 工作区已实现，真实集群联调待验证；`sql` 大类新增 SQL Server（连接器已实现，真实环境联调待验证）**（2026-10-09）。本文包含设计约定，各类型完成状态与验证结果以 `FEATURE.md` 为准；新增条目后同步该文件。
> 目标：覆盖 30+ 种常见数据库（含 6 种国产 / 信创登记类型）；新增一种类型时，若大类已存在则**菜单零改动**。

## 实现状态

| 内容 | 状态 | 位置 |
|---|---|---|
| 能力注册表（37 种类型、8 大类；以 `DRIVER_LIST` 实际条目计数，不含未知类型兜底；其中国产 / 信创 6 种仅登记，无后端连接器） | 已实现；Kafka 已注册，构建检查通过，集群联调待完成 | `src/db/drivers.ts` |
| 菜单条目（连接级 1 份、容器级 / 对象级按 8 大类、列级 1 份；Kafka 不生成库 / 列节点） | 已实现；messaging 菜单由能力位控制 | `src/db/menuItems.ts` |
| 菜单外壳（定位翻转 / 外部点击关闭 / 键盘导航 / 危险项 / 规划中灰显） | 已实现 | `src/components/ContextMenu.tsx` |
| 左栏连接、库、表、列四类节点右键接入 | 已实现 | `src/components/LeftPanel.tsx` |
| 左栏展开/收起切换、层级加载态、长列表按需渲染(100 条/批) | 已实现 | `src/components/LeftPanel.tsx` + `store.toggleConnection` / `DbTree.loading` |
| 左栏连接分组(分组头折叠、组内缩进、移动到分组) | 已实现 | `Connection.group` + `store.collapsedGroups` / `toggleGroup` |
| 连接 / 断开(会话状态 + 左栏状态点 + 断开后自动重连) | 已实现 | `src-tauri/src/db/session.rs` + `connect_db` / `disconnect_db` / `connection_status` |
| 连接级「刷新元数据」 | 已实现 | `store.refreshConnection` |
| MySQL / PG：预览前 100 行、查看结构、SELECT 模板、EXPLAIN、行计数、复制表名 | 已实现 | 走 `run_query` |
| SQL Server：同上（SQL 按方言生成：`TOP n`、`[name]` 转义、`SET SHOWPLAN_ALL ON`） | 已实现（2026-10-09） | 走 `run_query`；连接器 `src-tauri/src/db/mssql.rs`（tiberius / TDS） |
| MySQL / PG：连接级「新建数据库…」、库级「新建表… / 删除库」 | 已实现 | 新建表使用设计窗口与 DDL 预览，走 `run_query` 后刷新树；危险项手输库名确认 |
| Redis（kv）：库级「新建键… / 清空当前逻辑库」 | 已实现 | 新建键使用窗口输入字符串值/TTL，走 `redis_command` 后刷新树；其他注册的 kv 驱动尚无后端连接器 |
| Elasticsearch：索引直挂连接、Mapping 字段、预览文档、Mapping/Settings、计数、DSL 控制台 | 已实现（2026-10-08） | 复用 `run_query`，能力位驱动，无库级节点；集群健康可在控制台查询 |
| doc / vector / search / ts / graph 大类的新建 / 删除条目 | 未实现 | ES 已有只读连接器，写操作及其他类型连接器尚未实现，菜单保持「规划中」灰显 |
| Redis：查看值（按 TYPE 展开为表格，5.2 条目）、TTL、设置过期、重命名键、持久化、删除键、刷新键列表、DBSIZE | 已实现 | 查看值走 `redis_key_view`（HSCAN / SSCAN / ZSCAN 循环 + LRANGE / XRANGE，上限 500 项），其余走 `redis_command` |
| 标注「规划中」的条目 | 未实现 | 菜单灰显 + 「规划中」标签 |
| Rust `db_capabilities` 命令（后端作为能力事实来源） | 未实现 | 前端注册表先行；待新增驱动时再迁移 |

> 约定：菜单中 `planned: true` 的条目会渲染为灰显 + 「规划中」，实现后把该标记去掉即可。

## 一、总体分层

```
连接级   ← 1 份，全类型共用（能力位决定查询 / 控制台 / 消息工作区入口）
  ├─ 库级（容器层）  ← 按 8 大类定义；无库层类型跳过
  ├─ 表级（对象层）  ← 按 8 大类定义；messaging 对象为 Topic
  └─ 列级（字段层）  ← 1 份 + 少量能力开关；Kafka 不适用
```

大类（`kind`）划分：

| kind | 含义 | 代表 |
|---|---|---|
| `sql` | 关系型 / OLAP（会说 SQL） | MySQL、PostgreSQL、Oracle、SQL Server、SQLite、ClickHouse、Doris、Hive、Trino、DuckDB；国产信创：达梦 DM、Kingbase、GBase、Oscar、PolarDB、openGauss |
| `kv` | 键值 / 缓存 | Redis、Valkey、Dragonfly、Memcached |
| `doc` | 文档 | MongoDB |
| `vector` | 向量 | Milvus、Qdrant、Weaviate |
| `search` | 全文检索 | Elasticsearch、OpenSearch |
| `ts` | 时序 | InfluxDB、TDengine、Prometheus、QuestDB |
| `graph` | 图 | Neo4j、NebulaGraph |
| `messaging` | 消息流 / 消息队列（第八大类） | Kafka、RabbitMQ、RocketMQ、Pulsar；本版本仅实施 Kafka |

`file`（SQLite / DuckDB 本地文件）**不单独成类**，做成 `caps.localFile` 开关 —— 它们的库/表菜单与 MySQL 几乎一致，仅连接级不同。

设计原则：

- **连接级统一** —— 该层操作对象是「一条配置记录」，与驱动能力无关。
- **库级 / 表级按大类** —— 该层操作对象是「数据对象」，概念差异真实存在（库 / 集合 / 索引 / bucket / space）。
- **菜单条目只依赖「能力位」，不依赖「类型名」** —— 禁止写 `if (db_type === 'mysql')`。

---

## 二、连接级菜单（统一，全类型共用）

```
连接 / 断开                  全部类型；按会话状态显示「连接」或「断开连接」(已实现)
新建查询                     caps.sql   → 非 SQL 类改为「打开控制台」caps.console
打开消息工作区               caps.messaging → Kafka 专用标签页（不复用 SQL 编辑器）
新建数据库…                  caps.sql && caps.databases && caps.write → CREATE DATABASE(按方言),成功后刷新元数据
刷新元数据                   全部类型
──────────────────
编辑连接…
重命名
复制为新建
──────────────────
测试连接                     caps.localFile 时改为「校验文件」
复制地址（不含密码）          caps.localFile 时改为「复制文件路径」
复制为 AI 上下文             脱敏：仅类型 + host:port + 库名
──────────────────
环境标签（dev / test / prod） prod 则全树加红边 + 写操作二次确认
移动到分组…                  已实现；留空表示移出分组(分组名存在连接的 group 字段)
──────────────────
删除连接                     红色置底 + confirm
```

连接级保持一份定义：查询 / 控制台 / 消息工作区入口分别由 `caps.sql` / `caps.console` / `caps.messaging` 控制，文件相关文案由 `caps.localFile` 控制；新建数据库还受 `caps.databases` / `caps.write` 约束。不得按 `db_type` 添加专用菜单分支。

---

## 三、层级映射表（关键）

不同数据库的「库 / 表 / 列」叫法不同，先统一为三个抽象层级，再按类型映射：

| 类型 | kind | 库级 = ? | 表级 = ? | 列级 = ? |
|---|---|---|---|---|
| MySQL / MariaDB / TiDB / OceanBase | sql | database | table / view | column |
| PostgreSQL / TimescaleDB | sql | database → **schema** | table / view / matview | column |
| Oracle | sql | **schema**（= 用户） | table | column |
| SQL Server | sql | database → **schema(dbo)**（实现为库级 = database，表级按 `schema.table`，`dbo` 省略前缀） | table / view | column |
| 达梦 DM / 神舟通用 Oscar 🇨🇳 | sql | schema（Oracle 风格） | table | column |
| PolarDB 🇨🇳 | sql | database | table / view | column |
| Kingbase / openGauss 🇨🇳 | sql | database → **schema** | table / view | column |
| GBase 🇨🇳 | sql | database（8a 分析型口径） | table / view | column |
| ClickHouse | sql | database | table / **MV** / 字典 | column |
| Doris / StarRocks | sql | database | table / **分区** / MV | column |
| Hive | sql | database | table / **分区** | column |
| Trino / Presto | sql | **catalog → schema** | table | column |
| SQLite | sql（file） | **单库（无需选择）** | table / view | column |
| DuckDB | sql（file） | **单库** | table / view | column |
| Redis / Valkey / Dragonfly | kv | **db0–db15** | key（按 type 分组） | hash field / zset member |
| Memcached | kv | 无（扁平 slab） | key | — |
| MongoDB | doc | database | **collection** | field（`$sample` 推断） |
| Milvus | vector | database | **collection** | **field**（向量维度 / 标量） |
| Qdrant / Weaviate | vector | **无库层** | collection | vector / payload 字段 |
| Elasticsearch / OpenSearch | search | **无库层**（挂集群层） | **index** | mapping field |
| InfluxDB v2 | ts | **bucket** | **measurement** | field key / tag key |
| InfluxDB v1 | ts | database + **retention policy** | measurement | field / tag |
| TDengine | ts | database | **超级表 STABLE** / 子表 | column / tag |
| Prometheus | ts | 无（按 job 分组） | **metric 名** | **label** |
| QuestDB | ts | 无（schema = public） | table | column |
| Neo4j 4+ | graph | database | **label**（节点 / 关系） | property |
| NebulaGraph | graph | **space** | **tag** / **edge type** | property |
| Kafka | messaging | **无库层**（集群即连接） | **Topic**（直挂连接） | **无列层**；Partition 是工作区详情，不是 column |
| RabbitMQ / RocketMQ / Pulsar | messaging | 按各产品命名空间另行映射 | queue / topic 等，待专用驱动适配 | 不套用 SQL column；本版本未注册、未实施 |

> 实现要点：🇨🇳 为国产 / 信创登记类型，仅完成能力注册，后端无连接器、连接入口未开放；层级映射沿用其上游协议族（MySQL / PG / Oracle 风格）。无库层类型直接跳过库级节点，对象挂到连接下，菜单也不渲染库级。当前注册表以 `caps.databases: false` 表达该行为（`hasDatabaseLayer` 是设计概念，不是当前必备字段）。Kafka 还设置 `caps.columns: false`，禁止把 Partition 填入 `list_columns` 或列级菜单。

---

## 四、库级菜单（按 8 大类约定；Kafka 跳过此层）

### 4.1 `sql`（MySQL / PG / Oracle / CK / Doris / Hive / Trino / SQLite / DuckDB …）

```
新建数据库…                  caps.sql && caps.databases && caps.write → CREATE DATABASE(已实现)
新建表…                     caps.write → MySQL / PG 打开表设计窗口、预览 DDL 并创建(已实现；其他驱动待接入)
──────────────────
设为当前库                   USE db / SET search_path / ALTER SESSION
新建查询                     编辑器预填 `USE db;`（方言决定语法）
刷新
──────────────────
搜索表…                     库内过滤树
库概览                      表数 / 视图数 / 行数估算 / 占用大小
导出库结构（DDL）            caps.ddl
──────────────────
分区 / 分片信息              caps.partition（CK / Doris / Hive）
物化视图                     caps.mv（CK / Doris / PG）
──────────────────
删除库                      caps.write && caps.databases；DROP DATABASE,危险项 + 手输库名确认(已实现)
```

差异仅由能力位产生：`caps.partition` / `caps.mv` / `caps.ddl` / `caps.write`。MySQL 与 ClickHouse 共用同一份定义。

### 4.2 `kv`（Redis / Valkey / Dragonfly / Memcached）

```
新建键…                     caps.write → Redis 窗口输入字符串值与可选 TTL，SET NX 创建并刷新键列表(已实现)
──────────────────
切换 DB                     SELECT n（db0–db15）
刷新键列表                  SCAN
键数量                      DBSIZE
──────────────────
扫描设置                    pattern / count / 是否显示 TTL
按分隔符分组显示             `user:123` → 树状折叠（Redis 体验亮点）
──────────────────
监控（MONITOR）             可选，长连接面板
──────────────────
清空当前 DB                 caps.write → SELECT + FLUSHDB,红色 + 输入库号确认(已实现)
```

### 4.3 `doc`（MongoDB）

```
设为当前库
刷新
──────────────────
库统计                      dbStats：集合数 / 文档数 / 存储大小
聚合管道编辑器               db 级 $aggregate
──────────────────
新建集合…
导入 JSON / 导出 JSON
──────────────────
删除库                      危险项
```

### 4.4 `vector`（Milvus / Qdrant / Weaviate）

```
设为当前库                  caps.hasDatabaseLayer（Milvus 有，Qdrant / Weaviate 无）
刷新
──────────────────
集合统计                    实体数 / 索引状态 / 加载状态
──────────────────
新建 Collection…            需填：维度 dim、主键、度量类型
──────────────────
全部加载 / 全部释放          load / release（Milvus）
──────────────────
删除库                      caps.hasDatabaseLayer；危险项
```

### 4.5 `search`（Elasticsearch / OpenSearch）—— 库级退化为「集群层」

```
集群健康                    green / yellow / red + 节点数
刷新索引列表
──────────────────
新建索引…                   settings（shards / replicas）+ mapping
别名管理                    alias add / remove
──────────────────
分片 / 节点分布              _cat/shards
──────────────────
集群设置（只读展示）
```

### 4.6 `ts`（InfluxDB / TDengine / Prometheus / QuestDB）

```
设为当前 bucket / database
刷新 measurements
──────────────────
时间范围预设                最近 15m / 1h / 24h / 7d（时序专有，影响全部查询）
──────────────────
保留策略 / 降采样            caps.retention
写入测试点                  line protocol 输入框
──────────────────
删除 bucket                 危险项
```

### 4.7 `graph`（Neo4j / NebulaGraph）

```
设为当前库 / space
刷新标签
──────────────────
图概览                      节点数 / 边数 / 标签分布
──────────────────
新建标签 / 边类型…
子图可视化                  选种子节点展开 N 跳
──────────────────
删除 space                  危险项
```

---

### 4.8 `messaging`（Kafka / RabbitMQ / RocketMQ / Pulsar）

Kafka **没有库级节点**，不制造虚拟 database；集群元数据、Topic 创建与 Consumer Group 管理放在连接级消息工作区。容器级定义仅为其他消息系统未来的命名空间预留，不能据此声称这些产品已支持。

## 五、表级菜单（按大类 8 份）

### 5.1 `sql`

```
预览前 100 行                SELECT * FROM t LIMIT 100
查看结构 / DDL               SHOW CREATE / pg_dump / DBMS_METADATA（caps.ddl）
──────────────────
生成 SQL 模板               SELECT / INSERT / UPDATE 三选一
执行计划                    EXPLAIN（caps.explain）
行计数                      COUNT(*)
列统计（直方图）             min / max / distinct / 空值率（caps.stats）
──────────────────
复制表名                    按方言转义：`t` / "t" / [t] / public.t
加入筛选器 / 打开过滤面板
──────────────────
导出 CSV / JSON / SQL
──────────────────
分区信息                    caps.partition
索引与约束                  caps.index
──────────────────
重命名表                    caps.write
清空表（TRUNCATE）          caps.write；危险项
删除表                      危险项
```

### 5.2 `kv`（Redis key）

```
查看值                      按 type 渲染：string / hash 表格 / list / set / zset / stream
TTL 查看 / 设置             秒数输入
──────────────────
复制键名
重命名键                    RENAME
──────────────────
持久化                      PERSIST（移除 TTL）
──────────────────
删除键                      DEL；危险项（批量键需输入数量确认）
```

### 5.3 `doc`（Mongo collection）

```
预览文档                    find().limit(20)，JSON 树渲染
查看索引
文档计数                    countDocuments / estimatedDocumentCount
集合统计                    collStats：大小 / 平均文档 / 索引大小
──────────────────
聚合管道编辑器               可视化 stage 拼接
导出 JSON / 导入 JSON
──────────────────
重命名集合 / 清空 / 删除      危险项
```

### 5.4 `vector`（Milvus / Qdrant collection）

```
预览实体                    query(limit=20)，向量字段折叠显示为 [dim]
查看 Schema                 主键 / 向量字段 + dim / 标量字段
索引信息                    index type（AUTOINDEX / IVF_FLAT / HNSW）+ metric（L2 / IP / COSINE）
实体计数                    num_entities
──────────────────
向量检索                    输入 query 向量或文本（走模型 embedding）+ topK + filter 表达式 ← 核心亮点
──────────────────
加载 / 释放                 load() / release()（Milvus）
──────────────────
删除 Collection             危险项
```

### 5.5 `search`（ES index）

```
预览文档                    _search size=20
查看 Mapping                字段类型树
查看 Settings               shards / replicas / refresh_interval
文档计数                    _count
──────────────────
查询 DSL 编辑器              JSON 编辑器 + 常用模板
──────────────────
别名管理 / 重建索引          _reindex
──────────────────
清空（delete_by_query）      危险项
删除索引                    危险项
```

### 5.6 `ts`（measurement / stable）

```
最近数据预览                带时间范围的 SELECT / Last
查看 field keys / tag keys
聚合查询                    GROUP BY time(1m) / downsample
──────────────────
保留策略                    retention policy 查看
──────────────────
删除 series / measurement    危险项
```

### 5.7 `graph`（label / tag）

```
预览节点 / 边                MATCH (n:L) RETURN n LIMIT 25 / Nebula: nGQL
查看属性 Schema             属性名 + 类型采样
统计数量                    节点数 / 边数
──────────────────
图可视化                    选种子展开 N 跳子图
──────────────────
删除该标签下全部数据          危险项
```

---

### 5.8 `messaging`（Kafka Topic；已实现）

```
浏览消息 / Topic 详情        caps.browseMessages → 工作区消费页，metadata / Partition / ISR / 水位
生产消息                    caps.produceMessages → 工作区生产页，key / partition / headers / tombstone
Topic 管理                  caps.topicManagement → 创建 / 删除 / 增加分区 / 配置
Consumer Groups             caps.consumerGroups → 消费组、成员、已提交 offset 与 lag
重置消费位点                 caps.resetOffsets → 仅 inactive group；显式选 Topic 与该 Topic 全部 / 单分区，不默认重置整个组；手输目标确认
──────────────────
复制 Topic 名称              对象原名，不套用 SQL 标识符转义
```

连接级仍只有统一的 `caps.messaging` 工作区入口；对象级入口按上述能力位显隐，不按 Kafka 类型名写菜单分支。消费支持 earliest / latest / recent / 指定 offset / timestamp；监听使用有限时轮询及返回的 next offsets 续读，不是无限后端订阅。Partition 信息仅在详情中展示，无 column 菜单。

## 六、列级菜单（基本统一 + 能力开关）

```
复制列名（带方言转义）       全部类型
生成 SELECT / WHERE 模板     全部类型
加入筛选器                  全部类型
──────────────────
列统计                      caps.stats（SQL 类：distinct / min / max / 空值率）
查看注释 / 完整类型          caps.columns（MySQL / PG / Oracle 有 comment）
──────────────────
向量字段专属                caps.vector：显示 dim + metric，入口「用此字段做向量检索」
ES 字段专属                 caps.mapping：显示 analyzer / 是否可聚合
Mongo 字段专属              caps.sample：字段类型由 $sample 推断，标注「采样推断」
```

---

## 七、能力位总表（`caps`，后端为事实来源）

```
通用：   sql  console  databases  schemas  tables  columns  ddl  explain
        write  transaction  truncate  partition  mv  index  stats  export
        localFile  hasDatabaseLayer
kv：     ttl  scanPattern  keyTypes
doc：     aggregate  sample
vector：  vectorSearch  dim  metric  loadRelease
search：  mapping  alias  clusterHealth  reindex
ts：      timeRange  retention  downsample
graph：   subgraph  cypher
messaging：messaging  browseMessages  produceMessages  topicManagement
          consumerGroups  resetOffsets
```

本表同时列出设计能力与已落地能力；当前事实来源仍是前端 `src/db/drivers.ts`，Rust `db_capabilities` 尚未实现。Kafka 的 `databases` / `columns` 为 false，`messaging` 及上述消息能力位为 true；具体功能验收见 `FEATURE.md`。

调用约定：**菜单条目只依赖 caps，不依赖类型名**。

```ts
{ id: "explain", label: "执行计划", when: (c) => c.caps.explain }
```

---

## 八、新增一种类型的成本

| 场景 | 改动 |
|---|---|
| 大类已存在（StarRocks、MariaDB、Valkey、OpenSearch …） | `src/db/drivers.ts` 加 1 条 + 后端 `src-tauri/src/db/<driver>.rs` + `db/mod.rs` 分发 + `lib.rs` 注册；**前端菜单 0 改动**，只补方言转义规则 |
| 新增大类（`messaging` 等） | 增加容器 / 对象层定义与必要能力位；无库层可用空容器菜单。复杂交互使用专用工作区，通用菜单外壳不动 |

---

## 九、落地文件清单

| 文件 | 动作 | 状态 |
|---|---|---|
| `src/db/drivers.ts` | 新增：`DriverMeta` 注册表（kind / caps / 默认端口 / 颜色 / 层级叫法 / 方言转义） | 已完成 |
| `src/db/menuItems.ts` | 连接级统一；容器 / 对象级按 8 大类定义；messaging 库级空定义、Topic 对象级能力入口 | 已完成；Kafka 集群联调待验证 |
| `src/components/ContextMenu.tsx` | 新增：通用外壳（定位 / 边界翻转 / 外部点击关闭 / 键盘 / 危险项 / 规划中灰显） | 已完成 |
| `src/components/LeftPanel.tsx` | 改：连接 / 库 / 表 / 列四类节点挂 `onContextMenu`，只产出 `{ kind, conn, driver, db?, table?, column? }`，不写类型分支 | 已完成 |
| `src/components/ConnectionDialog.tsx` | 改：默认端口改读 `defaultPortOf()`（去掉重复的 `DEFAULT_PORTS`） | 已完成 |
| `src/styles.css` | 改：新增 `.ctx-menu` / `.ctx-item` / `.ctx-sep` / `.ctx-tag` | 已完成 |
| `src/types.ts` | 改：`db_type` 放开为 `string`（新类型由注册表驱动，不再改联合类型） | 已完成 |
| `src/store.ts` | 改：新增 `refreshConnection(id)` | 已完成 |
| `src-tauri/src/db/mssql.rs` | 新增：SQL Server 连接器（tiberius / TDS），`db/mod.rs` 按 `db_type` 分发到该模块 | 已完成（2026-10-09，联调待验证） |
| `src-tauri/src/db/mod.rs` | 改：加 `capabilities(db_type) -> Capability`，作为能力事实来源 | 未完成（前端注册表先行） |
| `src-tauri/src/lib.rs` | 改：在 `tauri::generate_handler![...]` 注册 `db_capabilities` | 未完成 |
| `src/api.ts` / `src/store.ts` | 改：暴露 `api.capabilities()`，`init` 时缓存 | 未完成 |

后续顺序：先把 `planned` 条目按大类逐个落地（当前 MySQL / PG / Redis 的常用项已可用），再随新增驱动补齐 Rust `capabilities`。
