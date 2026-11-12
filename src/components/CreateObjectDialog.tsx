import { useEffect, useState } from "react";
import { api } from "../api";
import {
  buildCreateTableSql,
  CLICKHOUSE_ENGINES,
  CLICKHOUSE_TABLE_DEFAULT,
  COLUMN_TYPES,
  tableColumn,
  type ClickHouseTableOptions,
  type TableColumnDraft,
} from "../db/createTable";
import { driverOf } from "../db/drivers";
import { createDbSql } from "../db/menuItems";
import { useStore } from "../store";

export default function CreateObjectDialog() {
  const { createTarget, closeCreate, config, refreshConnection, refreshTables, showToast } = useStore();
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [ttl, setTtl] = useState("");
  const [columns, setColumns] = useState<TableColumnDraft[]>([tableColumn(1)]);
  const [chOptions, setChOptions] = useState<ClickHouseTableOptions>({ ...CLICKHOUSE_TABLE_DEFAULT });
  const [nextColumnId, setNextColumnId] = useState(2);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // 每次打开对话框重置草稿，并按方言选择默认字段类型（ClickHouse 用 UInt64）
  useEffect(() => {
    if (!createTarget) return;
    const targetConn = config?.connections.find((c) => c.id === createTarget.connId);
    const dialect = targetConn ? driverOf(targetConn.db_type).createDialect : undefined;
    const initial = dialect === "clickhouse" ? "clickhouse" : dialect === "postgres" ? "postgres" : "mysql";
    setName("");
    setValue("");
    setTtl("");
    setError("");
    setChOptions({ ...CLICKHOUSE_TABLE_DEFAULT });
    setColumns([tableColumn(1, initial)]);
    setNextColumnId(2);
  }, [createTarget]);
  if (!createTarget) return null;

  const conn = config?.connections.find((c) => c.id === createTarget.connId);
  if (!conn) return null;
  const driver = driverOf(conn.db_type);
  const kind = createTarget.kind;
  const label = kind === "database" ? driver.dbLabel : driver.tableLabel;
  const database = createTarget.database ?? "";
  const dialect = driver.createDialect;
  const isTable = kind === "table";
  const isKey = kind === "key";
  const sqlDialect = dialect === "mysql" || dialect === "postgres" || dialect === "clickhouse" ? dialect : null;
  const isClickhouse = sqlDialect === "clickhouse";
  const setChOption = (patch: Partial<ClickHouseTableOptions>) => setChOptions((o) => ({ ...o, ...patch }));
  const columnDialect = isClickhouse ? "clickhouse" : dialect === "postgres" ? "postgres" : "mysql";
  const updateColumn = (id: number, patch: Partial<TableColumnDraft>) => {
    setColumns((items) => items.map((c) => c.id === id ? { ...c, ...patch } : c));
  };
  const moveColumn = (index: number, direction: number) => {
    const next = [...columns];
    const other = index + direction;
    if (other < 0 || other >= next.length) return;
    [next[index], next[other]] = [next[other], next[index]];
    setColumns(next);
  };

  let preview = "";
  let validation = "";
  if (isTable) {
    try { preview = buildCreateTableSql(driver, database, name, columns, chOptions); }
    catch (e) { validation = String(e instanceof Error ? e.message : e); }
  }
  if (isKey && ttl && (!/^[1-9]\d*$/.test(ttl) || Number(ttl) > 2147483647)) {
    validation = "过期时间必须是 1 到 2147483647 秒";
  }
  if (isKey && !/^db\d+$/i.test(database)) validation = "逻辑库格式不正确";

  const submit = async () => {
    const objectName = name.trim();
    if (!objectName || saving || validation) return;
    setSaving(true);
    setError("");
    let created = false;
    try {
      if (isTable) {
        await api.runQuery(conn, database, preview);
      } else if (isKey) {
        if (dialect !== "redis") throw new Error("当前连接尚不支持新建键");
        const db = database.match(/^db(\d+)$/i)?.[1];
        if (db === undefined) throw new Error("逻辑库格式不正确");
        const result = await api.redisCommand({ ...conn, database: db }, ["SET", objectName, value, "NX", ...(ttl ? ["EX", ttl] : [])]);
        if (result !== "OK") throw new Error(result === "(nil)" ? "键已存在，请更换键名" : `创建未成功：${result}`);
      } else {
        const sql = createDbSql({ conn }, objectName);
        await api.runQuery({ ...conn, database: "" }, "", sql);
      }
      created = true;
      if (kind === "database") {
        await refreshConnection(conn.id);
        if (useStore.getState().dbTree[conn.id]?.error) throw new Error("数据库列表刷新失败");
      } else {
        await refreshTables(conn.id, database);
        if (useStore.getState().dbTree[conn.id]?.error) throw new Error(`${label}列表刷新失败`);
      }
      showToast(`已创建${label}「${objectName}」`);
      closeCreate();
    } catch (e) {
      if (created) {
        showToast(`已创建${label}「${objectName}」，但列表刷新失败，请手动刷新`);
        closeCreate();
      } else {
        setError(`创建失败：${e}`);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-mask" onClick={() => !saving && closeCreate()}>
      <div className={`modal${isTable ? " create-table-modal" : ""}`} onClick={(e) => e.stopPropagation()}>
        <h3>{isTable ? "设计新表" : `新建${label}`}</h3>
        {kind !== "database" && <p>目标{driver.dbLabel}：{database}</p>}
        <div className="form-grid">
          <label htmlFor="create-object-name">{label}名称 *</label>
          <input id="create-object-name" autoFocus value={name} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (isTable || e.key !== "Enter" || e.nativeEvent.isComposing || e.keyCode === 229) return;
              e.preventDefault();
              void submit();
            }} placeholder={`输入${label}名称`} />
          {isKey && <>
            <label htmlFor="create-key-value">值（字符串）</label>
            <textarea id="create-key-value" rows={3} value={value} onChange={(e) => setValue(e.target.value)} />
            <label htmlFor="create-key-ttl">过期时间（秒）</label>
            <input id="create-key-ttl" inputMode="numeric" value={ttl} onChange={(e) => setTtl(e.target.value)} placeholder="留空表示不过期" />
          </>}
        </div>
        {isTable && isClickhouse && <>
          <div className="form-grid">
            <label htmlFor="ch-engine">表引擎 *</label>
            <select id="ch-engine" value={chOptions.engine}
              onChange={(e) => setChOption({ engine: e.target.value })}>
              {CLICKHOUSE_ENGINES.map((engine) => <option key={engine}>{engine}</option>)}
            </select>
            <label htmlFor="ch-order-by">排序键 ORDER BY{chOptions.engine.includes("MergeTree") ? " *" : ""}</label>
            <input id="ch-order-by" value={chOptions.orderBy}
              placeholder="如 id 或 id, created_at"
              onChange={(e) => setChOption({ orderBy: e.target.value })} />
            <label htmlFor="ch-partition-by">分区键 PARTITION BY</label>
            <input id="ch-partition-by" value={chOptions.partitionBy}
              placeholder="可选，如 toYYYYMM(created_at)"
              onChange={(e) => setChOption({ partitionBy: e.target.value })} />
            <label htmlFor="ch-primary-key">主键 PRIMARY KEY</label>
            <input id="ch-primary-key" value={chOptions.primaryKey}
              placeholder="可选，留空则与排序键一致"
              onChange={(e) => setChOption({ primaryKey: e.target.value })} />
            <label htmlFor="ch-ttl">TTL</label>
            <input id="ch-ttl" value={chOptions.ttl}
              placeholder="可选，如 created_at + INTERVAL 30 DAY"
              onChange={(e) => setChOption({ ttl: e.target.value })} />
            <label>提示</label>
            <span>MergeTree 系列必须填写排序键；Memory / Log / TinyLog 不使用排序键、分区与 TTL。</span>
          </div>
        </>}
        {isTable && sqlDialect && <>
          <div className="create-table-heading"><strong>字段设计</strong><button type="button" className="btn" disabled={saving} onClick={() => {
            setColumns((items) => [...items, tableColumn(nextColumnId, columnDialect)]);
            setNextColumnId((id) => id + 1);
          }}>添加字段</button></div>
          <div className="create-table-scroll">
            <table className="create-table-grid"><thead><tr>
              <th>字段名 *</th><th>类型</th><th>长度/精度</th><th>可空</th><th>默认值</th>
              {!isClickhouse && <><th>主键</th><th>自增</th></>}
              {(sqlDialect === "mysql" || isClickhouse) && <th>注释</th>}<th>操作</th>
            </tr></thead><tbody>{columns.map((column, index) => <tr key={column.id}>
              <td><input aria-label={`字段${index + 1}名称`} value={column.name} onChange={(e) => updateColumn(column.id, { name: e.target.value })} /></td>
              <td><select aria-label={`字段${index + 1}类型`} value={column.type} onChange={(e) => updateColumn(column.id, { type: e.target.value, length: "", autoIncrement: false })}>
                {COLUMN_TYPES[sqlDialect].map((type) => <option key={type}>{type}</option>)}
              </select></td>
              <td><input aria-label={`字段${index + 1}长度或精度`} placeholder={isClickhouse ? "如 18,4 / 16 / 3" : "如 255 / 10,2"} value={column.length} onChange={(e) => updateColumn(column.id, { length: e.target.value })} /></td>
              <td><input aria-label={`字段${index + 1}可空`} type="checkbox" checked={column.nullable} disabled={!isClickhouse && column.primary} onChange={(e) => updateColumn(column.id, { nullable: e.target.checked })} /></td>
              <td><input aria-label={`字段${index + 1}默认值`} placeholder={isClickhouse ? "留空或 now()" : "留空不设置"} value={column.defaultValue} onChange={(e) => updateColumn(column.id, { defaultValue: e.target.value })} /></td>
              {!isClickhouse && <>
                <td><input aria-label={`字段${index + 1}主键`} type="checkbox" checked={column.primary} onChange={(e) => updateColumn(column.id, { primary: e.target.checked, nullable: e.target.checked ? false : column.nullable, autoIncrement: e.target.checked ? column.autoIncrement : false })} /></td>
                <td><input aria-label={`字段${index + 1}自增`} type="checkbox" checked={column.autoIncrement} onChange={(e) => updateColumn(column.id, { autoIncrement: e.target.checked, primary: e.target.checked ? true : column.primary, nullable: e.target.checked ? false : column.nullable })} /></td>
              </>}
              {(sqlDialect === "mysql" || isClickhouse) && <td><input aria-label={`字段${index + 1}注释`} value={column.comment} onChange={(e) => updateColumn(column.id, { comment: e.target.value })} /></td>}
              <td className="create-table-row-actions">
                <button type="button" aria-label="上移字段" disabled={saving || index === 0} onClick={() => moveColumn(index, -1)}>↑</button>
                <button type="button" aria-label="下移字段" disabled={saving || index === columns.length - 1} onClick={() => moveColumn(index, 1)}>↓</button>
                <button type="button" aria-label="删除字段" disabled={saving || columns.length === 1} onClick={() => setColumns((items) => items.filter((c) => c.id !== column.id))}>×</button>
              </td>
            </tr>)}</tbody></table>
          </div>
          <label className="create-table-preview-label" htmlFor="create-table-preview">SQL 预览</label>
          <pre id="create-table-preview" className="create-table-preview">{preview || "完善表名和字段信息后显示 SQL"}</pre>
        </>}
        {(error || (name.trim() && validation)) && <p className="create-object-error" role="alert">{error || validation}</p>}
        <div className="modal-actions">
          <button className="btn" disabled={saving} onClick={closeCreate}>取消</button>
          <button className="btn primary" disabled={!name.trim() || !!validation || saving || (isTable && !preview)} onClick={() => void submit()}>
            {saving ? "创建中…" : "创建"}
          </button>
        </div>
      </div>
    </div>
  );
}
