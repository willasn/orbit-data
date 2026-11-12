# DATABASES.md — 数据库支持列表

> 更新日期: 2026-11-10 · 版本: v0.1.7 · ClickHouse 完成 ①②③ 三层（`clickhouse.rs` 后端连接器 + 创建入口 + 能力注册表），走 HTTP 接口（8123 / HTTPS 8443），已在 ClickHouse 26.8 真实环境完成冒烟；此前的 SQL Server、messaging / Kafka、storage / 阿里云 OSS 与 6 种国产 / 信创数据库登记保持不变
> 本文件是「哪些数据库能用、用到什么程度」的唯一清单。能力位与菜单设计见 [CONTEXT_MENU.md](./CONTEXT_MENU.md)，功能进度见 [FEATURE.md](./FEATURE.md)。
> 各连接类型的长期说明（配置、层级、界面操作、安全与测试）按类型拆分到 [docs/data-sources/](./docs/data-sources/)，当前已建立 [阿里云 OSS](./docs/data-sources/aliyun-oss.md) 与 [ClickHouse](./docs/data-sources/clickhouse.md)；后续新增类型在同一目录按 `<db_type>.md` 补充。

## 一、支持状态图例

| 标记 | 状态 | 含义 |
|---|---|---|
| ✅ | **已支持** | 后端有连接器 + 新建连接可选 + 对象树与菜单操作形成完整闭环 |
| 🟡 | **协议兼容（未验证）** | 无独立连接器、创建入口未开放；可「选同类已支持类型 + 对应端口」连接，社区协议兼容但未做方言适配与回归验证 |
| 🔵 | **已注册 · 待实现** | 能力注册表已登记（端口 / 层级叫法 / caps），右键菜单可渲染；后端无连接器、创建入口未开放 |
| ⚪ | 未注册 | 尚不在注册表中，见「规划类型」 |

判定依据是三个互相独立的层次，读表前先理解它们：

| 层次 | 位置 | 未落地的后果 |
|---|---|---|
| ① 后端连接器 | `src-tauri/src/db/<driver>.rs` + `db/mod.rs` 分发 | 连不上、报错「不支持的数据库类型」 |
| ② 新建连接入口 | `src/components/ConnectionDialog.tsx` 的 `TYPE_META` | 界面上选不到该类型 |
| ③ 能力注册表 / 菜单 | `src/db/drivers.ts`、`src/db/menuItems.ts` | 菜单文案与操作集不对 |

三者必须都齐才算已支持。当前 MySQL / PostgreSQL / SQL Server / ClickHouse / Redis / Elasticsearch / Kafka 的 ①②③ 齐全；Elasticsearch 当前限定只读浏览与查询，SQL Server 与 Kafka 的真实环境 / 集群验收仍待进行，ClickHouse 已在 26.8 上完成真实环境联调。

---

## 二、总览（按大类）

