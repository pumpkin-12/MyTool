# 个人工具箱 · SQLite 存储方案

> 版本 1.0 · 2026-09-13 · 待用户确认后实施

---

## 0. 一句话

把桌面端存储从「单文件 JSON 全量读写」换成 **SQLite**，`AppStore` 对外接口保持完全不变，四个工具的代码**一行都不用改**，现有 `store.json` 数据**自动迁移**进库。

---

## 1. 背景与目标

### 现状
- `AppStore`（`web/index.html`）是唯一存储入口，三后端自动探测：Tauri / Electron / 浏览器 localStorage。
- 桌面端（Tauri）当前行为：启动时 `store_read` 把**整个** `store.json` 读进内存，之后每次 `set` 都 `store_write` **全量重写**整个文件。
- 数据文件：`D:\Ai-file\MyTool\data\store.json`（约 131 KB），轮转备份 `.1/.2/.3`。

### 痛点
1. **全量重写**：改一个键也要重写整个文件（题库、画板图片全在里面，会越来越慢）。
2. **无定位能力**：想按分类/题型查询、统计，只能在 JS 里全量遍历。
3. **单文件膨胀**：画板图片 base64 内联，存档随图片线性膨胀。

### 目标
- 引入 SQLite 作为桌面端持久化后端。
- **保持前端零构建单文件**，不引入打包器。
- **保持工具代码不感知存储**（`AppStore` 接口签名不变）。
- **不丢数据**，可平滑回滚。

---

## 2. 方案选型

| 方案 | 做法 | 评价 |
|---|---|---|
| A. 保持单文件 JSON | 现状 | 用户已明确要 SQLite，排除 |
| B. `tauri-plugin-sql` | 前端直连 SQL | 需引入 JS 插件（本项目靠 `withGlobalTauri`，无 bundler，接入别扭）；且把 SQL 泄漏到各工具，**破坏 AppStore 抽象** |
| **C. rusqlite + KV 表（推荐）** | Rust 侧建 `kv(k,v)` 表，自定义 `db_*` 命令；`AppStore` 接口不变 | 改动集中、抽象不破、可回滚、一次到位 |
| D. 关系型建模（每题一行） | questions/wrong/records 分表 | 查询能力最强，但要改写全部工具代码，工作量与风险最大，本期不做 |

**选 C。** 它用最小的改动兑现"使用 SQLite"：真正的 SQLite 文件、事务、行级写入，但不牵动任何业务代码。

---

## 3. 架构

```
工具代码 (internlog / sketch / mermaid / quiz)
        │  只调 AppStore.get / set / setMany / remove / exportAll / importAll
        ▼
AppStore（接口不变）
   ├─ Tauri 分支 ──► invoke('db_all' | 'db_put' | 'db_del' | 'db_put_many')
   ├─ Electron 分支 ──► NativeStore（保留原样，死代码）
   └─ 浏览器分支 ──► localStorage（保留原样）
                          │
                          ▼
              Rust: rusqlite  ──►  D:\Ai-file\MyTool\data\toolbox.db
```

关键点：`AppStore` 的**方法签名和返回语义完全不变**，只是 Tauri 分支的"落盘动作"从"写整个 JSON"变成"写一行"。

---

## 4. 数据库设计

单表键值模型，`v` 存 JSON 文本（与现有 `store.json` 的 `{键: 值}` 一一对应）：

```sql
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,   -- 完整键，含 toolbox: 前缀，如 toolbox:quiz:questions
  v TEXT NOT NULL       -- 该键对应的 JSON 文本
);
```

- 文件：`D:\Ai-file\MyTool\data\toolbox.db`
- 开启 `PRAGMA journal_mode=WAL;`（并发读友好，崩溃安全）。
- 值类型不限：数组 / 对象 / 字符串 / 数字 / null 都序列化成 JSON 存。

**为什么键值表而不是分表**：现有数据模型本身就是"一个键 → 一个 JSON 值"。键值表让迁移零转换、工具零改动；同时每个键独占一行，**改一个键只写一行**，直接消掉"全量重写"痛点。将来若要做题库复杂查询，可在此基础上再加"投影表"（见 §10 后续）。

---

## 5. 数据迁移（自动，一次性）

启动初始化时：

1. 建表（`IF NOT EXISTS`）。
2. 若 `kv` 表为**空** 且 `D:\Ai-file\MyTool\data\store.json` 存在：
   - 解析 `store.json`（顶层 `{完整键: JSON值}`）。
   - 在一个事务里逐键 `INSERT OR REPLACE INTO kv(k, v) VALUES(?, ?)`，`v = 值序列化后的 JSON 文本`。
   - 成功后把 `store.json` 重命名为 **`store.json.migrated`**（连同 `.1/.2/.3`），避免二次导入。
3. 若 `kv` 已有数据 → 跳过（幂等）。

**幂等保证**：以"表是否为空"为判据，重复启动不会重复导入；旧文件改名后也不会再被读到。

---

## 6. 改动清单

### 6.1 `src-tauri/Cargo.toml`
```toml
rusqlite = { version = "0.32", features = ["bundled"] }
```
> `bundled` 自带 SQLite 源码编译，目标机无需装 SQLite。代价：首次编译多约 30–60s，二进制增大 ~1 MB。

