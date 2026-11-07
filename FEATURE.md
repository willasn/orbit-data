# FEATURE.md — 功能清单与开发进度

> 更新日期: 2026-11-02 · 版本: v0.1.5 · 新增 MQTT 连接与消息工作区（rumqttc 0.25；MQTT 5.0 / 3.1.1 连接、订阅、发布与收发已用测试 Broker 验证）；此前新增 SQL Server 连接器（tiberius / TDS，编译检查通过，真实环境联调待进行）与 messaging 大类 / Kafka 专项、5 种国产 / 信创数据库登记（仅注册，无后端连接器）

图例: [x] 已完成 · [~] 部分完成 · [ ] 规划中

## 1. 连接管理

- [x] 新建/编辑/删除数据库连接(名称、主机、端口、用户名、密码、默认库、标识颜色)
- [x] 直接可用:MySQL、PostgreSQL、SQL Server、Redis、Elasticsearch、Kafka、MQTT 七种类型具备后端连接器与创建入口
- [~] 国产 / 信创:达梦 DM、人大金仓 Kingbase、南大通用 GBase、神舟通用 Oscar(信创四大)+ PolarDB、openGauss 共 6 种仅完成能力注册表,后端无连接器、创建入口未开放;MySQL / PG 协议族类型可尝试用对应已支持类型连接(未验证),详见 [DATABASES.md](./DATABASES.md) 第 3.11 节
- [x] Elasticsearch: HTTP/HTTPS（验证证书）、可选 Basic Auth、连接测试、索引直挂连接、嵌套 Mapping 与 multi-fields 浏览
- [x] Elasticsearch: 只读 REST/JSON DSL 控制台、JSON 格式化、文档预览、Mapping/Settings、文档计数；搜索默认 500 条、上限 1000 条，聚合结果保留 JSON
- [x] Elasticsearch: AI 生成 `elasticsearch` 请求代码块，可一键运行；不支持索引写操作、API Key、自定义 CA 或深分页
- [x] 连接测试(保存前可验证)
- [x] MySQL: SHOW DATABASES / SHOW FULL TABLES / SHOW FULL COLUMNS
- [x] PostgreSQL: pg_database / information_schema(默认 public schema)
- [x] Redis: SCAN 键列表(循环扫描直到游标归零,上限 1 万键)、任意命令执行
- [x] SQL Server: `sys.databases` 取用户库(排除四个系统库)、`sys.objects` 取表 / 视图、`sys.columns` 取列(含长度 / 精度、主键、MS_Description 注释)
- [x] SQL Server: 查询执行与方言适配(取前 N 行用 `TOP n`、执行计划用 `SET SHOWPLAN_ALL ON`、标识符按 `[name]` 转义、`schema.table` 限定名)
- [x] 对象树:连接 → 数据库 → 表/视图 → 字段(含类型、主键标记)
- [x] 对象树交互:连接行点击可折叠/再次展开(收起保留选中与已加载缓存)、多连接可同时展开
- [x] 对象树加载态:展开层级显示旋转图标 + 「正在加载中…」,失败显示「加载失败,点击重试」
- [x] 对象树长列表按需渲染:各层级首屏 100 条,滚动到底或点击「加载更多(剩余 N)」增量追加
- [x] 右键菜单框架:连接级统一 + 库级/表级按大类 + 列级统一(能力位 `caps` 驱动,见 [CONTEXT_MENU.md](./CONTEXT_MENU.md))
- [x] 数据库能力注册表 `src/db/drivers.ts`:按 `DRIVER_LIST` 实际统计为 37 种、8 大类（含已注册的 Kafka 与 6 种国产 / 信创类型；不含未知类型兜底），注册不等于已有连接器；既有大类新增类型复用菜单能力定义
- [x] 连接级菜单:新建数据库…(CREATE DATABASE,按方言,成功后刷新树)、刷新元数据、编辑、重命名、复制为新建、测试连接、复制地址(不含密码)、复制 AI 上下文、删除连接
- [x] 库级菜单(MySQL / PG):新建数据库…、新建表…(表设计窗口配置字段/主键/自增并预览 DDL,创建后刷新树)、删除库(DROP DATABASE,手输库名二次确认,成功后刷新树)
- [x] 库级菜单(Redis):新建键…(窗口输入字符串值及可选 TTL,仅不存在时创建并刷新键列表)、清空当前逻辑库(SELECT + FLUSHDB,手输库号二次确认)
- [~] Valkey / Dragonfly 等注册类型尚无后端连接器,创建入口暂不开放
- [ ] 其余大类(Mongo / 向量 / 检索 / 时序 / 图)的新建与删除条目:ES 已有只读连接器，写操作与其他类型连接器仍未实现，菜单保持「规划中」灰显
- [x] 表级菜单(MySQL / PG / SQL Server):预览前 100 行、查看结构、SELECT 模板、执行计划(SQL Server 用 SHOWPLAN_ALL)、行计数、复制表名(SQL 按方言生成)
- [x] MySQL 表/视图右键独立「查看 DDL」:使用 SHOW CREATE TABLE / VIEW，完整展示多行定义
- [x] 表级菜单(Redis 键):查看值(按 TYPE 展开成表格:string 单值、hash 字段/值、list 序号/值、set 成员、zset 成员/分值、stream ID/字段,表头附类型与 TTL;HSCAN/SSCAN/ZSCAN 循环取数,上限 500 项)、查看 TTL、设置过期、重命名键、持久化、删除键
- [~] 其余库级 / 表级条目(库概览、导出 DDL、导出 CSV、索引与约束、分区信息、写操作等):菜单中标注「规划中」
- [x] 连接分组:连接配置 `group` 字段、左栏分组头(可折叠,组内缩进)、右键「移动到分组…」(留空移出分组)、折叠状态本地记忆
- [x] 连接 / 断开:右键「连接 / 断开连接」、左栏状态点(绿=已连接)、断开后清空该连接元数据缓存、断开态执行 SQL 自动重连
- [ ] SSH 隧道 / 通用数据库 SSL 连接参数（Kafka 专用 SSL / SASL 见第 8 节）
- [ ] SQLite / ClickHouse / MongoDB 连接器
- [ ] 国产信创连接器:优先复用上游协议(PolarDB → MySQL 驱动,Kingbase / openGauss → PG 驱动),随后才是达梦 / GBase / Oscar 的独立方言适配

