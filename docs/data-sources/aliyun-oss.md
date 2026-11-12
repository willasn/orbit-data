# 阿里云 OSS 连接说明

> 文档状态：**已实现（v0.1.6）**，已用真实 Bucket 完成「连接 → 列对象 → 上传 → 详情 → 下载 → 临时链接 → 删除」冒烟验证
> 更新日期：2026-11-10
> 所属大类：`storage`（对象存储，第九大类）
> 连接类型：`aliyun_oss`
>
> 本文档是「阿里云 OSS」连接类型的长期说明，覆盖连接配置、层级模型、界面展示、功能清单、接口设计、安全要求与测试清单。
> 后续每新增一种连接类型，在 `docs/data-sources/` 下新增一个 `<db_type>.md`，结构保持一致。

---

## 一、概述

阿里云 OSS 是以 Bucket + Object Key 组织的对象存储服务。OrbitData 将其作为独立数据源类型接入，提供：

- 连接配置与连通性测试
- Bucket 浏览
- 对象列表、目录下钻、前缀搜索、分页加载
- **对象列表排序：按名称 / 按修改时间，支持正序与倒序**
- 对象详情查看
- 文件上传、下载、删除
- **获取并查看临时下载地址（签名 URL）**

不把 OSS 伪装成关系型数据库：不提供 SQL 查询、列级结构、建表等能力。

### 1.1 支持状态

| 项目 | 状态 |
|---|---|
| 后端连接器 `src-tauri/src/db/oss.rs` | ✅ 已实现 |
| 新建连接入口 `ConnectionDialog.tsx` | ✅ 已实现 |
| 能力注册表 / 菜单 `drivers.ts`、`menuItems.ts` | ✅ 已实现 |
| 对象存储工作区 `StorageWorkspace.tsx` | ✅ 已实现 |
| 真实 OSS 冒烟验收 | ✅ 已通过（连接、列 Bucket / 对象、上传、详情、下载、临时链接、删除） |

---

## 二、连接配置

### 2.1 配置字段

| 界面字段 | 存储字段 | 必填 | 说明 |
|---|---|---|---|
| 连接名称 | `name` | 是 | 用户自定义名称 |
| 连接类型 | `db_type` | 是 | 固定为 `aliyun_oss` |
| Endpoint | `host` + `port` | 是 | 形如 `oss-<region>.aliyuncs.com`，端口默认 `443`；不要填 Bucket 前缀和协议 |
| 协议 | `oss.scheme` | 是 | `https`（默认）/ `http` |
| AccessKey ID | `username` | 是 | 建议使用仅授予目标 Bucket 权限的 RAM 子账号 |
| AccessKey Secret | `password` | 是 | 密码框输入，编辑时不回显明文 |
| 默认 Bucket | `database` | 否 | 填写后连接与进入工作区更快，且不要求 `ListBuckets` 权限；留空则在左栏列出账号下全部 Bucket |
| STS Token | `oss.sts_token` | 否 | 使用临时凭据时填写；参与签名与临时 URL 生成 |
| 分组 | `group` | 否 | 复用现有连接分组 |

示例（占位符，禁止在仓库中填写真实凭据）：

```text
Endpoint:  oss-<region>.aliyuncs.com:443
协议:      https
AccessKey: your-access-key-id
Secret:    your-access-key-secret
Bucket:    my-bucket
```

### 2.2 层级映射

| OrbitData 概念 | OSS 概念 | 说明 |
|---|---|---|
| 连接 | 账号 + Endpoint | 一个连接对应一个账号在一个地域的访问入口 |
| 库 / Database | Bucket | 左栏只展示到这一层 |
| 表 / Table | Object 或 Prefix | 对象与「文件夹」统一在对象列表中展示 |
| 列 / Column | 不适用 | 不渲染列层，不提供 `list_columns` |

OSS 的「文件夹」本质是对象 Key 中以 `/` 分隔的前缀，不是真实目录。

### 2.3 权限要求

按最小权限原则，RAM 策略至少需要：

