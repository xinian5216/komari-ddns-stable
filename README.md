# Komari DDNS Stable

Maintenance fork of [yunjianj/Komari-DDNS](https://github.com/yunjianj/Komari-DDNS), authored by 穿云箭. Original MIT license and history are preserved. See UPSTREAM.md.

This release stops DNS updates when the selected node is not confirmed online or the status query fails. Existing short cf-ddns, records and configuration remain compatible. See SECURITY.md before installation and back up the database and data/plugin-data/cf-ddns/.

TTL-only changes are synchronized as well. Cloudflare-proxied records use automatic TTL. Overlapping manual and scheduled sync requests share one operation. Records and state are replaced through temporary files; failed record saves return an error while retaining the previous records.

Build: Node.js 22, npm ci, npm run verify. Published ZIP and SHA256SUMS are under dist/.

Maintained source: https://raw.githubusercontent.com/xinian5216/komari-stable/stable/plugin-market/v1.json .

---

# Komari DDNS 插件

> ⚠️ **免责声明**：本项目由 AI 辅助完成，按「现状」提供，**风险自负**。作者不对因使用本插件造成的任何问题（包括但不限于 DNS 配置错误、解析异常、服务中断、数据泄露等）承担任何责任。请在充分理解代码的前提下于测试环境中自行验证后再用于生产环境。

根据 Komari **节点上报的公网 IP**，自动更新 Cloudflare DNS 解析记录，实现动态域名解析（DDNS）。

## 工作原理

1. 按设定间隔（`interval`，默认 5 分钟）触发一次同步；
2. 遍历 `records` 中的每一条记录；对每条记录，取它指定的**来源节点**所上报的**在线**公网 IP（A 记录取 ipv4，AAAA 记录取 ipv6）；
3. 读取该节点的 `ipv4`（`A` 记录）或 `ipv6`（`AAAA` 记录）；
4. 调用 Cloudflare API 查询目标 DNS 记录，记录不存在则**自动创建**，存在但 IP、橙色云状态或 TTL 不一致则**更新**；橙色云记录使用自动 TTL；
5. 每条记录的状态独立持久化到插件长期存储目录（`__storageDir__`），更新/创建时可选择发送通知。

## 配置项

| 配置 | 说明 |
| --- | --- |
| `api_token` | 全局 Cloudflare API Token（需 `Zone:DNS:Edit` 权限），默认所有记录共用 |
| `interval` | 检查间隔（分钟，默认 5） |
| `notify` | 更新/创建时是否发送 Komari 通知 |

> **DDNS 记录不在插件配置里填写**，而是在管理页面通过表单可视化增删改（数据保存在插件长期存储目录 `records.json`）。这样无需手写 JSON。

`records` 数组中每项的字段（仅在需要直接编辑存储文件 `records.json` 时参考；日常通过管理页面表单操作）：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `zone_id` | 否 | 域名所在的 Zone ID；**留空时由插件通过 Cloudflare API 按记录名自动匹配**（推荐留空） |
| `record_name` | 是 | 记录名称（FQDN，如 `home.example.com`） |
| `record_type` | 否 | `A` 或 `AAAA`，默认 `A` |
| `source_node` | 否 | 节点 UUID；记录所用的来源节点（单节点） |
| `ttl` | 否 | TTL；`1` 表示「自动」（默认），其余可选 60/120/300/600/900/1800/3600/7200/18000/43200/86400（秒） |
| `proxied` | 否 | 是否启用 Cloudflare 代理（橙色云），默认 `false` |
| `comment` | 否 | 备注，仅在管理页展示，不参与同步 |
| `api_token` | 否 | 可选；填写则覆盖该记录全局 `api_token`（仅建议通过直接编辑 `records.json` 设置，管理页表单不暴露此字段，前端读取时一律脱敏） |

## 开发

```sh
npm install
# 编辑 komari.local.json，填入开发服务器地址与 API Key
npm run dev        # 编译、上传、启用并热重载
npm run typecheck  # 仅类型检查
npm run build      # 编译
npm run pack       # 打包为 ZIP
```

## 手动安装

```sh
npm run pack
```

在 Komari 管理后台「插件」页面上传生成的 ZIP，启用并批准所需权限（`allowSystemRPC`、`allowRoutes`）。

## 权限说明

- `node`：使用 `fs` 持久化状态到长期存储目录；
- `allowSystemRPC`：调用 `common:getNodes` / `common:getNodesLatestStatus` / `admin:sendNotification`；
- `allowRoutes`：注册状态与手动同步路由（仅管理员可访问）。

## 管理页面

启用后在管理后台侧边栏「插件」分组下打开「DDNS 状态」页面。页面仿照 Cloudflare DNS 记录列表：

- **列表字段**：名称、类型、来源节点、代理状态（橙色云开关）、TTL、内容（当前解析 IP）、备注、操作。
- **编辑面板**：点击「编辑」展开类 Cloudflare 的编辑面板；其中「内容」字段替换为「来源节点」选择器（因为 IP 由节点自动上报），另有名称、类型、代理状态、TTL、备注。
- **添加 / 删除**：支持添加新记录或在编辑面板删除已有记录。
- **立即同步全部**：手动触发一次全量同步。
- **日志查询**：切换到「日志」标签查看每次同步的操作历史，包含时间、记录名、类型、操作（创建/更新/跳过/错误，彩色标签）与详情；支持按记录名筛选、限制条数（默认 100、最多 1000）、刷新与清空。

> 旧的 `records` 配置（JSON 文本框）在首次加载时会被自动迁移到存储文件，之后以管理页面维护的内容为准。