## 2. AI 对话(核心)

- [x] 对话为主驱动的交互模式(多对话标签页)
- [x] AI 流式输出(SSE,Tauri Channel 通道)
- [x] 上下文感知:自动注入当前连接类型、地址、所选数据库
- [x] 中栏上下文选择:已保存连接及按驱动能力递进选择库/表(键)/字段,所选对象注入对话提示
- [x] 对话级模型选择:中栏切换已配置模型,删除后回退默认模型
- [x] SQL / Redis 命令代码块识别,支持「复制」与「一键运行」
- [x] 轻量 Markdown 渲染(粗体、行内代码、代码块)
- [x] 空状态快捷建议卡片(生成 SQL / 数据分析 / 优化建议 / 字段解释)
- [x] 对话历史随请求发送(最近消息)
- [x] 历史会话本地持久化（浏览器本地存储）、历史列表切换与新建会话；关闭标签保留历史
- [x] 单气泡展示生成回复、用户消息复制与清空当前会话
- [x] 会话首问自动命名、历史及当前标签右键置顶/删除；顶部图标操作
- [ ] 对话中引用表/字段(右键发送上下文)
- [ ] AI 工具调用(自动执行 SQL 并基于结果回答,Agentic 模式)
- [x] 停止生成按钮:生成中发送按钮变为停止(红色),点击后中断后端 SSE 读取并保留已生成内容,回答气泡标注「已中断」

## 3. AI 模型配置

- [x] 多模型自定义:名称、接口地址、API Key、模型 ID
- [x] 新增模型协议:OpenAI Chat Completions、OpenAI Responses、Anthropic（旧 Gemini 配置仍可使用）
- [x] 模型能力配置:可选输入/输出 token 大小(留空跟随模型)、图片输入支持标记
- [ ] 图片上传和多模态消息发送
- [x] 默认模型切换(⭐ 设为默认)
- [x] 模型编辑/删除
- [x] 模型连通性测试按钮:实际请求所选协议的模型,测试通过后才能保存;协议地址后缀提示
- [ ] 按连接绑定专用模型

## 4. SQL 编辑器(辅助窗口)

- [x] 行号显示、等宽编辑区
- [x] ⌘/Ctrl + Enter 快捷运行
- [x] 简易格式化(关键字大写 + 子句换行)
- [x] 常用查询保存(localStorage,最近 20 条)
- [x] 数据库选择下拉
- [x] Redis 命令模式(直接执行 redis 命令)
- [ ] 语法高亮(CodeMirror 6 按需引入)
- [ ] 智能补全(基于对象树元数据)
- [ ] 执行计划查看(EXPLAIN)

## 5. 结果查看与可视化