| 操作 | 所需权限 |
|---|---|
| 测试连接（指定 Bucket） | `oss:HeadBucket` |
| 测试连接（未指定 Bucket） | `oss:ListBuckets` |
| 浏览 Bucket / 对象列表 | `oss:ListObjects`、`oss:GetBucketInfo`（可选） |
| 查看对象详情 | `oss:GetObjectMeta` / `oss:HeadObject` |
| 上传 | `oss:PutObject` |
| 下载 | `oss:GetObject` |
| 删除 | `oss:DeleteObject` |
| 临时下载地址 | `oss:GetObject`（签名 URL 继承生成者的读权限） |

### 2.4 测试连接

- 填写了默认 Bucket：调用 `HeadBucket`，成功即视为连接可用。
- 未填写默认 Bucket：调用 `ListBuckets`，返回 Bucket 数量作为提示。
- 失败时解析 OSS 返回的 XML `Code` / `Message`，给出可操作提示，例如：
  - `InvalidAccessKeyId`：AccessKey ID 不存在或已禁用。
  - `SignatureDoesNotMatch`：Secret 错误，或本机时间偏差过大。
  - `AccessDenied`：子账号缺少对应权限，或 Bucket 归属其他账号。
  - `NoSuchBucket`：Bucket 名或地域填写错误。

---

## 三、界面与交互

### 3.1 左栏对象树

左栏只展示到 Bucket，避免把海量对象加载进树：

```text
▾ 对象存储（生产）
   ▸ my-bucket-a
   ▸ my-bucket-b
```

- 连接节点双击 / 右键「打开对象存储工作区」。
- Bucket 节点单击选中，双击打开工作区并定位到该 Bucket。
- Bucket 右键菜单：打开对象工作区、刷新 Bucket 列表、复制 Bucket 名。
- 不在左栏渲染对象节点；对象级操作全部放在工作区表格中。
- 连接断开、编辑、删除时，关闭对应工作区标签页。

### 3.2 对象存储工作区

同一连接复用同一个工作区标签页，切换 Bucket 不新开标签。

```text
┌ OSS 工作区 · <连接名>            [Bucket ▾] [刷新] [上传文件] ┐
│ 面包屑：my-bucket / images / 2026 /                           │
│ [搜索前缀…] [排序：名称 ↓ ▾] [每页 100 ▾] 修改时间 [____-__-__ __:__] ~ [____-__-__ __:__] [查询] │
├───────────────────────────────────────────────────────────────┤
│ 名称                 类型    大小     最后修改      操作        │
│ 📁 2025/             文件夹   —        —          [打开]        │
│ 📄 report.pdf        对象     2.3 MB   11-10 12:00 [下载] [链接] [删除] │
│ 📄 logo.png          对象     48 KB    11-10 11:20 [下载] [链接] [删除] │
├───────────────────────────────────────────────────────────────┤
│ 共 1240 条 · 本页 100 条 · [首页][上页] 第 1 / 13 页 [下页][末页] [__] [跳转] │
└───────────────────────────────────────────────────────────────┘
选中对象后展示详情：Key / ETag / Content-Type / 存储类型 / 元数据，并附图片或文本在线预览（预览可关闭，关闭后列表恢复原高度）
```

- 双击文件夹进入下一级前缀；面包屑支持回退。
- 工作区标签页类型为 `storage`，右栏 SQL 编辑器置灰，不执行 SQL。
- 断开连接后工作区只读提示，重新连接后可刷新恢复。

### 3.3 对象列表、排序与分页

**列表加载**

- 通过 OSS `ListObjectsV2` 按前缀拉取，`delimiter=/` 区分文件夹与对象。
- 每页可选 50 / 100 / 200 / 500 条，单次请求不超过 OSS 上限 1000 条。
- 搜索框按对象 Key 前缀过滤，由服务端完成，不拉取全量对象。
- 分页为真分页：后端把前缀下的对象聚合为索引后切片，支持首页 / 上一页 / 下一页 / 末页与输入页码跳转。
- 索引按「连接 + Bucket + 前缀 + 时间区间」缓存 30 秒；切换排序或翻页不重新扫描，上传 / 删除后自动失效，「刷新」强制重扫。
- 名称展示只剥离「当前目录」前缀，不按搜索词剥离：搜索词通常不是目录边界，按它截取会把文件名开头一起裁掉（如搜索 `foo/b` 时把 `foo/bar.txt` 显示成 `ar.txt`）。
- 单次扫描上限 20 万对象；超出时列表标注「扫描量已达上限，结果可能不完整」。