按 `src/db/drivers.ts` 的 `DRIVER_LIST` 实际计数：**38 种、9 大类**（不含未知类型兜底；RabbitMQ / RocketMQ / Pulsar 未注册）。Kafka 代码已完成并通过编译检查，仍单独计入「待集群验收」列，避免将编译通过误视为真实集群验收通过。
另登记 6 种国产 / 信创数据库：达梦 DM、人大金仓 Kingbase、南大通用 GBase、神舟通用 Oscar（信创四大）以及 PolarDB、openGauss —— 均为仅注册，详见 [3.11](#311-国产--信创数据库暂无后端连接器)。

| 大类 `kind` | 已支持 | 协议兼容（未验证） | 已注册待实现 | 实现中 / 待验收 | 小计 |
|---|---|---|---|---|---|
| `sql` 关系型 / OLAP / 文件型 | 3 | 7 | 11 | 0 | 21 |
| `kv` 键值缓存 | 1 | 2 | 1 | 0 | 4 |
| `doc` 文档 | 0 | 0 | 1 | 0 | 1 |
| `vector` 向量 | 0 | 0 | 2 | 0 | 2 |
| `search` 全文检索 | 1 | 0 | 1 | 0 | 2 |
| `ts` 时序 | 0 | 1 | 3 | 0 | 4 |
| `graph` 图 | 0 | 0 | 2 | 0 | 2 |
| `messaging` 消息流 / 消息队列 | 0 | 0 | 0 | 1 | 1 |
| `storage` 对象存储 | 1 | 0 | 0 | 0 | 1 |
| **合计** | **6** | **10** | **21** | **1** | **38** |

---

## 三、明细

列含义：**后端**=①连接器 · **入口**=②新建连接可选 · **菜单**=③注册表与菜单 · **树层级**=库级/表级叫法（取自 `drivers.ts`）

### 3.1 `sql` — 关系型

| 类型 | 标签 | 默认端口 | 后端 | 入口 | 菜单 | 状态 | 说明 |
|---|---|---|---|---|---|---|---|
| `mysql` | MySQL | 3306 | ✅ | ✅ | ✅ | ✅ | SHOW DATABASES / FULL TABLES / FULL COLUMNS；查询、建库建表、执行计划、DDL 查看全部可用 |
| `postgres` | PostgreSQL | 5432 | ✅ | ✅ | ✅ | ✅ | `information_schema` 读表与列；暂不读主键与注释（见 FEATURE.md 已知限制） |
| `mariadb` | MariaDB | 3306 | — | — | ✅ | 🟡 | 可选 MySQL 类型连接；元数据方言高度相近但未验证 |
| `tidb` | TiDB | 4000 | — | — | ✅ | 🟡 | 同上，MySQL 协议兼容 |
| `oceanbase` | OceanBase | 2881 | — | — | ✅ | 🟡 | 仅 MySQL 模式端口可行；Oracle 模式不支持 |
| `timescaledb` | TimescaleDB | 5432 | — | — | ✅ | 🟡 | PG 扩展，可选 PostgreSQL 类型连接；超表按普通表浏览，`caps.timeRange / retention` 未落地 |
| `oracle` | Oracle | 1521 | — | — | ✅ | 🔵 | 层级映射为 schema = 用户 |
| `sqlserver` | SQL Server | 1433 | ✅ | ✅ | ✅ | ✅ | TDS（tiberius）；`sys.databases` / `sys.objects` / `sys.columns`，dbo 表不带前缀，其余 schema 显示 `schema.table`；真实环境联调待进行 |
| `dm` | 达梦 DM 🇨🇳 | 5236 | — | — | ✅ | 🔵 | Oracle 风格 schema；国产信创，详见 3.11 |
| `polardb` | PolarDB 🇨🇳 | 3306 | — | — | ✅ | 🟡 | 阿里云云原生，MySQL 协议族；可选 MySQL 类型连接，未验证方言差异 |
| `kingbase` | 人大金仓 Kingbase 🇨🇳 | 54321 | — | — | ✅ | 🟡 | PG 协议族，默认端口非 5432；可选 PostgreSQL 类型连接，未验证 |
| `opengauss` | openGauss 🇨🇳 | 5432 | — | — | ✅ | 🟡 | PG 协议族；可选 PostgreSQL 类型连接，未验证 |
| `gbase` | 南大通用 GBase 🇨🇳 | 5258 | — | — | ✅ | 🔵 | GBase 8a/8s 端口不同；国产信创，仅登记 |
| `oscar` | 神舟通用 Oscar 🇨🇳 | 2003 | — | — | ✅ | 🔵 | Oracle 风格「模式」层级 |

> 🇨🇳 表示国产 / 信创登记类型；状态说明统一见 [3.11](#311-国产--信创数据库暂无后端连接器)。

### 3.2 `sql` — OLAP / 分析型

| 类型 | 标签 | 默认端口 | 后端 | 入口 | 菜单 | 状态 | 说明 |
|---|---|---|---|---|---|---|---|
| `clickhouse` | ClickHouse | 8123 | ✅ | ✅ | ✅ | ✅ | HTTP 接口（HTTPS 常用 8443，原生 TCP 9000 不支持）；`system.databases` / `system.tables` / `system.columns`，建库与 Engine + ORDER BY 建表设计器已实现；已在 26.8 真实环境完成连接、对象树、查询与建表写入冒烟 |
| `doris` | Doris | 9030 | — | — | ✅ | 🔵 | MySQL 线协议 9030，未适配元数据方言 |
| `starrocks` | StarRocks | 9030 | — | — | ✅ | 🔵 | 同上 |
| `hive` | Hive | 10000 | — | — | ✅ | 🔵 | 只读定位（`caps.write: false`） |
| `trino` | Trino | 8080 | — | — | ✅ | 🔵 | catalog → schema 双层未实现；只读 |

### 3.3 `sql` — 本地文件型（`caps.localFile`）

| 类型 | 标签 | 默认端口 | 后端 | 入口 | 菜单 | 状态 | 说明 |
|---|---|---|---|---|---|---|---|
| `sqlite` | SQLite | — | — | — | ✅ | 🔵 | 本地文件库，`caps.databases: false`（单库，无需选库）；连接表单仍是主机/端口模式，未做文件选择适配 |
| `duckdb` | DuckDB | — | — | — | ✅ | 🔵 | 同上 |

### 3.4 `kv` — 键值 / 缓存

| 类型 | 标签 | 默认端口 | 后端 | 入口 | 菜单 | 状态 | 说明 |
|---|---|---|---|---|---|---|---|
| `redis` | Redis | 6379 | ✅ | ✅ | ✅ | ✅ | 逻辑库 db0–db15 → 键；SCAN 列表、查看值（string/hash/list/set/zset/stream）、TTL、重命名、持久化、删除、新建键、清空库均可用；列级不适用 |
| `valkey` | Valkey | 6379 | — | — | ✅ | 🟡 | RESP 兼容，可选 Redis 类型连接（未验证） |
| `dragonfly` | Dragonfly | 6379 | — | — | ✅ | 🟡 | 同上 |
| `memcached` | Memcached | 11211 | — | — | ✅ | 🔵 | 扁平键空间，无库层 |

### 3.5 `doc` — 文档

| 类型 | 标签 | 默认端口 | 后端 | 入口 | 菜单 | 状态 | 说明 |
|---|---|---|---|---|---|---|---|
| `mongodb` | MongoDB | 27017 | — | — | ✅ | 🔵 | 数据库 → 集合 → 字段（`$sample` 推断）；`caps.aggregate / sample` 待落地 |

### 3.6 `vector` — 向量

| 类型 | 标签 | 默认端口 | 后端 | 入口 | 菜单 | 状态 | 说明 |
|---|---|---|---|---|---|---|---|
| `milvus` | Milvus | 19530 | — | — | ✅ | 🔵 | 有库层 → Collection → field；`vectorSearch / loadRelease` 待落地 |
| `qdrant` | Qdrant | 6333 | — | — | ✅ | 🔵 | 无库层，Collection 直挂连接 |

### 3.7 `search` — 全文检索

| 类型 | 标签 | 默认端口 | 后端 | 入口 | 菜单 | 状态 | 说明 |
|---|---|---|---|---|---|---|---|
| `elasticsearch` | Elasticsearch | 9200 | ✅ | ✅ | ✅ | ✅ | 只读支持；连接 → 索引 → Mapping 字段；REST/DSL、预览、计数、Mapping/Settings、控制台集群健康；HTTP/HTTPS + 可选 Basic Auth |
| `opensearch` | OpenSearch | 9200 | — | — | ✅ | 🔵 | 同上 |

### 3.8 `ts` — 时序

| 类型 | 标签 | 默认端口 | 后端 | 入口 | 菜单 | 状态 | 说明 |
|---|---|---|---|---|---|---|---|
| `influxdb` | InfluxDB | 8086 | — | — | ✅ | 🔵 | Bucket → Measurement → field/tag key；`timeRange / retention` 待落地 |
| `tdengine` | TDengine | 6030 | — | — | ✅ | 🔵 | 数据库 → 超级表 / 子表 → column / tag |
| `prometheus` | Prometheus | 9090 | — | — | ✅ | 🔵 | 无库层，指标 metric → label；只读 |
| `questdb` | QuestDB | 8812 | — | — | ✅ | 🟡 | PG 线协议 8812，可选 PostgreSQL 类型连接（未验证）；`caps.databases: false` |

### 3.9 `graph` — 图

| 类型 | 标签 | 默认端口 | 后端 | 入口 | 菜单 | 状态 | 说明 |
|---|---|---|---|---|---|---|---|
| `neo4j` | Neo4j | 7687 | — | — | ✅ | 🔵 | 数据库 → 标签 → property；Cypher 控制台待落地 |
| `nebula` | NebulaGraph | 9669 | — | — | ✅ | 🔵 | Space → Tag / Edge → property；nGQL 待落地 |

---

### 3.10 `messaging` — 消息流 / 消息队列（第八大类）

| 类型 | 标签 | 默认端口 | 后端 | 入口 | 菜单 | 状态 | 说明 |
|---|---|---|---|---|---|---|---|
| `kafka` | Kafka | 9092 | ✅ | ✅ | ✅ | 代码完成，集群联调待验证 | rdkafka / librdkafka；无库层，连接 → Topic；Partition 在详情展示，不是列；独立消息工作区，不执行 SQL |

本大类代表还包括 RabbitMQ、RocketMQ、Pulsar，但本版本仅实施 Kafka，其他三种未注册、无连接器或创建入口；不宣称协议兼容。

Kafka 本版本已实现功能（前后端编译检查通过，真实集群验收待完成，详见 `FEATURE.md`）：

- 多 broker 配置及 SSL / SASL；集群 / broker / Topic 元数据、Partition leader / replicas / ISR、低 / 高水位。
- earliest / latest / recent / offset / timestamp 读取；有限时轮询监听，使用 next offsets 续读；text / hex key、payload、headers 与 JSON 导出。
- 生产消息支持 key、指定 partition、headers、tombstone；创建 / 删除 Topic、增加分区、查看 / 修改配置。
- Consumer Group 列表、成员、已提交位点与 lag；仅 inactive group 可重置 offset，须显式选 Topic 与该 Topic 全部 / 单分区，不默认重置整个组；支持 earliest / latest / offset / timestamp；删除消费组。
- 不包含 Schema Registry、Avro / Protobuf 解码、OAuth、Kerberos、ACL 管理、分区重分配；未做真实集群联调，不宣称支持所有安全协议。

---

### 3.11 国产 / 信创数据库（暂无后端连接器）

本次登记口径收窄：**只保留信创四大 + 两个最常用**共 **6 种**（另有大量国产产品未登记，见本节末尾）。它们**只完成 ③ 能力注册表**：端口、层级叫法、标识符引号与 `caps` 已在 `src/db/drivers.ts` 定义，右键菜单可按大类渲染；**① 后端连接器与 ② 新建连接入口均未开放**，创建入口仍只能选 MySQL / PostgreSQL / SQL Server / Redis / Elasticsearch / Kafka。

| 类型 `db_type` | 名称 | 大类 | 默认端口 | 协议族 | 状态 | 现在怎么用 |
|---|---|---|---|---|---|---|
| `dm` | 达梦 DM | sql | 5236 | Oracle 风格 | 🔵 | 未开放连接入口 |
| `kingbase` | 人大金仓 Kingbase ES | sql | 54321 | PostgreSQL | 🟡 | 新建连接选 **PostgreSQL**，端口填实际端口 |
| `gbase` | 南大通用 GBase | sql | 5258 | 自有方言 | 🔵 | 未开放连接入口 |
| `oscar` | 神舟通用 Oscar | sql | 2003 | Oracle 风格 | 🔵 | 未开放连接入口 |
| `polardb` | PolarDB | sql | 3306 | MySQL（PG 版另有端口） | 🟡 | 新建连接选 **MySQL** |
| `opengauss` | openGauss | sql | 5432 | PostgreSQL | 🟡 | 新建连接选 **PostgreSQL** |

判定口径（与既有协议兼容类型一致，不夸大支持范围）：

- **🟡 协议兼容**：产品自上而下兼容 MySQL 或 PostgreSQL 线协议，**可尝试**用对应的已支持类型连接，社区普遍可行；但本项目**未做方言适配与回归验证**，系统表 / `information_schema` 差异可能导致对象树或写操作不工作。
- **🔵 已注册待实现**：仅登记元数据，菜单可渲染但不保证任何连接行为；包含自有协议或方言差异较大的国产库。
- 未列入本节的常见国产产品（TDSQL、GaussDB、崖山 YashanDB、AnalyticDB、巨杉 SequoiaDB、浪潮 KaiwuDB、瀚高 HighGo、海量 Vastbase、中兴 GoldenDB、万里开源 GreatSQL、腾讯 Tendis 等）暂未登记；补录时属于「大类已存在、菜单零改动」，成本见 [第六节](#六把一种类型从-推到-要做的事)。

把其中任意一种推到 ✅ 的最小成本路径：**后端优先复用上游协议驱动**（`polardb` → `mysql.rs`，`kingbase` / `opengauss` → `pg.rs`），在 `db/mod.rs` 分发并在 `ConnectionDialog.tsx` 的 `TYPE_META` 开放创建入口，最后验证系统表 / `information_schema` 方言差异。

---

### 3.12 `storage` — 对象存储（第九大类）

| 类型 | 标签 | 默认端口 | 后端 | 入口 | 菜单 | 状态 | 说明 |
|---|---|---|---|---|---|---|---|
| `aliyun_oss` | 阿里云 OSS | 443 | ✅ | ✅ | ✅ | ✅ | Endpoint + AK/Secret + 可选 STS；连接 → Bucket；对象在独立工作区浏览，支持前缀分页、名称 / 时间正倒序、上传下载删除与临时下载地址；不执行 SQL |

详细说明（配置字段、权限要求、交互、排序限制、测试清单）见 [docs/data-sources/aliyun-oss.md](./docs/data-sources/aliyun-oss.md)。

---

## 四、能力矩阵（当前落地情况）

`caps` 描述「数据库本身具备的能力」，实际是否可用取决于菜单条目是否去掉 `planned` 标记。

| 能力 | 已落地 | 未落地（`planned`） |
|---|---|---|
| 连接测试 / 保存 / 编辑 / 删除 / 分组 | ✅ | — |
| 对象树：库 → 表/视图/键 → 列 | ✅ MySQL / PG / SQL Server / Redis | 其余类型 |
| 查询执行 + 结果表格 + 图表 | ✅ MySQL / PG | Redis 走命令结果表格 |
| 控制台模式 `console` | ✅ Redis | Mongo / InfluxDB / Prometheus / Neo4j / Nebula |
| 预览前 100 行、查看结构、SELECT 模板、EXPLAIN、行计数 | ✅ MySQL / PG / SQL Server（`sql` 大类共用实现，SQL 按方言生成） | 其余 SQL 类型因无连接器不可用 |
| 查看 / 导出 DDL `ddl` | ✅ MySQL（含视图）；`(查看结构)` PG | ClickHouse / Oracle 等方言 |
| 新建数据库 / 新建表 `write` | ✅ MySQL / PG | 其余类型 |
| 删除库 / 清空库 | ✅ MySQL / PG / Redis | 其余大类 |
| KV 查看值 / TTL / 重命名 / 持久化 / 删除键 `ttl` `keyTypes` | ✅ Redis | Memcached |
| 列统计 `stats` | ⚪ 菜单灰显 | 全部类型 |
| 分区 `partition` / 物化视图 `mv` / 索引 `index` | ⚪ 菜单灰显 | CK / Doris / Hive / PG |
| 导出 CSV / DDL | ⚪ 菜单灰显 | 全部类型 |
| 聚合管道 `aggregate` / 字段采样 `sample` | ⚪ | Mongo |
| 向量检索 `vectorSearch` / 加载释放 `loadRelease` | ⚪ | Milvus / Qdrant |
| 映射 `mapping` / 集群健康 `clusterHealth` | ⚪ | ES / OpenSearch |
| 时间范围 `timeRange` / 保留策略 `retention` | ⚪ | InfluxDB / TDengine / TimescaleDB |
| 子图可视化 `subgraph` | ⚪ | Neo4j / NebulaGraph |
| 本地文件选择 `localFile` | ⚪ | SQLite / DuckDB |
| 消息工作区 `messaging` / 浏览 `browseMessages` / 生产 `produceMessages` | [~] Kafka 实现中，未验收 | RabbitMQ / RocketMQ / Pulsar 未注册、未实施 |
| Topic 管理 `topicManagement` / 消费组 `consumerGroups` / 位点重置 `resetOffsets` | [~] Kafka 实现中，重置仅 inactive group | OAuth / Kerberos / ACL / 重分配未实施 |

---

## 五、规划类型（尚未注册）

以下类型暂未进注册表，新增时属于「大类已存在」，前端菜单零改动：

- `vector`：Weaviate（CONTEXT_MENU.md 已按此假设设计）
- `ts`：VictoriaMetrics、GreptimeDB、浪潮 KaiwuDB
- `search`：Solr、ZincSearch
- `doc`：巨杉 SequoiaDB
- `sql`：Presto、Greenplum、TDSQL、GaussDB、崖山 YashanDB、AnalyticDB、瀚高 HighGo、海量 Vastbase、中兴 GoldenDB、万里开源 GreatSQL、ClickHouse Cloud（同 CK）
- `messaging`：RabbitMQ、RocketMQ、Pulsar —— 第八大类已登记，仍需各自连接器、命名空间层级和专用工作区适配；Kafka 已注册并实现中

---

## 六、把一种类型从 🔵 推到 ✅ 要做的事

1. **后端连接器**：新增 `src-tauri/src/db/<driver>.rs`，实现适用的连接测试和元数据 / 操作接口；无库 / 列层不伪造节点。Kafka 使用专用命令，不要求 `query` 执行 SQL。
2. **分发**：`src-tauri/src/db/mod.rs` 的 `match c.db_type` 各函数加分支。
3. **命令注册**：`src-tauri/src/lib.rs` 的 `tauri::generate_handler![...]`（如有新命令）。
4. **前端入口**：`src/components/ConnectionDialog.tsx` 的 `TYPE_META` 加一项（开放入口仅限①②已齐的类型）。
5. **能力表**：`src/db/drivers.ts` 补 `createDialect`（决定建库/建表/新建键的方言），必要时调 `caps`。
6. **去灰显**：`src/db/menuItems.ts` 中对应条目去掉 `planned: true`。
7. **同步文档**：本文件状态列 + [FEATURE.md](./FEATURE.md) 对应章节。

> 大类已存在时复用能力驱动菜单，不按 `db_type` 分支；专用交互仍需工作区适配。新增大类应增加必要能力位及容器 / 对象层约定，无库层可保留空容器定义，不伪造数据库节点。Kafka 命令需同步 `lib.rs` 注册、`api.ts` 封装与 `types.ts` 类型。