- [x] 通用查询结果表格(列名、行号、NULL 识别、数值高亮)
- [x] 结果标签页(中栏)+ 右栏结果区双视图
- [x] 执行耗时与行数统计(结果集上限 500 行)
- [x] SVG 图表:自动识别分类列与数值列,柱状/折线切换,多系列
- [ ] 悬浮 tooltip 与坐标缩放
- [ ] CSV / Excel 导出
- [ ] 单元格编辑与提交(UPDATE 生成)
- [ ] 大结果集虚拟滚动

## 6. Git 同步

- [x] 连接信息 + AI 模型配置导出为 `orbit-data-sync.json`
- [x] 本地 Git 仓库初始化、提交
- [x] 远程仓库推送 / 拉取(还原全部配置)
- [x] 同步状态查看(分支、最新提交、待同步变更)
- [x] 同步配置表单(仓库路径、远程 URL、分支)
- [ ] 自动推送(auto_push 定时/变更触发)
- [ ] 敏感字段(密码)加密后再同步
- [ ] 同步冲突合并策略

## 7. 工程与体积优化

- [x] Tauri 2 框架(系统 WebView,无 Chromium 打包)
- [x] `[profile.dev] debug = "line-tables-only"`,依赖无调试信息
- [x] `[profile.release]` lto + opt-level="s" + strip + panic="abort"
- [x] 前端轻依赖(React + Zustand + lucide-react,无重型 UI 库)
- [x] 前端产物 gzip 约 60 KB
- [x] 应用图标正式设计(圆角轨道与数据库主题，适配桌面及移动端)
- [x] 自动更新(tauri-plugin-updater)：启动时检查 GitHub Releases 的 `latest.json`，发现新版本右下角提示，确认后下载、校验签名、安装并重启
- [x] 打 tag 自动发布(GitHub Actions `v*`)：构建 macOS / Windows 安装包并上传 Release，同时生成更新所需的签名产物
- [ ] 多语言(i18n)

## 8. Kafka 消息工作区（v0.1.2，2026-10-09）

> 本节 `[x]` 表示代码已实现，`npx tsc --noEmit` 与 `cargo check` 通过；真实集群联调、安全机制矩阵和跨平台打包仍待验证，不表示全部协议组合已经验收。

- [x] 新增第八大类 `messaging`：代表 Kafka / RabbitMQ / RocketMQ / Pulsar，本版本仅实施 Kafka；连接级统一 `caps.messaging` 工作区入口，对象级由 `browseMessages` / `produceMessages` / `topicManagement` / `consumerGroups` / `resetOffsets` 驱动
- [x] Kafka 连接配置与 rdkafka 0.39 / librdkafka 后端：多 bootstrap brokers、SSL / SASL 安全参数、连接测试；新字段可选并使用 `serde(default)` 兼容既有配置
- [x] Topic 直挂连接，无 database 节点；Partition 为详情而非 column；中栏独立 `KafkaWorkspace` 标签页，不执行 SQL
- [x] Metadata：集群 / broker / Topic、Partition leader / replicas / ISR、低 / 高水位
- [x] 消息浏览：earliest / latest / recent / 指定 offset / timestamp；展示 partition / offset / timestamp，key / payload / headers 支持 text / hex；使用 read_committed 只读浏览
- [x] 有限时串行轮询监听：最近 N 条历史与从现在监听分开，支持全部或单个 Partition，以返回的 next offsets 续读，不提交消费位点；停止、切换 / 关闭标签页或断开 / 编辑 / 删除连接后停止后续轮询，不是永久后端订阅
- [x] 本地消息缓存：500 / 1000 条上限并受 16 MiB JSON UTF-8 字节预算约束，超预算单条不保留；裁剪提示及被淘汰消息详情清理；显示区分 null 与空二进制值
- [x] 浏览结果 JSON 导出：保留消息元数据及 text / hex 内容；导出文件可能包含业务敏感数据
- [x] Producer：key / value 各自支持 text / hex（二进制），hex 校验完整字节；支持指定 partition、headers 与 tombstone；acks=all，显示真实交付 partition / offset 回执
- [x] Topic 管理：创建 / 删除 Topic、增加分区、查看 / 增量修改配置（不覆盖未指定配置）；创建、删除与变更手输目标名称确认；消费组重置 / 删除同样确认
- [x] Consumer Groups：列表、成员 client ID / host / assignment（原始 hex）、已提交 offset / lag；inactive group 重置需显式选择 Topic 与该 Topic 全部 / 单分区，不默认重置整个组，支持 earliest / latest / offset / timestamp，确认列出完整范围与目标；通过 Admin API 重置，不加入业务消费组；支持删除消费组；offset 使用字符串并校验 i64 范围
- [ ] Schema Registry、Avro / Protobuf 解码、OAuth / Kerberos、ACL 管理、分区重分配、RabbitMQ / RocketMQ / Pulsar 独立驱动
- [ ] 真实 Kafka 集群联调与安全机制矩阵回归验证