**排序**

- 排序字段：`名称`、`修改时间`。
- 排序方向：`正序`、`倒序`。
- 入口：工具栏单个下拉，提供四种组合：
  - 名称正序
  - 名称倒序
  - 修改时间正序（旧 → 新）
  - 修改时间倒序（新 → 旧）
- 文件夹始终排在对象之前；文件夹内部按名称排序，对象按所选字段与方向排序。
- 排序由后端对完整索引执行，因此作用于整个目录而非当前页。
- OSS 列表接口只保证 Key 字典序，因此「按时间排序 + 任意跳页」需要通过后端聚合实现，代价是首次加载需遍历前缀。

**时间区间筛选**

- 工具栏单行排列：搜索前缀、排序、每页条数、起止时间，右侧只有一个「查询」按钮统一下发；时间区间可留空。
- 开始 / 结束时间为本地时间，提交前转 UTC ISO 8601；修改控件不会立即请求，避免输入过程中反复扫描 Bucket。
- 与排序、前缀搜索、分页叠加生效，结果一致；文件夹不受时间区间限制。
- 服务端在扫描阶段按 `LastModified` 过滤，再排序、切片，保证总数与分页一致。

**Bucket 切换**

- 左栏双击其它 Bucket 会把目标 Bucket 同步到已打开的工作区标签页，而不是复用旧内容。
- 切换时会清空列表、页码、选中对象与全部筛选状态（搜索前缀、时间区间、排序、每页条数恢复默认），并按第 1 页重新加载。

### 3.4 临时下载地址

用于在不暴露 AccessKey 的前提下，把对象临时分享给浏览器或其他客户端。

**入口**

- 对象行操作「临时链接」。
- 对象详情面板「生成临时下载地址」。

**弹窗交互**

```text
┌ 临时下载地址 ─────────────────────────────┐
│ 对象：images/2026/report.pdf              │
│ 有效期：[15 分钟 ▾]  （可选 1 小时 / 8 小时）│
│ [生成]                                     │
│ ┌───────────────────────────────────────┐ │
│ │ https://my-bucket.oss-<region>...?…  │ │
│ └───────────────────────────────────────┘ │
│ 失效时间：2026-11-10 13:00:00              │
│ [复制链接] [浏览器打开]                     │
└────────────────────────────────────────────┘
```

**规则**

- 默认有效期 1 小时；可选 15 分钟 / 1 小时 / 8 小时，具体上限以 OSS 返回为准。
- 链接生成后在弹窗内只读展示，支持复制与在系统浏览器打开。
- 显示失效时间；过期后「浏览器打开」置灰，提示重新生成。
- 使用 STS Token 时，签名 URL 需携带 `security-token` 查询参数。
- 私有 Bucket 也可生成；公开 Bucket 生成后同样可访问。
- 安全提示必须展示：**任何拿到链接的人在有效期内都能下载该对象，请勿公开传播**。
- 完整签名 URL 不写入应用日志，不放入 AI 上下文。

### 3.5 上传 / 下载 / 删除

**上传**

1. 点击「上传文件」，调用系统文件选择对话框（可多选）。
2. 目标 Key = 当前前缀 + 本地文件名；默认按扩展名推断 `Content-Type`，无法识别则用 `application/octet-stream`。
3. 上传前对目标 Key 做 `HeadObject`：已存在则弹窗确认是否覆盖。
4. 多文件顺序上传，逐个展示「等待 / 上传中 / 成功 / 失败」，单个失败不阻断后续文件。
5. 上传完成后刷新当前目录并定位到新对象。

**下载**

1. 行操作「下载」或详情面板下载。
2. 调用系统保存对话框，默认文件名为对象名。
3. 后端流式写入本地文件，不把整个对象读入内存。
4. 完成提示本地路径；失败保留错误原因，不删除已写入的部分文件时需提示可能不完整。

**删除**

1. 行操作「删除」，弹窗展示 Bucket 与完整 Key。
2. 要求手动输入完整 Key 才能确认，防止误删。
3. 删除成功刷新列表；对象不存在按幂等成功处理。
4. 首版只删除单个对象，不删除前缀（文件夹），不做批量删除。

