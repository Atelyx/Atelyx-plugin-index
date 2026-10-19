/**
 * 插件市场索引聚合脚本。
 *
 * 扫描 GitHub 上打了 `atelyx-plugin` topic 的仓库，逐个校验：
 * 默认分支存在合法的 `plugin.json`（反向域名 id / 名称 / 版本 / apiVersion 与宿主一致 / 至少一个平台入口），
 * 且仓库最新 Release 挂着按约定命名的平台安装包（`<id>-<版本>-<平台>.zip`）——没有可下载的安装包，
 * 收进索引也装不上。校验通过后写入 `index.json`（按 star 降序，上限 500）。
 *
 * 清单或 Release 暂时取不到（网络抖动 / 限流）时沿用上一轮条目（只刷新 star 与时间），避免一次抖动
 * 让正常插件从市场消失一个周期；404 或清单本身不合法属确定性失效，直接剔除。索引每轮全量重建，
 * 失效条目无需单独清理。
 *
 * 徽标不在索引中：App 侧按 repo owner 判定官方。
 */
import { readFileSync, writeFileSync } from "node:fs";

const TOPIC = "atelyx-plugin";
const MANIFEST = "plugin.json";
// 宿主协议版本（与 atelyx-plugin-protocol 的 API_VERSION 一致，不一致即装载失败）。
const API_VERSION = 1;
const CAP = 500;
// 平台取值 = App 侧的 platform_tag；包名后缀与 plugin.json 的 entry 字段一一对应。
const PLATFORMS = [
  { tag: "windows-x64", entry: "windows" },
  { tag: "linux-x64", entry: "linux" },
];
// 清单 / Release 抓取尝试次数（首次 + 2 次重试），间隔按次数递增；仍失败即视为暂时取不到。
const FETCH_ATTEMPTS = 3;
const RETRY_BASE_MS = 1500;
const HEADERS = { "User-Agent": "atelyx-plugin-index", "Accept": "application/vnd.github+json" };
if (process.env.GH_TOKEN) HEADERS.Authorization = `Bearer ${process.env.GH_TOKEN}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function gh(url) {
  const resp = await fetch(url, { headers: HEADERS });
  if (!resp.ok) throw new Error(`GitHub API ${resp.status}: ${url}`);
  return resp.json();
}

const nonEmpty = (v) => typeof v === "string" && v.trim().length > 0;

/** 反向域名 id：至少两段，每段字母 / 数字 / `-`，不以 `-` 起止（与宿主校验同口径）。 */
function validId(id) {
  if (typeof id !== "string" || id.startsWith(".") || /[/\\]/.test(id)) return false;
  const labels = id.split(".");
  if (labels.length < 2) return false;
  return labels.every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label));
}

/** 原生清单校验：宿主安装与装载时同样要求这些字段，任一条不过都是确定性失效。 */
function validManifest(m) {
  if (!m || typeof m !== "object") return false;
  if (!validId(m.id) || !nonEmpty(m.name) || !nonEmpty(m.version)) return false;
  if (m.apiVersion !== API_VERSION) return false;
  const entry = m.entry;
  if (!entry || typeof entry !== "object") return false;
  return PLATFORMS.some((p) => nonEmpty(entry[p.entry]));
}

/** 清单声明支持的平台（用于与 Release 资产对账）。 */
function declaredPlatforms(manifest) {
  return PLATFORMS.filter((p) => nonEmpty(manifest.entry[p.entry]));
}

/** Release 里按约定命名的平台安装包：`<id>-<版本>-<平台>.zip`（大小写不敏感，与 App 侧匹配同口径）。 */
function releaseAssets(release, id, version) {
  const names = (Array.isArray(release.assets) ? release.assets : [])
    .map((asset) => (typeof asset.name === "string" ? asset.name.toLowerCase() : ""))
    .filter(Boolean);
  const found = new Set();
  for (const p of PLATFORMS) {
    const expected = `${id}-${version}-${p.tag}.zip`.toLowerCase();
    if (names.includes(expected)) found.add(p.tag);
  }
  return found;
}

/** 上一轮索引条目（按 repo 检索）；文件缺失/损坏时视为空，本轮退化为全量重建。 */
function readPreviousItems() {
  try {
    const prev = JSON.parse(readFileSync("index.json", "utf8"));
    return Array.isArray(prev.items) ? prev.items : [];
  } catch {
    return [];
  }
}

/**
 * 取一个 JSON 文件，区分失败性质（决定是重试、剔除还是沿用上一轮）：
 * - ok：取到且解析成功；
 * - invalid：404，或 200 但正文非 JSON——确定性失效，剔除；
 * - unavailable：重试用尽仍是网络/服务端错误（含限流）——暂时取不到，可沿用上一轮条目。
 */
async function fetchJsonFile(url) {
  let reason = "unknown";
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    try {
      const resp = await fetch(url, { headers: { "User-Agent": "atelyx-plugin-index" } });
      if (resp.status === 404) return { state: "invalid" };
      if (resp.ok) {
        try {
          return { state: "ok", value: await resp.json() };
        } catch {
          return { state: "invalid" };
        }
      }
      reason = `HTTP ${resp.status}`;
    } catch (e) {
      reason = e.message;
    }
    if (attempt < FETCH_ATTEMPTS) await sleep(RETRY_BASE_MS * attempt);
  }
  return { state: "unavailable", reason };
}

/** 最新 Release；仓库没有发布 = invalid，取数失败 = unavailable。 */
async function fetchLatestRelease(repo) {
  let reason = "unknown";
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    try {
      const resp = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers: HEADERS,
      });
      if (resp.status === 404) return { state: "invalid" };
      if (resp.ok) return { state: "ok", value: await resp.json() };
      // 限流按暂时取不到处理：本轮沿用上一轮条目，不在索引里制造空洞
      reason = `HTTP ${resp.status}`;
    } catch (e) {
      reason = e.message;
    }
    if (attempt < FETCH_ATTEMPTS) await sleep(RETRY_BASE_MS * attempt);
  }
  return { state: "unavailable", reason };
}

/** tag 剥 `v`/`V` 前缀后的版本号（与 App 侧取版本同口径）。 */
function tagVersion(tag) {
  const text = typeof tag === "string" ? tag.trim() : "";
  return text.replace(/^[vV]/, "");
}

async function main() {
  const previousByRepo = new Map(readPreviousItems().map((item) => [item.repo, item]));
  const items = [];
  let page = 1;
  while (page <= 10 && items.length < CAP) {
    const data = await gh(
      `https://api.github.com/search/repositories?q=topic:${TOPIC}&sort=stars&order=desc&per_page=100&page=${page}`,
    );
    const repos = data.items ?? [];
    if (repos.length === 0) break;
    for (const repo of repos) {
      if (items.length >= CAP) break;
      const meta = { stars: repo.stargazers_count, updatedAt: repo.updated_at };
      const keepPrevious = (why) => {
        const prev = previousByRepo.get(repo.full_name);
        if (!prev) {
          console.warn(`${repo.full_name} ${why}，本轮不收录`);
          return;
        }
        // star/时间取本轮搜索（新鲜元数据），清单字段沿用上一轮
        items.push({ ...prev, ...meta });
        console.warn(`${repo.full_name} ${why}，沿用上一轮条目`);
      };

      const manifest = await fetchJsonFile(
        `https://raw.githubusercontent.com/${repo.full_name}/${repo.default_branch}/${MANIFEST}`,
      );
      if (manifest.state === "unavailable") {
        keepPrevious(`清单暂时取不到（${manifest.reason}）`);
        continue;
      }
      if (manifest.state === "invalid" || !validManifest(manifest.value)) {
        console.warn(`${repo.full_name} 缺合法 ${MANIFEST}，跳过`);
        continue;
      }
      const plugin = manifest.value;

      const release = await fetchLatestRelease(repo.full_name);
      if (release.state === "unavailable") {
        keepPrevious(`发布信息暂时取不到（${release.reason}）`);
        continue;
      }
      if (release.state === "invalid") {
        console.warn(`${repo.full_name} 没有 Release，无法安装，跳过`);
        continue;
      }
      const version = tagVersion(release.value.tag_name);
      if (!version) {
        console.warn(`${repo.full_name} 最新 Release 缺 tag，跳过`);
        continue;
      }
      const assets = releaseAssets(release.value, plugin.id, version);
      if (assets.size === 0) {
        console.warn(`${repo.full_name} 的 Release 未挂约定的平台安装包，跳过`);
        continue;
      }
      for (const p of declaredPlatforms(plugin)) {
        if (!assets.has(p.tag)) {
          console.warn(`${repo.full_name} 声明了 ${p.entry} 但 Release 缺 ${p.tag} 包`);
        }
      }
      if (version !== plugin.version) {
        console.warn(
          `${repo.full_name} 清单版本 ${plugin.version} 与最新 Release ${version} 不一致（以 Release 为准）`,
        );
      }

      const item = {
        id: plugin.id,
        name: plugin.name,
        repo: repo.full_name,
        defaultBranch: repo.default_branch,
        ...meta,
        topics: repo.topics ?? [],
      };
      // 简介取仓库描述（原生清单没有 tagline 字段）；市场类型可选，写在清单的 type 里
      if (nonEmpty(repo.description)) item.tagline = repo.description.trim();
      if (nonEmpty(plugin.type)) item.type = plugin.type.trim();
      items.push(item);
    }
    if (data.total_count <= page * 100) break;
    page++;
  }
  const out = { generatedAt: new Date().toISOString(), version: "v1", items };
  writeFileSync("index.json", JSON.stringify(out, null, 2) + "\n");
  console.log(`index.json 更新：${items.length} 个插件`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