## 9. MQTT 消息工作区（v0.1.5，2026-11-02）

> 已用 MQTT 5.0 与 3.1.1 对测试 Broker 完成「连接 → 订阅 → 发布 → 接收」闭环验证（`cargo test`，凭据仅通过环境变量注入）。

- [x] 新增 MQTT 类型（`messaging` 大类）：协议 `mqtt` / `mqtts` / `ws` / `wss`、Client ID、用户名密码、Keep Alive、连接超时、Clean Start、会话过期间隔（5.0）、WebSocket 路径
- [x] TLS：自定义 CA、客户端证书与私钥；留空使用系统信任证书。遗嘱消息：Topic / Payload / QoS / Retain
- [x] 连接测试与常驻会话：连接后后台保持客户端与消息缓冲，断开 / 编辑 / 删除连接时一并释放
- [x] 订阅管理：批量主题（逗号分隔）、QoS、主题颜色、启用 / 禁用、删除；订阅与发布草稿按连接保存在本地
- [x] 消息收发：增量轮询（500ms）、发送 / 接收方向标识、QoS / Retain / 时间 / 字节数、JSON 自动美化、Text / JSON / Hex 显示切换、复制 Payload
- [x] 消息筛选：按订阅主题（支持 `+` / `#` 通配符）、按方向、按主题或内容搜索；清空当前显示；自动滚动开关
- [x] 发布：Topic（历史订阅下拉）、QoS、Retain、Plaintext / JSON / Base64 / Hex Payload、`Cmd/Ctrl + Enter` 发送
- [ ] mqtts / wss 自签证书跳过校验、MQTT 5 用户属性与订阅选项（No Local、Retain as Published、Retain Handling）、消息导出、Topic 树 / 仪表盘等视图器功能

## 已知限制

1. PostgreSQL 列信息暂未读取主键/注释(仅 schema/类型/可空)
2. MySQL/PG 查询走预编译语句,部分特殊类型(如 GEOMETRY)显示为 16 进制
3. 同步文件包含明文密码,务必使用私有仓库
4. Redis 仅支持 SCAN 预览与命令执行,暂无键值编辑界面
5. 右键菜单中标注「规划中」的条目尚未实现(库概览、导出 DDL / CSV、索引与分区、各类写操作等非 MySQL/PG/Redis 类型的菜单)
6. 数据库能力表目前由前端 `src/db/drivers.ts` 维护,后端 `capabilities` 命令待新增驱动时补齐
7. Kafka 代码完成，前后端编译及二进制/i64 参数单测通过，真实集群联调待进行；Schema Registry、Avro / Protobuf、OAuth / Kerberos、ACL 管理、分区重分配未实现。每批读取最多 500 条 / 10 MiB / 256 个分区；消费组查询最多 2048 个分区；assignment 原始 hex。增量配置要求 Kafka 2.3+，位点重置要求 broker 支持 Admin API；水位差与 Lag 不等于精确消息条数
8. Kafka 新字段可选并使用 `serde(default)` 读取旧配置；旧版读写新配置可能丢字段。Git 同步含明文安全参数及文件路径，但不复制 CA / 证书 / 私钥文件；请使用私有仓库并在各设备单独部署证书
9. Kafka 消息导出含业务内容，请保存到受控位置；有限时轮询监听并非永久后端订阅，停止后在途读取可完成但不继续发起新轮询
10. SQL Server 仅支持 SQL Server 身份认证（用户名 / 密码），不支持 Windows 集成认证 / AAD 与命名实例（SQL Browser）；连接加密开启但不校验服务器证书，自签或内网证书可直接连上。不支持客户端 `GO` 分隔符，一次执行多条语句仅展示第一个结果集；TDS 8.0 严格模式与 Azure SQL 未验证
11. SQL Server 的「新建库 / 新建表」设计窗口仍限 MySQL / PG（方言未适配），其余只读浏览、查询与 SQL 执行可用
12. MQTT 消息保存在后端内存缓冲（每连接 2000 条），关闭应用或断开连接后不保留；订阅列表与发布草稿按连接存于本地 localStorage，不随 Git 同步
13. MQTT 配置含明文用户名 / 密码；证书只记录路径，不随 Git 同步，跨设备需单独部署证书。ws / wss 依赖 Broker 的 WebSocket 监听与 `/mqtt` 路径配置