### 3.6 空态与异常态

| 场景 | 展示 |
|---|---|
| 无 Bucket | 「当前账号在该地域下没有 Bucket，或缺少 ListBuckets 权限」 |
| 目录为空 | 「当前目录没有对象」 |
| 前缀无匹配 | 「没有匹配前缀的对象」 |
| 未连接 / 会话失效 | 「连接已断开，请重新连接」+ 重试按钮 |
| 权限不足 | 展示 OSS 错误码与建议检查的 RAM 权限 |
| 网络 / 超时 | 展示可重试提示，保留当前列表 |

---

## 四、功能清单

### 4.1 首版（MVP）

| 功能 | 说明 | 状态 |
|---|---|---|
| 新建 / 编辑 / 删除连接 | 阿里云 OSS 类型，字段见 2.1 | ✅ |
| 测试连接 | `HeadBucket` 或 `ListBuckets` | ✅ |
| Bucket 浏览 | 左栏展示，工作区可切换 | ✅ |
| 对象列表 | 文件夹 / 对象区分、前缀下钻、面包屑 | ✅ |
| 前缀搜索 | 服务端按前缀过滤 | ✅ |
| 分页 | 50 / 100 / 200 / 500，后端聚合索引后切片，支持跳页 | ✅ |
| 名称排序 | 正序 / 倒序，文件夹优先，作用于完整目录 | ✅ |
| 修改时间排序 | 正序 / 倒序，文件夹优先，作用于完整目录 | ✅ |
| 修改时间区间筛选 | 起止时间与服务端筛选，可与其它条件叠加 | ✅ |
| 对象详情 | Key、大小、ETag、Content-Type、存储类型、元数据 | ✅ |
| 在线预览 | 图片（签名 URL）、常见文本（≤ 512 KB） | ✅ |
| 上传 | 系统文件对话框、多文件顺序上传、覆盖确认 | ✅ |
| 下载 | 系统保存对话框、流式写入 | ✅ |
| 删除 | 单对象、手输 Key 确认 | ✅ |
| 临时下载地址 | 生成、查看、复制、浏览器打开、有效期与过期提示 | ✅ |
| 复制对象路径 | 复制 `bucket/key` | ✅ |
| 连接状态联动 | 断开 / 编辑 / 删除时关闭工作区 | ✅ |

### 4.2 后续规划

| 功能 | 说明 |
|---|---|
| 分片上传 / 断点续传 | 大文件与网络中断场景 |
| 批量删除 | 按前缀批量删除，需更严格的二次确认 |
| 新建文件夹 | 上传零字节占位对象 |
| 移动 / 复制 / 重命名 | 服务端 CopyObject |
| 更多预览类型 | PDF、Office 文档、音视频等 |
| 传输进度与取消 | 流式进度事件、取消令牌 |
| 拖拽上传 | 从桌面拖入工作区 |
| Bucket 管理 | 创建、删除、权限与生命周期 |
| 自定义域名 / 加速域名 | 传输加速、CNAME 访问 |
| RAM 角色 / 临时凭据刷新 | 更完整的 STS 支持 |

---

## 五、数据模型与接口

### 5.1 配置结构

```rust
pub struct OssConfig {
    /// https / http，默认 https
    pub scheme: String,
    /// 可选：STS 临时凭据 token
    pub sts_token: Option<String>,
}
```

`Connection` 新增可选字段，保持旧配置兼容：

```rust
#[serde(default)]
pub oss: Option<OssConfig>,
```

### 5.2 前端类型

```ts
export interface OssBucket {
  name: string;
  region?: string;
  creationDate?: string;
}

export interface OssObject {
  key: string;
  isFolder: boolean;
  size?: number;
  lastModified?: string;
  etag?: string;
  contentType?: string;
  storageClass?: string;
}

export interface OssPage {
  bucket: string;
  prefix: string;
  objects: OssObject[];
  nextToken?: string;
  isTruncated: boolean;
}
```

### 5.3 Tauri 命令

| 命令 | 用途 |
|---|---|
| `oss_request(conn_id, request)` | 元数据类操作：列 Bucket、列对象、对象详情、删除、生成临时地址 |
| `oss_transfer(conn_id, request)` | 文件传输：上传本地文件、下载到本地路径 |

