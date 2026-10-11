# OrbitData

AI 原生的数据管理工具 —— **用对话操作你的数据**。

OrbitData 的设计思想参考原生 AI IDE(如 Trae):**以 AI 对话为主要驱动**,SQL 编辑器与结果面板作为辅助查看窗口。你只需要描述想要什么,AI 生成 SQL、执行、可视化一条龙完成。

## 特性一览

- **对话驱动**:内置 AI 助手,自动感知当前连接与数据库上下文,生成的 SQL 可一键"运行"
- **多连接管理**:直接可用 MySQL / PostgreSQL / SQL Server / Redis / Elasticsearch / Kafka,树状浏览数据库 → 表/视图 → 字段；ES 为连接 → 索引 → Mapping 字段,Kafka 为连接 → Topic
- **国产 / 信创登记**:达梦、人大金仓 Kingbase、南大通用 GBase、神舟通用 Oscar(信创四大)以及 PolarDB、openGauss 共 6 种已登记能力(端口 / 层级 / 菜单),后端连接器尚未实现;PolarDB 可按 MySQL 类型、Kingbase / openGauss 可按 PostgreSQL 类型填实际端口连接(未验证),详见 [DATABASES.md](./DATABASES.md) 第 3.11 节
- **Kafka 消息工作区（实现中）**:新增 `messaging` 第八大类，Topic 直挂连接；专用标签页浏览集群与消息、生产消息、管理 Topic 和 Consumer Group。RabbitMQ / RocketMQ / Pulsar 仅作为大类代表，尚未实施
- **AI 模型自定义**:支持任意 OpenAI 兼容接口(OpenAI / DeepSeek / Ollama / vLLM 等),可配置地址、密钥、模型 ID、temperature、附加参数,多模型随时切换
- **SQL 编辑器**:行号、快捷键运行(⌘+Enter)、简易格式化、常用查询保存
- **数据可视化**:查询结果一键切换表格 / 图表(柱状、折线,自动识别数值列)
- **Git 同步**:将连接信息与 AI 模型配置导出到 Git 仓库,多设备同步
- **轻量**:Tauri 2 框架,原生 WebView + Rust 后端,体积远小于 Electron 方案

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面框架 | Tauri 2(Rust) |
| 前端 | React 18 + TypeScript + Vite + Zustand |
| 数据库驱动 | sqlx(MySQL / PostgreSQL)、tiberius(SQL Server / TDS)、redis-rs、reqwest(Elasticsearch REST/DSL) |
| 消息客户端 | rdkafka 0.39 / librdkafka（`cmake-build`、`ssl-vendored`），独立 Kafka 消息工作区；不走 SQL 查询协议 |
| AI 接入 | reqwest 流式调用 OpenAI Chat Completions、OpenAI Responses、Anthropic 接口（兼容旧 Gemini 配置） |
| 同步 | 系统原生 git |

## 快速开始

```bash
npm install
npm run tauri dev     # 开发模式
npm run tauri build   # 构建发布包
```

> 依赖:Node.js ≥ 18、Rust 工具链、CMake 与 C/C++ 构建工具；同步功能需要系统安装 git。Kafka 使用 rdkafka 0.39，启用 `cmake-build`、`ssl-vendored`，编译 librdkafka 与 OpenSSL 源码，需 Perl。macOS 可用 `brew install cmake` 安装 CMake。已通过前端类型检查与 Rust 编译，跨平台打包及真实集群验证仍待完成。

## 界面布局(三列式)

```
┌──────────────┃────────────────────────────┃──────────────────┐
│ 数据库连接     ┃  标签页: 对话 / 查询结果      ┃  SQL 编辑器       │
│ 数据库对象     ┃  AI 对话流                  ┃  [数据库选择]      │
│ ├ db         ┃   · SQL 代码块 → 一键运行     ┃  [编辑区+行号]     │
│ ├ 表 → 字段    ┃   · 结果表格 / 可视化         ┃  [运行/格式化/保存] │
│ └ …          ┃  [输入框 + 快捷操作]          ┃  [结果 / 可视化]   │
│ [左栏/右栏/设置]┃                            ┃                  │
└──────────────┃────────────────────────────┃──────────────────┘
       ↕ 拖动分隔条              ↕ 拖动分隔条
```

- **左栏**:数据库连接 + 对象树(数据库/表/视图/字段,合并为一列);底部一排图标为「收起/展开左栏、收起/展开右栏、设置」
- **中栏**:对话标签页(主要交互)+ 查询结果标签页(表格/图表)；Kafka 使用独立消息工作区标签页，包含元数据、消息浏览、生产、Topic 管理与消费组管理
- **右栏**:SQL 编辑器,可独立运行、格式化、保存,结果表格与可视化；Kafka 操作不经 SQL 编辑器
- **宽度可调**:左栏与中栏、中栏与右栏之间均有分隔条,拖动即可调整宽度(自动记忆);双击分隔条恢复默认宽度

## 使用说明

