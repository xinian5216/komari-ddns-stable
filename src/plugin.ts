import { definePlugin, server, jsonResponse } from "@komari-monitor/plugin-sdk";

// Host modules (available when permissions.node is enabled). Kept as dynamic
// require so the bundler leaves them external and the runtime resolves them.
const fs = require("fs");
const path = require("path");

interface PluginConfig {
  api_token: string;
  interval: number;
  notify: boolean;
  records?: string; // legacy JSON textbox, only used for one-time seeding
}

interface RecordConfig {
  zone_id?: string;
  record_name: string;
  record_type: "A" | "AAAA";
  source_node: string[];
  ttl: number;
  proxied: boolean;
  comment?: string;
  api_token?: string;
}

interface SyncContext {
  nodes: Record<string, any>;
  statuses: Record<string, any>;
}

const CF_API = "https://api.cloudflare.com/client/v4";
const RECORDS_FILE = path.join(__storageDir__, "records.json");

function storageFile(): string {
  return path.join(__storageDir__, "state.json");
}

const LOGS_FILE = path.join(__storageDir__, "logs.json");
const MAX_LOGS = 500;

function isValidStateEntry(v: any): boolean {
  return (
    v &&
    typeof v.record_name === "string" &&
    v.record_name &&
    (v.record_type === "A" || v.record_type === "AAAA")
  );
}

function cleanState(state: Record<string, any>): Record<string, any> {
  const cleaned: Record<string, any> = {};
  for (const key of Object.keys(state || {})) {
    if (isValidStateEntry(state[key])) {
      cleaned[key] = state[key];
    }
  }
  return cleaned;
}

function loadState(): Record<string, any> {
  try {
    if (fs.existsSync(storageFile())) {
      const raw = JSON.parse(fs.readFileSync(storageFile(), "utf8"));
      return cleanState(raw);
    }
  } catch (e) {
    console.error("[cf-ddns] load state failed:", e);
  }
  return {};
}

function saveState(state: Record<string, any>): void {
  try {
    fs.writeFileSync(storageFile(), JSON.stringify(cleanState(state), null, 2));
  } catch (e) {
    console.error("[cf-ddns] save state failed:", e);
  }
}

function loadRecords(): RecordConfig[] {
  if (fs.existsSync(RECORDS_FILE)) {
    try {
      const arr = JSON.parse(fs.readFileSync(RECORDS_FILE, "utf8"));
      if (Array.isArray(arr)) return arr;
    } catch (e) {
      console.error("[cf-ddns] load records failed:", e);
    }
  }
  return [];
}

function saveRecords(arr: RecordConfig[]): void {
  fs.writeFileSync(RECORDS_FILE, JSON.stringify(arr, null, 2));
}

// Resolve the active record list: prefer the managed storage file, and seed it
// once from the legacy `records` config textbox if storage is empty.
function getRecords(config: PluginConfig): RecordConfig[] {
  const stored = loadRecords();
  if (stored.length > 0) return stored;
  const seeded = parseRecords(config);
  if (Array.isArray(seeded) && seeded.length > 0) {
    saveRecords(seeded);
    return seeded;
  }
  return stored;
}

function recordKey(name: string, type: string): string {
  return `${name}#${type}`;
}

// Parse the legacy `records` textbox (a JSON array of record objects).
function parseRecords(config: PluginConfig): RecordConfig[] | { error: string } {
  const raw = config.records;
  if (typeof raw !== "string" || !raw.trim()) {
    return { error: "records 配置为空" };
  }
  let arr: any;
  try {
    arr = JSON.parse(raw);
  } catch (e: any) {
    return { error: "records 不是合法 JSON：" + e.message };
  }
  if (!Array.isArray(arr)) {
    return { error: "records 必须是一个 JSON 数组" };
  }
  return arr.map((r: any) => ({
    zone_id: String(r.zone_id || ""),
    record_name: String(r.record_name || ""),
    record_type: r.record_type === "AAAA" ? "AAAA" : "A",
    source_node: Array.isArray(r.source_node)
      ? r.source_node.map((x: any) => String(x))
      : [],
    ttl: Number(r.ttl) || 60,
    proxied: !!r.proxied,
    comment: r.comment ? String(r.comment) : undefined,
    api_token: r.api_token ? String(r.api_token) : undefined,
  }));
}