`request` 使用 `action` 区分：

```text
list_buckets
list_objects   { bucket, prefix, start_time?, end_time?, sort?, page?, page_size?, refresh? }
get_object_text{ bucket, key }
head_object    { bucket, key }
delete_object  { bucket, key }
presign_url    { bucket, key, expires_secs? }
upload_file    { bucket, key, local_path }
download_file  { bucket, key, local_path }
```

`list_objects` 的排序 / 时间筛选 / 分页都在后端完成：扫描前缀下全部对象（每页 1000 条续页拉取）→ 按 `LastModified` 过滤 → 排序 → 切片，返回 `{ prefix, objects, total, page, page_size, scan_truncated }`。索引按「连接 + Bucket + 前缀 + 时间区间」缓存 30 秒，`refresh: true` 跳过缓存；上传 / 删除会清空缓存。`start_time` / `end_time` 为 RFC 3339 字符串。

### 5.4 OSS 请求细节

- 访问方式：虚拟主机风格 `https://<bucket>.<endpoint>/<url-encoded-key>`；列 Bucket 使用 `https://<endpoint>/`。
- 签名：OSS V1，`HMAC-SHA1`；`Authorization: OSS <AccessKeyId>:<Signature>`。
- 必带请求头：`Date`（GMT）、`Content-Type`（上传时）、`x-oss-security-token`（STS）。
- 列对象：`GET /?list-type=2&prefix=...&delimiter=/&max-keys=...&continuation-token=...`。
- 对象详情：`HEAD /<key>`，读取 `Content-Length`、`ETag`、`Last-Modified`、`Content-Type`、`x-oss-storage-class`。
- 上传：`PUT /<key>`，流式请求体。
- 下载：`GET /<key>`，流式响应体写文件。
- 删除：`DELETE /<key>`，成功返回 204。
- 临时地址：查询参数签名，包含 `OSSAccessKeyId`、`Expires`、`Signature`，STS 时附加 `security-token`。
- Key 编码：按路径段做 URL 编码，保留 `/` 分隔符，避免中文、空格、`+` 等字符签名不一致。

### 5.5 错误映射

统一解析 OSS XML：

```xml
<Error>
  <Code>...</Code>
  <Message>...</Message>
  <RequestId>...</RequestId>
</Error>
```

界面展示「可读中文 + OSS Code」，日志只记录 Code、RequestId、HTTP 状态，不记录 AccessKey、Secret、完整签名 URL。

---

## 六、实现落点

| 层 | 文件 | 改动 |
|---|---|---|
| 配置 | `src-tauri/src/config.rs` | 新增 `OssConfig` 与可选 `oss` 字段 |
| 后端驱动 | `src-tauri/src/db/oss.rs`（新增） | 签名、列表、详情、上传、下载、删除、临时地址 |
| 分发 | `src-tauri/src/db/mod.rs` | `aliyun_oss` 分支；`list_databases` 返回 Bucket；`list_tables` 返回空；`run_query` 报错 |
| 命令注册 | `src-tauri/src/lib.rs` | 注册 `oss_request`、`oss_transfer` 与 dialog 插件 |
| 依赖 | `src-tauri/Cargo.toml` | `hmac`、`sha1`、`mime_guess`；tokio 补 `fs`、`io-util`；`tauri-plugin-dialog` |
| 前端类型 | `src/types.ts` | `OssConfig`、`OssBucket`、`OssObject`、`OssPage`、`OssRequest`、`storage` Tab |
| 前端 API | `src/api.ts` | `ossRequest`、`ossTransfer` |
| 能力注册 | `src/db/drivers.ts` | `kind: "storage"`、`dbLabel: "Bucket"`、`tableLabel: "对象"`、caps |
| 菜单 | `src/db/menuItems.ts` | 连接级 / Bucket 级菜单；对象级菜单在工作区内 |
| 连接弹窗 | `src/components/ConnectionDialog.tsx` | OSS 类型卡片与表单、测试连接 |
| 左栏 | `src/components/LeftPanel.tsx` | Bucket 节点、双击打开工作区、连接联动 |
| 工作区 | `src/components/StorageWorkspace.tsx`（新增） | 列表、排序、上传、下载、删除、详情、临时地址 |
| 主区域 | `src/components/ChatView.tsx` | 渲染 `storage` 标签页 |
| 状态 | `src/store.ts` | `openStorage`、关闭联动、SQL 拦截 |
| 样式 | `src/styles.css` 或 `StorageWorkspace.css` | 工作区与弹窗样式 |
| 文档 | `CONTEXT_MENU.md`、`FEATURE.md`、`README.md` | 登记 storage 大类与功能进度 |