1. **配置 AI 模型**:设置 → AI 模型 → 添加模型(填接口地址、API Key、模型 ID)
2. **添加连接**:左栏 `+` → 选择类型(MySQL / PostgreSQL / SQL Server / Redis / Elasticsearch / Kafka)→ 测试并保存。ES 默认端口 9200，主机可填 `https://es.example.com`，HTTPS 证书需受信任，用户名/密码可留空（匿名访问）或用于 Basic Auth。SQL Server 默认端口 1433，使用 SQL Server 身份认证（用户名 / 密码），见下方专门说明。国产 / 信创库尚未开放独立入口：PolarDB 可先选 MySQL 类型、Kingbase / openGauss 可先选 PostgreSQL 类型并填实际端口（未验证），达梦 / GBase / Oscar 需要等待连接器落地
3. **开始对话**:选中连接后直接向 AI 提问,SQL 或 `elasticsearch` 代码块点击「运行」即可执行并打开结果页。ES 也可右键索引预览，或在控制台输入 `GET /_cluster/health`；查询支持 `POST /example-index/_search` 后换行填写 JSON，选中索引后可直接填写 JSON DSL；当前仅支持只读接口
4. **同步配置**:设置 → Git 同步 → 配置仓库路径(可填远程 URL)→ 初始化 → 提交并推送;其他设备「拉取同步」即可还原全部连接与模型配置

### Kafka 工作区（代码完成，真实集群验收待进行）

- 新建 Kafka 连接时填写多个 bootstrap brokers（每行一个 `host:port`，如 `broker.example.com:9092`）；客户端还必须能访问集群返回的 advertised broker 地址，不能只保证 bootstrap 地址可达。
- 连接右键「打开消息工作区」、Topic 双击或右键入口打开专用标签页；Topic 直挂连接，没有库选择器，Partition 在详情查看，不是表字段。
- 浏览消息按 earliest / latest / recent / offset / timestamp 定位，可选全部或单个 Partition；text / hex / JSON 查看消息，可导出 JSON。最近 N 条历史与从现在监听分开；监听串行有限时轮询并以 next offsets 续读，不提交消费位点。停止监听、切换 / 关闭标签页或断开 / 编辑 / 删除连接后停止后续轮询。
- 生产页 key / value 可分别选择 text / hex（二进制），并填写 partition、headers；tombstone 表示 null 而非空字符串。管理页提供 Topic 创建 / 删除 / 增加分区 / 配置及 Consumer Group 成员、lag、inactive group 位点重置与删除；重置需显式选 Topic 与该 Topic 全部 / 单分区，不默认重置整个组，按 earliest / latest / offset / timestamp 定位，确认展示完整范围与目标。
- 已接入 `PLAINTEXT` / `SSL` / `SASL_PLAINTEXT` / `SASL_SSL`，SASL 机制限 `PLAIN` / `SCRAM-SHA-256` / `SCRAM-SHA-512`；TLS 支持系统或自定义 CA 与可选客户端证书 / 私钥，暂不支持加密私钥口令。IPv6 地址使用 `[host]:port`。编译检查通过，但真实集群认证矩阵尚未验证。Schema Registry、Avro / Protobuf、OAuth / Kerberos、ACL 管理与分区重分配未实现。
- 浏览使用 `read_committed`，水位差与 Lag 是 Offset 距离，不保证等于消息条数；成员 assignment 暂以原始 hex 展示。每次读取最多 500 条 / 10 MiB / 256 个分区；消费组查询最多 2048 个分区。修改配置使用增量 Admin API（需 Kafka 2.3+），位点重置需 broker 支持对应 Admin API，旧集群可能返回不支持。

### SQL Server 连接

- 默认端口 1433,使用 SQL Server 身份认证(用户名 + 密码);暂不支持 Windows 集成认证 / AAD 与命名实例(SQL Browser)
- 连接走 TDS:加密保持开启但**不校验服务器证书**(`TrustServerCertificate`),自签或内网证书可直接连上;需要严格校验证书的环境请先确认风险
- 对象树:库级 = database,表级 = 表 / 视图;`dbo` 下的表不带前缀,其他 schema 显示为 `schema.table`,标识符按 `[name]` 转义
- 方言差异:取前 N 行用 `TOP n`(不是 `LIMIT`),执行计划用 `SET SHOWPLAN_ALL ON`(不是 `EXPLAIN`);菜单生成的预览 / 模板 / 结构查询已按方言区分
- 不支持客户端批处理分隔符 `GO`;一次执行多条语句时只展示第一个结果集

## 隐私与安全

- 连接信息与 API Key 仅保存在本机应用配置目录(`config.json`)
- Git 同步文件包含数据库密码、Kafka SASL 密码与证书路径等明文敏感配置,**请使用私有仓库**；CA / 客户端证书 / 私钥文件本身不会同步，其他设备需单独部署并重新确认路径
- Kafka 新字段可选并以 `serde(default)` 兼容既有配置；旧版本读写含新字段的配置可能丢失这些字段，跨设备应使用支持 Kafka 的相同或更新版本
- 消息 JSON 导出可能包含业务敏感数据，请仅保存到受控位置；不要把证书、私钥或真实配置提交到公开仓库
- AI 请求直接从本机发往你配置的接口地址,不经过任何中间服务器

## 文档

- 功能详情与开发进度:[FEATURE.md](./FEATURE.md)
- 数据库支持列表与状态:[DATABASES.md](./DATABASES.md)