async function resolveTargetIp(
  ctx: SyncContext,
  sourceNode: string[],
  recordType: string,
): Promise<{ uuid: string; name: string; ip: string } | null> {
  for (const uuid of sourceNode || []) {
    const node = ctx.nodes[uuid];
    if (!node) {
      console.warn(`[cf-ddns] node ${uuid} not found`);
      continue;
    }
    const st = ctx.statuses[uuid];
    if (st && st.online === false) {
      console.log(`[cf-ddns] node ${node.name} (${uuid}) is offline, skipping`);
      continue;
    }
    const ip = recordType === "AAAA" ? node.ipv6 : node.ipv4;
    if (ip) {
      return { uuid, name: node.name, ip };
    }
    console.log(`[cf-ddns] node ${node.name} has no ${recordType} address`);
  }
  return null;
}

async function cloudflareList(
  token: string,
  zone: string,
  name: string,
  type: string,
): Promise<any | null> {
  const url = `${CF_API}/zones/${zone}/dns_records?name=${encodeURIComponent(
    name,
  )}&type=${type}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await resp.json();
  if (!data.success) {
    throw new Error("Cloudflare list failed: " + JSON.stringify(data.errors));
  }
  return data.result && data.result.length ? data.result[0] : null;
}

async function cloudflareCreate(
  token: string,
  zone: string,
  payload: any,
): Promise<any> {
  const url = `${CF_API}/zones/${zone}/dns_records`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const data = await resp.json();
  if (!data.success) {
    throw new Error("Cloudflare create failed: " + JSON.stringify(data.errors));
  }
  return data.result;
}

async function cloudflareUpdate(
  token: string,
  zone: string,
  id: string,
  payload: any,
): Promise<any> {
  const url = `${CF_API}/zones/${zone}/dns_records/${id}`;
  const resp = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const data = await resp.json();
  if (!data.success) {
    throw new Error("Cloudflare update failed: " + JSON.stringify(data.errors));
  }
  return data.result;
}

// In-memory cache of zones per token to avoid repeated lookups within a run.
const zoneCache: Record<string, { zones: any[]; at: number }> = {};

async function cloudflareListZones(token: string): Promise<any[]> {
  const zones: any[] = [];
  let page = 1;
  while (true) {
    const url = `${CF_API}/zones?per_page=100&page=${page}`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await resp.json();
    if (!data.success) {
      throw new Error(
        "Cloudflare list zones failed: " + JSON.stringify(data.errors),
      );
    }
    zones.push(...(data.result || []));
    const info = data.result_info;
    if (!info || page >= info.total_pages) break;
    page++;
  }
  return zones;
}

async function getZones(token: string): Promise<any[]> {
  const cached = zoneCache[token];
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.zones;
  const zones = await cloudflareListZones(token);
  zoneCache[token] = { zones, at: Date.now() };
  return zones;
}

// Pick the most specific zone whose name is the record's apex (or a suffix).
function zoneForRecord(
  zones: any[],
  recordName: string,
): any | null {
  let best: any = null;
  for (const z of zones || []) {
    const name = z.name;
    if (
      recordName === name ||
      recordName.endsWith("." + name)
    ) {
      if (!best || name.length > best.name.length) best = z;
    }
  }
  return best;
}

function appendLog(entry: any): void {
  try {
    let arr: any[] = [];
    if (fs.existsSync(LOGS_FILE)) {
      try {
        const raw = JSON.parse(fs.readFileSync(LOGS_FILE, "utf8"));
        if (Array.isArray(raw)) arr = raw;
      } catch {
        arr = [];
      }
    }
    arr.push(entry);
    if (arr.length > MAX_LOGS) arr = arr.slice(arr.length - MAX_LOGS);
    fs.writeFileSync(LOGS_FILE, JSON.stringify(arr));
  } catch (e) {
    console.error("[cf-ddns] appendLog failed:", e);
  }
}

function logSync(
  rec: any,
  action: "create" | "update" | "skip" | "error" | "sync" | "delete" | "add" | "edit",
  success: boolean,
  detail: string,
  ip?: string,
): void {
  appendLog({
    time: new Date().toISOString(),
    record_name: rec.record_name,
    record_type: rec.record_type,
    action,
    success,
    detail,
    ip,
  });
}

async function syncRecord(
  config: PluginConfig,
  rec: any,
  ctx: SyncContext,
): Promise<Record<string, any>> {
  const key = recordKey(rec.record_name, rec.record_type);
  const result: Record<string, any> = {
    key,
    record_name: rec.record_name,
    record_type: rec.record_type,
    zone_id: rec.zone_id,
  };

  const token = rec.api_token || config.api_token;
  const sourceNode =
    rec.source_node && rec.source_node.length ? rec.source_node : [];

  if (
    !token ||
    !rec.record_name ||
    !sourceNode ||
    sourceNode.length === 0
  ) {
    result.error = "配置不完整（缺少 token / record_name / 来源节点）";
    logSync(rec, "error", false, result.error);
    return result;
  }

  const target = await resolveTargetIp(ctx, sourceNode, rec.record_type);
  if (!target) {
    result.skipped = "no valid node IP";
    logSync(rec, "skip", true, "无可用节点公网 IP");
    return result;
  }
  console.log(
    `[cf-ddns] [${rec.record_name}] resolved target: ${target.name} -> ${target.ip}`,
  );

  // Resolve the zone: use the explicitly configured zone_id, otherwise
  // auto-discover it from the record name via the Cloudflare API.
  let zoneId = rec.zone_id;
  if (!zoneId) {
    try {
      const zones = await getZones(token);
      const z = zoneForRecord(zones, rec.record_name);
      if (!z) {
        result.error =
          "无法自动解析 Zone ID（记录名 " +
          rec.record_name +
          " 在 Cloudflare 账号下找不到对应域名，可在记录中手动填写 zone_id 覆盖）";
        logSync(rec, "error", false, result.error);
        return result;
      }
      zoneId = z.id;
      console.log(
        `[cf-ddns] [${rec.record_name}] auto-resolved zone ${z.name} (${zoneId})`,
      );
    } catch (e) {
      result.error = String(e);
      logSync(rec, "error", false, result.error);
      return result;
    }
  }

  let record: any = null;
  try {
    record = await cloudflareList(
      token,
      zoneId,
      rec.record_name,
      rec.record_type,
    );
  } catch (e) {
    result.error = String(e);
    logSync(rec, "error", false, result.error);
    return result;
  }

  const payload = {
    type: rec.record_type,
    name: rec.record_name,
    content: target.ip,
    ttl: rec.ttl || 60,
    proxied: !!rec.proxied,
  };

  const st = loadState();
  const prev = st[key] || {};

  if (!record) {
    try {
      record = await cloudflareCreate(token, zoneId, payload);
    } catch (e) {
      result.error = String(e);
      logSync(rec, "error", false, result.error);
      return result;
    }
    console.log(
      `[cf-ddns] [${rec.record_name}] created -> ${target.ip} (id ${record.id})`,
    );
    result.created = true;
    result.current_ip = target.ip;
    logSync(rec, "create", true, `创建 DNS 记录 → ${target.ip}`, target.ip);
  } else {
    const wantProxied = !!rec.proxied;
    const ipChanged = record.content !== target.ip;
    const proxiedChanged = record.proxied !== wantProxied;
    if (!ipChanged && !proxiedChanged) {
      console.log(
        `[cf-ddns] [${rec.record_name}] already points to ${target.ip} (proxied=${wantProxied}), no change`,
      );
      result.updated = false;
      result.skipped = "no change";
      result.current_ip = target.ip;
      logSync(rec, "skip", true, "IP 与代理状态均无变化");
    } else {
      try {
        await cloudflareUpdate(token, zoneId, record.id, payload);
        console.log(
          `[cf-ddns] [${rec.record_name}] updated -> ${target.ip} (proxied=${wantProxied})`,
        );
        result.updated = true;
        result.current_ip = target.ip;
        logSync(
          rec,
          "update",
          true,
          `更新 DNS 记录 → ${target.ip}${
            proxiedChanged ? "（代理状态变更）" : ""
          }`,
          target.ip,
        );
      } catch (e) {
        result.error = String(e);
        logSync(rec, "error", false, result.error);
        return result;
      }
    }
  }

  st[key] = {
    record_name: rec.record_name,
    record_type: rec.record_type,
    last_ip: target.ip,
    last_node: target.name,
    last_checked_at: new Date().toISOString(),
    last_update_at:
      result.updated || result.created
        ? new Date().toISOString()
        : prev.last_update_at,
  };
  saveState(st);

  if ((result.updated || result.created) && config.notify) {
    await sendNotify(config, rec, target, result.created ? "创建" : "更新");
  }
  return result;
}

// Send a well-formed notification so the title, event type and associated
// server render correctly across all channels (Telegram / JS / etc.).
async function sendNotify(
  config: PluginConfig,
  rec: any,
  target: { uuid: string; name: string; ip: string },
  verb: string,
): Promise<void> {
  if (!config.notify) return;
  try {
    await server.call("admin:sendNotification", {
      event: {
        event: "DDNS",
        emoji: "🌐",
        message: `DDNS ${verb}：${rec.record_name} → ${target.ip}（节点 ${target.name}）`,
        time: new Date().toISOString(),
        clients: [{ uuid: target.uuid }],
      },
    });
  } catch (e) {
    console.warn("[cf-ddns] notify failed:", e);
  }
}

async function syncOnce(): Promise<Record<string, any>> {
  const config = (await server.getConfig()) as unknown as PluginConfig;
  const list = getRecords(config);
  if (list.length === 0) {
    return { ok: false, error: "尚未配置任何 DDNS 记录", records: [] };
  }

  const uuids = new Set<string>();
  for (const r of list) {
    const sn = r.source_node && r.source_node.length ? r.source_node : [];
    for (const u of sn) uuids.add(u);
  }

  const nodes = (await server.call("common:getNodes")) as Record<string, any>;
  let statuses: Record<string, any> = {};
  try {
    statuses = (await server.call("common:getNodesLatestStatus", {
      uuids: Array.from(uuids),
    })) as Record<string, any>;
  } catch (e) {
    console.warn(
      "[cf-ddns] getNodesLatestStatus failed, continuing without online check:",
      e,
    );
  }

  const ctx: SyncContext = { nodes, statuses };
  const results: Record<string, any>[] = [];
  for (const r of list) {
    try {
      results.push(await syncRecord(config, r, ctx));
    } catch (e: any) {
      results.push({
        key: recordKey(r.record_name, r.record_type),
        record_name: r.record_name,
        record_type: r.record_type,
        error: String(e),
      });
    }
  }
  const errors = results.filter((r) => r.error).length;
  const skipped = results.filter((r) => !r.error && r.skipped).length;
  const changed = results.length - errors - skipped;
  const logParts = ["共 " + results.length + " 条"];
  if (changed > 0) logParts.push("更新/创建 " + changed + " 条");
  if (skipped > 0) logParts.push("跳过 " + skipped + " 条");
  if (errors > 0) logParts.push("失败 " + errors + " 条");
  logSync({}, "sync", errors === 0, "同步完成：" + logParts.join("，"));
  return {
    ok: errors === 0,
    total: results.length,
    errors,
    skipped,
    records: results,
  };
}

function cronExpression(minutes: number): string {
  const m = Math.max(1, Math.min(59, Math.floor(minutes || 5)));
  return `*/${m} * * * *`;
}

function isAdmin(req: any): boolean {
  const principal = req && req.context && req.context.principal;
  if (!principal) return false;
  const roles: string[] = principal.roles || [];
  return principal.type === "user" && roles.indexOf("admin") >= 0;
}

function parseQuery(req: any): Record<string, string> {
  const q: Record<string, string> = {};
  const u = (req && req.url) || "";
  const idx = u.indexOf("?");
  if (idx < 0) return q;
  u.slice(idx + 1)
    .split("&")
    .forEach((pair: string) => {
      if (!pair) return;
      const i = pair.indexOf("=");
      const k = i < 0 ? pair : pair.slice(0, i);
      const v = i < 0 ? "" : pair.slice(i + 1);
      try {
        q[decodeURIComponent(k)] = decodeURIComponent(v);
      } catch {
        /* ignore malformed */
      }
    });
  return q;
}

function loadLogs(): any[] {
  try {
    if (fs.existsSync(LOGS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(LOGS_FILE, "utf8"));
      if (Array.isArray(raw)) return raw;
    }
  } catch (e) {
    console.error("[cf-ddns] load logs failed:", e);
  }
  return [];
}

definePlugin({
  load() {
    server
      .getConfig()
      .then((cfg: any) => {
        const interval = (cfg && cfg.interval) || 5;
        server.cron(cronExpression(interval), () => {
          syncOnce().catch((e) => console.error("[cf-ddns] cron error:", e));
        });
        console.log(`[cf-ddns] scheduled sync every ${interval} minute(s)`);
      })
      .catch((e) => console.error("[cf-ddns] getConfig error:", e));

    // Current sync state per record.
    server.route("GET", "/cf-ddns/status", (req: any, res: any) => {
      if (!isAdmin(req)) {
        res.statusCode = 401;
        res.end("unauthorized");
        return;
      }
      jsonResponse(res, loadState());
    });

    // Run a sync across all records.
    server.route("POST", "/cf-ddns/sync", async (req: any, res: any) => {
      if (!isAdmin(req)) {
        res.statusCode = 401;
        res.end("unauthorized");
        return;
      }
      const r = await syncOnce();
      jsonResponse(res, r);
    });

    // Node list for the source-node picker.
    server.route("GET", "/cf-ddns/nodes", async (req: any, res: any) => {
      if (!isAdmin(req)) {
        res.statusCode = 401;
        res.end("unauthorized");
        return;
      }
      try {
        const nodes = (await server.call("common:getNodes")) as Record<
          string,
          any
        >;
        const list = Object.keys(nodes).map((u) => ({
          uuid: u,
          name: nodes[u] && nodes[u].name ? nodes[u].name : u,
        }));
        jsonResponse(res, list);
      } catch (e) {
        jsonResponse(res, { error: String(e) }, 500);
      }
    });

    // Read the current record list (managed in plugin storage).
    server.route("GET", "/cf-ddns/records", async (req: any, res: any) => {
      if (!isAdmin(req)) {
        res.statusCode = 401;
        res.end("unauthorized");
        return;
      }
      const config = (await server.getConfig()) as unknown as PluginConfig;
      jsonResponse(res, getRecords(config));
    });

    // Save the entire record list (add/edit/delete handled client-side).
    server.route("PUT", "/cf-ddns/records", async (req: any, res: any) => {
      if (!isAdmin(req)) {
        res.statusCode = 401;
        res.end("unauthorized");
        return;
      }
      let arr: any;
      try {
        arr = JSON.parse(req.body || "null");
      } catch (e) {
        jsonResponse(res, { error: "请求体不是合法 JSON" }, 400);
        return;
      }
      if (!Array.isArray(arr)) {
        jsonResponse(res, { error: "记录必须是 JSON 数组" }, 400);
        return;
      }
      const clean = arr.map((r: any) => ({
        zone_id: String(r.zone_id || ""),
        record_name: String(r.record_name || ""),
        record_type: (r.record_type === "AAAA" ? "AAAA" : "A") as "A" | "AAAA",
        source_node: Array.isArray(r.source_node)
          ? r.source_node.map((x: any) => String(x))
          : [],
        ttl: Number(r.ttl) || 60,
        proxied: !!r.proxied,
        comment: r.comment ? String(r.comment) : undefined,
        api_token: r.api_token ? String(r.api_token) : undefined,
      }));
      // Detect additions and deletions by diffing against the previously stored records.
      const oldRecs = loadRecords();
      const oldMap = new Map<string, any>();
      oldRecs.forEach((r: any) =>
        oldMap.set(recordKey(r.record_name, r.record_type), r),
      );
      const oldKeys = new Set(oldMap.keys());
      const newKeys = new Set(
        clean.map((r: any) => recordKey(r.record_name, r.record_type)),
      );
      let added = 0;
      let removed = 0;
      let edited = 0;
      const changedFields = (a: any, b: any): string[] => {
        const out: string[] = [];
        const cmp = (k: string, label: string) => {
          if (String(a[k] ?? "") !== String(b[k] ?? "")) out.push(label);
        };
        cmp("zone_id", "Zone");
        cmp("record_name", "名称");
        cmp("record_type", "类型");
        cmp("ttl", "TTL");
        cmp("proxied", "代理");
        cmp("comment", "备注");
        const sa = (a.source_node || []).join(",");
        const sb = (b.source_node || []).join(",");
        if (sa !== sb) out.push("来源节点");
        if (!!a.api_token !== !!b.api_token) out.push("Token");
        return out;
      };
      clean.forEach((r: any) => {
        const key = recordKey(r.record_name, r.record_type);
        const old = oldMap.get(key);
        if (!old) {
          added++;
          logSync(r, "add", true, `新增记录 ${r.record_name} (${r.record_type})`);
        } else {
          const fields = changedFields(old, r);
          if (fields.length) {
            edited++;
            logSync(
              r,
              "edit",
              true,
              `修改记录 ${r.record_name} (${r.record_type})：${fields.join("、")}`,
            );
          }
        }
      });
      oldRecs.forEach((r: any) => {
        if (!newKeys.has(recordKey(r.record_name, r.record_type))) {
          removed++;
          logSync(r, "delete", true, `删除记录 ${r.record_name} (${r.record_type})`);
        }
      });
      saveRecords(clean);
      jsonResponse(res, { ok: true, total: clean.length, added, removed, edited });
    });

    // Query the sync operation log. Supports ?record=<name>&limit=<n>.
    server.route("GET", "/cf-ddns/logs", (req: any, res: any) => {
      if (!isAdmin(req)) {
        res.statusCode = 401;
        res.end("unauthorized");
        return;
      }
      const q = parseQuery(req);
      let logs = loadLogs();
      if (q.record) {
        logs = logs.filter((l) => l.record_name === q.record);
      }
      const limit = parseInt(q.limit || "100", 10);
      const n = isNaN(limit) || limit <= 0 ? 100 : Math.min(limit, 1000);
      const out = logs.slice(-n).reverse(); // newest first
      jsonResponse(res, { total: logs.length, logs: out });
    });

    // Clear the sync operation log.
    server.route("DELETE", "/cf-ddns/logs", (req: any, res: any) => {
      if (!isAdmin(req)) {
        res.statusCode = 401;
        res.end("unauthorized");
        return;
      }
      try {
        if (fs.existsSync(LOGS_FILE)) fs.unlinkSync(LOGS_FILE);
      } catch (e) {
        jsonResponse(res, { ok: false, error: String(e) }, 500);
        return;
      }
      jsonResponse(res, { ok: true });
    });
  },
});