### 6.2 `src-tauri/src/lib.rs`
新增：
- 常量 `DB_FILE = "toolbox.db"`；`db_path()` 复用 `DATA_DIR`。
- 状态 `struct Db(Mutex<rusqlite::Connection>)`。
- `init_db(app) -> Connection`：开库 + 建表 + WAL + 触发迁移。
- `migrate_store_json(app, &conn)`：§5 的迁移逻辑（含旧文件改名）。
- 四条命令：

| 命令 | 入参 | 作用 |
|---|---|---|
| `db_all` | — | 返回 `{键: JSON值}` 的 JSON 文本（供启动时填充内存缓存） |
| `db_put` | `key, value`(JSON 文本) | 单键 `INSERT OR REPLACE`（写入前校验合法 JSON） |
| `db_del` | `key` | 删除单键 |
| `db_put_many` | `entries`(JSON 对象) | 事务内批量写多键 |

- `run()` 里：`.manage(Db(...))`（在 `setup` 中初始化），并把四条命令加入 `generate_handler!`。
- 保留 `store_read` / `store_write`（已注册，不再被前端调用；留着以备回退）。

### 6.3 `web/index.html`（仅 AppStore 内部）
- `ready`（Tauri 分支）：`invoke('db_all')` → `JSON.parse` 填 `mem`。
- 把原来"全量 `persist()`"改为按动作入队：
  - `set(k,v)` → `mem[K]=clone(v)` + `db_put`
  - `remove(k)` → `delete mem[K]` + `db_del`
  - `setMany(obj)` → 更新 `mem` 后一次 `db_put_many`
  - `importAll(obj)` → 更新 `mem` 后一次 `db_put_many`
- 串行化写链（`writeChain`）、失败 toast、`flush()`、`lastError()` **语义保持不变**。
- Electron / 浏览器分支**原样不动**。

> 顺带收益：`setMany` 的注释"合并成一次写盘"在 SQLite 下变成"一次事务写多行"，语义更贴切。

### 6.4 `tools/verify-appstore.js`（必须同步改）
当前 Tauri 段 mock 的是 `store_read`/`store_write`，断言"每次 set 写全量快照"。改为 mock `db_all`/`db_put`/`db_del`/`db_put_many`，断言改为：
- 3 次 `set` → 3 次 `db_put`，每次只带**一个**键（验证"不再全量写"）。
- 失败注入 → toast + `lastError()` + `set` 返回 false（语义不变）。
- `importAll` → 一次 `db_put_many`，含全部键。

---

## 7. 风险与回滚

| 风险 | 说明 | 应对 |
|---|---|---|
| bundled 编译慢/失败 | 首次要编 sqlite3.c（走 `cc`/MSVC） | 若失败，可改 `features=["bundled"]`→系统库或降版本；本机已能正常编译 Rust |
| 二进制变大 | 约 +1 MB | 可接受（当前便携版 3.93 MB） |
| WAL 附带文件 | 多出 `toolbox.db-wal` / `-shm` | 正常现象，关闭后自动合并 |
| 首次迁移失败 | 数据在 `store.json` 未动 | 迁移在事务内，失败则不改名旧文件，下次重试 |
| 需要回滚 | 回到单文件 JSON | 恢复旧 `AppStore` + `lib.rs`，删 `toolbox.db`；`store.json.migrated` 改回 `store.json` 即可 |

**净数据位置仍只有一个**：`D:\Ai-file\MyTool\data\`。

---

## 8. 验证计划

1. **语法**：`vm.Script` 全文件内联脚本编译 0 错误。
2. **逻辑断言**：`verify-quizcore.js` 87/0（不受影响）；`verify-appstore.js` 更新后全绿。
3. **迁移实测**：装好新包启动 → 确认 `toolbox.db` 生成、`store.json` 变为 `store.json.migrated`、题库/错题/记录/日志/画板数据齐全。
4. **行级写入实测**：改一道题 → 观察只更新 `toolbox:quiz:questions` 那一行（可临时在 `db_put` 打日志或看文件 mtime）。
5. **崩溃安全**：答题中强杀进程 → 重启后数据一致（WAL 保证）。
6. **回滚演练**：把 `store.json.migrated` 还原、删库，旧版仍可读。

---

## 9. 实施步骤

1. `Cargo.toml` 加 `rusqlite`（bundled）。
2. `lib.rs`：`Db` 状态、`init_db`、`migrate_store_json`、四条命令、`run()` 接线。
3. `web/index.html`：改造 `AppStore` 的 Tauri 分支（接口不变）。
4. 更新 `tools/verify-appstore.js` 的 Tauri 段。
5. 跑语法 + 两套断言。
6. 用户 `npx -y @tauri-apps/cli@2 build` → 启动验证迁移与行级写入。

**预计改动**：Rust ≈ +130 行；前端 AppStore ≈ 改 60 行；测试 ≈ 改 40 行。

---

## 10. 本期不做 / 后续可加

- **不做**：把题库/错题/记录拆成关系表（方案 D）。现阶段保持键值表，工具零改动。
- **后续可加**（等真需要按分类/题型做 SQL 查询时）：
  - 在 `db_put` 写入 `toolbox:quiz:questions` 时，**顺带投影**到一张 `quiz_question(id, type, category, ...)` 表，供 SQL 统计查询；
  - 错题本、答题记录同理投影。
  - 这一步对现有代码仍是**加法**，可以随时再排期。

---

## 11. 决策点（请确认）

1. 采用**方案 C**（rusqlite + KV 表）？
2. DB 文件名用 `toolbox.db`，与 `store.json` 同目录，可以吗？
3. 旧 `store.json` 迁移后改名为 `store.json.migrated` **保留**（不删），同意吗？