### 6.1 能力位（规划）

| 能力位 | 值 | 说明 |
|---|---|---|
| `storage` | `true` | 启用对象存储工作区入口 |
| `objects` | `true` | 支持对象列表 |
| `upload` | `true` | 支持上传 |
| `download` | `true` | 支持下载 |
| `presign` | `true` | 支持临时下载地址 |
| `write` | `true` | 支持删除对象 |

具体字段名以实现时的 `drivers.ts` 为准；菜单只按能力位显隐，不按 `db_type` 直接分支。

---

## 七、安全与合规

1. AccessKey ID / Secret、STS Token 只从本机 `config.json` 或用户运行时输入读取，禁止写入源码、文档、测试数据、日志与 AI 上下文。
2. 连接信息会随 Git 同步导出为明文，界面与文档必须保留「请使用私有仓库」警告。
3. 临时下载地址属于敏感信息：不写日志、不自动复制到剪贴板之外的地方、展示时明确有效期与公开可访问风险。
4. 错误信息与调试输出脱敏：不输出 Secret、完整签名、完整 URL 查询参数。
5. 上传与下载只操作显式选择的本地路径，不遍历用户目录。
6. 删除必须手动输入完整 Key，禁止一键批量删除前缀。
7. 文档与示例统一使用占位符：`oss-<region>.aliyuncs.com`、`your-access-key-id`、`your-access-key-secret`、`my-bucket`。

---

## 八、已知限制

- 单次简单 PUT 上限约 5 GB；暂不做分片上传与断点续传。
- OSS 不支持按修改时间排序、时间区间查询与随机跳页；后端采用「遍历前缀 → 本地筛选 / 排序 / 切片」实现，单次扫描上限 20 万对象，超大 Bucket 需靠前缀搜索缩小范围。
- 首次加载大目录需要遍历全部对象，耗时与请求次数随对象数增加；索引缓存 30 秒可缓解翻页与切换排序的开销。
- 文件夹是逻辑前缀，不能作为真实目录删除；暂不支持删除文件夹。
- 不提供 Bucket 创建 / 删除、ACL、生命周期、跨区域复制等管理能力。
- 在线预览仅覆盖常见图片与文本类型，文本最多读取 512 KB；PDF、Office 文档、音视频需下载查看。
- 传输只有「进行中 / 完成 / 失败」状态，没有百分比进度与取消。
- 不保证兼容所有 OSS 兼容存储（MinIO、其他 S3 兼容服务）；当前只针对阿里云 OSS 验证。

---

## 九、测试清单

### 9.1 连接

- [ ] 填写默认 Bucket，测试连接走 `HeadBucket` 成功。
- [ ] 不填默认 Bucket，测试连接走 `ListBuckets` 成功并返回数量。
- [ ] 错误 AccessKey ID / Secret 返回可读错误。
- [ ] 无权限子账号返回 `AccessDenied` 并提示检查 RAM 策略。
- [ ] Bucket 与 Endpoint 地域不一致时给出明确提示。
- [ ] 系统时间偏差导致签名失败时提示校时。

### 9.2 列表、排序与分页

- [ ] 根目录、子目录、空目录展示正确。
- [ ] 面包屑逐级回退正确。
- [ ] 分页翻页无重复、无遗漏；末页与总数一致。
- [ ] 输入页码可跳转到指定页；越界页码被校正到合法范围。
- [ ] 前缀搜索重置到第 1 页并只显示匹配项。
- [ ] 名称正序 / 倒序正确（按 Key 字典序）。
- [ ] 修改时间正序 / 倒序正确，且作用于整个目录而非当前页。
- [ ] 时间区间与排序、前缀搜索叠加生效，结果与总数一致；时间留空时按全量查询。
- [ ] 修改搜索 / 排序 / 每页 / 时间后不立即请求，点击「查询」才刷新并回到第 1 页。
- [ ] 左栏切换到另一个 Bucket 后，列表、页码与筛选条件全部重置，不残留旧 Bucket 数据。
- [ ] 切换排序 / 翻页在 30 秒缓存内不重复扫描；「刷新」强制重扫。
- [ ] 上传 / 删除后列表自动刷新并反映最新数据。

### 9.2.1 在线预览

- [ ] 选中图片对象展示预览图，签名 URL 过期后重新选择可刷新。
- [ ] 选中 txt / md / json / csv / log 等文本对象展示内容与换行。
- [ ] 超过 512 KB 的文本提示已截断。
- [ ] 不支持的类型给出「请下载后查看」提示，不发起多余请求。
- [ ] 关闭预览后列表区域恢复原高度，「打开预览」可重新展开。

### 9.3 上传 / 下载 / 删除

- [ ] 单文件、多文件上传成功，中文与空格文件名正常。
- [ ] 同名对象上传触发覆盖确认；取消不覆盖。
- [ ] 大文件上传不出现内存暴涨。
- [ ] 下载内容与源对象大小、内容一致。
- [ ] 取消保存对话框不发起请求。
- [ ] 删除必须输入完整 Key；输错不可删除。
- [ ] 删除不存在对象不报致命错误。

### 9.4 临时下载地址

- [ ] 私有 Bucket 生成链接后可在无登录浏览器下载。
- [ ] 15 分钟 / 1 小时 / 8 小时有效期正确。
- [ ] 过期后访问失败，界面提示重新生成。
- [ ] 中文、空格、特殊字符 Key 生成的链接可正常访问。
- [ ] STS 模式链接携带 `security-token` 且可访问。
- [ ] 复制链接可用，应用日志不出现完整 URL。

### 9.5 状态联动与安全

- [ ] 断开、编辑、删除连接时工作区标签关闭或失效提示正确。
- [ ] 工作区打开时 SQL 编辑器置灰，无法执行 SQL。
- [ ] `git status --short` 与 `git grep` 无真实凭据、真实 Endpoint、本机路径。
- [ ] 日志中无 AccessKey、Secret、完整签名 URL。

### 9.6 构建检查

```bash
npx tsc --noEmit
cd src-tauri && cargo check
```

---

## 十、后续规划

1. 分片上传、断点续传、传输进度与取消。
2. 批量删除、新建文件夹、移动 / 复制 / 重命名。
3. PDF、Office 文档、音视频在线预览。
4. 列表索引持久化与增量刷新，降低超大 Bucket 首次扫描成本。
5. Bucket 管理、ACL、生命周期、跨区域复制。
6. 自定义域名、传输加速、RAM 角色与临时凭据刷新。
7. 抽象通用对象存储能力位，评估接入 MinIO、腾讯云 COS、AWS S3 等兼容服务。

---

## 十一、变更记录

| 日期 | 变更 |
|---|---|
| 2026-11-10 | 初稿：连接配置、Bucket / 对象层级、对象工作区、上传下载删除、名称与时间排序、临时下载地址、接口设计、安全与测试清单 |
| 2026-11-10 | 实现完成：后端 `db/oss.rs`、`oss_request` / `oss_transfer` 命令、`tauri-plugin-dialog`、`StorageWorkspace`；修正 OSS V1 签名（普通查询参数不参与 CanonicalizedResource）；真实 Bucket 冒烟通过 |
| 2026-11-12 | 对象浏览增强：`list_objects` 改为服务端时间区间筛选 + 整目录排序 + 真分页（索引缓存 30 秒、20 万对象扫描上限）；「加载更多」替换为首页 / 上下页 / 末页 / 跳页；新增 `get_object_text` 文本预览与图片签名 URL 预览 |
| 2026-11-12 | 交互调整：搜索 / 排序 / 每页条数 / 时间区间合并为单行并只保留「查询」按钮（时间可留空）；预览面板可关闭；左栏切换 Bucket 时同步到工作区并清空列表、分页与筛选状态 |
| 2026-11-12 | 修复（显示层）：前缀搜索时列表按搜索前缀剥离 Key，导致文件名开头被误裁（如 `foo/bar.txt` 显示成 `ar.txt`）；改为只剥离当前目录前缀，数据本身完整 |
