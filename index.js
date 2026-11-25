/**
 * dsh-workbuddy-fetch
 *
 * 把 DeepSeek Harness 的 **抓取** 侧（`ctx.web` 的 fetch seam / 内置 `web_fetch` 工具）
 * 也接到 WorkBuddy 的网页抓取网关，复用同一个桌面端登录态。
 *
 * ───────────────────────────── 为什么要单独一个包 ─────────────────────────────
 *
 * `dsh-workbuddy-websearch` 只接管了**搜索**（`searchProvider`），它的 README 与
 * 「注意事项」里明确写着：
 *
 *   | 工具 | 谁提供 | 是否用 WorkBuddy 登录态 |
 *   | `web_search` | 本插件 | ✅ |
 *   | `web_fetch`  | dsh 内置 `web-fetch-http` | ❌ 直连目标站点 |
 *
 * 本插件补的正是第二行：注册一个 fetch provider `workbuddy-fetch`，把 `web` 行的
 * `fetchProvider` 指过来。搜索侧完全不动，两个插件可以同时装、互不干扰 ——
 * 它们注册的 provider 分属 **两个不同的注册表**（search / fetch），不会撞 id。
 *
 * ───────────────────────────── 端点取证 ─────────────────────────────
 *
 * 来自 WorkBuddy 桌面端 CLI 产物（`resources/app.asar.unpacked/cli/dist/
 * codebuddy-lite-wb.mjs`，`WebFetchTool` 类）：
 *
 * - `POST {endpoint}/agenttool/v1/webfetch`，`Authorization: Bearer <token>`
 * - body: `{ url, format: "markdown" | "html" | "screenshot", prompt?, timeout, max_length, model_name? }`
 *   - `timeout` 单位是**秒**（桌面端传 `Math.floor(20000 / 1000)`）
 * - 200 响应: `{ url, title, content, content_type, content_length, truncated, status_code }`
 * - 失败响应: `{ code, msg }`（HTTP 状态可能是 400/403/500），`code` 是数字
 *   - `15018` = SSRF/URL 安全校验拒绝（含「解析不出域名」「端口不允许」「内网 IP」）
 *   - `15021` = 出口路由策略拒绝（**按域名**，不是按内容）
 *   - `15013` = 参数不合法（format/url）
 * - 鉴权失败由网关直接回 `401` + HTML 401 页面（不是 JSON）
 *
 * ⚠️ **实测结论（本机，2026-11）**：该网关**不是全站可用**。
 * `github.com` / `zhihu.com` / `csdn.net` / `juejin.cn` / `docs.python.org` 正常，
 * 但 `en.wikipedia.org` / `medium.com` / `bbc.com` / `news.ycombinator.com`
 * 一律 `15021 domain rejected by via routing policy`。
 *
 * 因此本插件**默认带本地回落**（`fallback: true`）：网关拒绝或不可用时，
 * 改用 dsh 自带的 `@deepseek-ai/dsh-web-fetch-http`（就是装本插件之前
 * `web_fetch` 用的那个后端）完成同一次抓取。这样 `web_fetch` 的**能力只增不减** ——
 * 装上它之后，原本能抓的照样能抓，原本抓不了的（被墙站点的正文抽取）多了一层云端增强。
 *
 * ───────────────────────────── 安全取舍 ─────────────────────────────
 *
 * - 网关判定的 **`decisive`** 拒绝（若上游带该字段）**不回落**：那是安全侧的明确裁决，
 *   回落等于绕过裁决。
 * - 非 decisive 的拒绝（含 `15021` 出口路由策略、网络错误、502）回落 —— 这些
 *   都属于「这一条路径走不通」，不是「这个 URL 危险」。
 * - 回落路径走 dsh 自带的 `HttpFetchProvider`，它保留原有的全部防护：
 *   仅公共地址、DNS 结果全量校验、连接固定到已校验地址、同源重定向、字节/字符上限。
 *   换句话说：回落后**不会**比装插件之前更宽松。
 * - 本插件**只读** WorkBuddy 的凭据文件，令牌续期只在内存中完成，不回写磁盘。
 *
 * @module dsh-workbuddy-fetch
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

/** Cordis 插件名（loader 诊断用）。 */
export const name = "workbuddy-fetch";
/**
 * 依赖的服务接缝。
 *
 * - `web`：抓取 provider 注册 + 搜索委托的落点，**必需**。
 * - `loader`：**只用于判断上游插件行是否已挂载**（见 `isUpstreamEntryMounted`）。
 *   写成对象形式 `{ loader: null }` 是 cordis 的**可选注入**语法：服务在时
 *   `ctx.loader` 可用，不在时也不会让本插件激活失败 —— 而 `loader` 缺失时
 *   `isUpstreamEntryMounted` 会保守地返回 `true`（假设上游在，由它自己注册），
 *   避免重复注册。
 *
 * 注：数组形式 `["web", "loader"]` 是**必需注入**，loader 不可用会让整行激活失败，
 * 那会把「判断不了」升级成「起不来」，得不偿失。
 */
export const inject = { web: null, loader: null };

/** 本 provider 在 ctx.web 里的稳定 id（也写进 cordis.patch.yml 的 web 行）。 */
const PROVIDER_ID = "workbuddy-fetch";
/** 提供搜索能力（并被本插件委托注册）的上游插件包名。 */
const UPSTREAM_PACKAGE = "dsh-workbuddy-websearch";
/** 云端 webfetch 端点（桌面端 CLI 同款路径）。 */
const FETCH_PATH = "/agenttool/v1/webfetch";
/** 桌面端同款 UA；网关对 UA 没有强校验，但保持与官方客户端一致。 */
const USER_AGENT = "CLI/2.63.2 CodeBuddy/2.63.2";

/** 默认：云端抓取预算（毫秒）。桌面端用 20s，这里保持一致。 */
const DEFAULT_TIMEOUT_MS = 20_000;
/** 默认：回落后的本地抓取预算（毫秒）。要比云端短，避免一次 web_fetch 打满工具预算。 */
const DEFAULT_FALLBACK_TIMEOUT_MS = 15_000;
/** 默认：回传正文的字符上限（与桌面端 max_length 默认 100000 一致）。 */
const DEFAULT_MAX_LENGTH = 100_000;

// ─────────────────────────── 配置（cordis config + 环境变量） ───────────────────────────

/**
 * 运行时配置。来源优先级：cordis config（profile 的 cordis.patch.yml）
 * > 环境变量 > 内置默认。
 *
 * 刻意不声明 `Config` schema：本插件只依赖极窄的一个接缝，且**不引入**对
 * schemastery 的静态依赖（见下方 `loadHostModule` 的说明）。未声明 schema 时
 * loader 会把行里的 `config` 原样交给 `apply()`，这里自己校验。
 */
let runtimeConfig = {};

function configValue(key) {
  const value = runtimeConfig?.[key];
  return value === undefined ? undefined : value;
}

function envValue(key) {
  const value = process.env[key];
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

function settingBool(configKey, envKey, fallback) {
  const raw = configValue(configKey) ?? envValue(envKey);
  if (raw === undefined) return fallback;
  if (typeof raw === "boolean") return raw;
  const lowered = String(raw).trim().toLowerCase();
  if (lowered === "1" || lowered === "true" || lowered === "yes" || lowered === "on") return true;
  if (lowered === "0" || lowered === "false" || lowered === "no" || lowered === "off") return false;
  return fallback;
}

function settingNumber(configKey, envKey, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = configValue(configKey) ?? envValue(envKey);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) return fallback;
  return Math.floor(value);
}

function settingString(configKey, envKey) {
  const raw = configValue(configKey) ?? envValue(envKey);
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : undefined;
}

/** 解析成运行时设置（每次读而不是缓存，便于测试与热更新）。 */
function readSettings() {
  return {
    /** 云端拒绝/不可用时是否回落本地抓取。默认开 —— 见模块头部的「实测结论」。 */
    fallback: settingBool("fallback", "WORKBUDDY_FETCH_FALLBACK", true),
    /** 云端抓取预算（毫秒）。 */
    timeoutMs: settingNumber("timeoutMs", "WORKBUDDY_FETCH_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, { min: 1_000, max: 300_000 }),
    /** 本地回落抓取预算（毫秒）。 */
    fallbackTimeoutMs: settingNumber("fallbackTimeoutMs", "WORKBUDDY_FETCH_FALLBACK_TIMEOUT_MS", DEFAULT_FALLBACK_TIMEOUT_MS, { min: 1_000, max: 300_000 }),
    /** 回传正文字符上限；0 = 不截断。 */
    maxLength: settingNumber("maxLength", "WORKBUDDY_FETCH_MAX_LENGTH", DEFAULT_MAX_LENGTH, { min: 0, max: 10_000_000 }),
    /** 网关地址覆盖（默认按凭据所在区域自动选）。 */
    endpoint: settingString("endpoint", "WORKBUDDY_FETCH_ENDPOINT")?.replace(/\/+$/u, ""),
  };
}

// ─────────────────────────── 宿主模块解析 ───────────────────────────

/**
 * 解析宿主包（`dsh-workbuddy-websearch`、`@deepseek-ai/dsh-web*`）。
 *
 * **为什么不能直接静态 import**：插件可能以 `link:` 方式从工作区目录安装，
 * 此时模块的真实位置在工作区（如 `D:\...\dsh-workbuddy-fetch`），从那里向上
 * 找不到 profile 的 `node_modules`，也找不到 dsh 自己的 `node_modules`。
 * Node 的 ESM 解析又是**锚在真实路径**上的（默认 `preserve-symlinks` 关闭），
 * 所以裸 `import()` 在这种装法下必然失败。
 *
 * 因此按「由准到糙」依次尝试：
 *   1. 裸 `import()` —— 常规 `npm/pnpm add` 装法下最直接；
 *   2. **`ctx.baseUrl`** —— loader 把这一行的上下文根设为配置文件所在目录，
 *      也就是 profile 目录。**这是唯一不依赖环境变量的可靠锚点**：
 *      宿主进程本身不保证有 `DSH_PROFILE_DIR`（那是给 shell 用的），
 *      而 `link:` 装法又让「从自身向上找」失效；
 *   3. `DSH_PROFILE_DIR` / `DSH_HOME` + `DSH_PROFILE` —— 环境变量在场时兜底；
 *   4. 上面都给不出时，把 profile 的 `node_modules` 目录塞进 `paths` 再解析一次。
 */
let contextBaseUrl;

/** 解析锚点（可执行 `require` 的路径）。 */
function anchorCandidates() {
  const anchors = [];
  const push = (value) => {
    if (typeof value === "string" && value !== "" && !anchors.includes(value)) anchors.push(value);
  };
  if (contextBaseUrl !== undefined) {
    try {
      push(join(fileURLToPath(contextBaseUrl), "package.json"));
    } catch {}
  }
  const profileDir = process.env.DSH_PROFILE_DIR;
  if (profileDir !== undefined && profileDir.trim() !== "") push(join(profileDir.trim(), "package.json"));
  const home = process.env.DSH_HOME;
  const root = home === undefined || home.trim() === "" ? join(homedir(), ".dsh") : home.trim();
  const profile = process.env.DSH_PROFILE;
  if (profile !== undefined && profile.trim() !== "") push(join(root, "profiles", profile.trim(), "package.json"));
  push(join(root, "package.json"));
  // 最后一条：从自身真实路径向上找（常规安装时这条命中）。
  try {
    push(fileURLToPath(new URL("package.json", import.meta.url)));
  } catch {}
  return anchors;
}

const requireCache = new Map();
function nodeRequire(anchor) {
  let cached = requireCache.get(anchor);
  if (cached === undefined) {
    cached = createRequire(anchor);
    requireCache.set(anchor, cached);
  }
  return cached;
}

/**
 * 逐个锚点解析 + 加载。
 * @param {string} spec - 包名或子路径（如 `dsh-workbuddy-websearch`）。
 * @returns {Promise<unknown | undefined>} 模块命名空间；全部失败返回 undefined。
 */
async function loadHostModule(spec) {
  const anchors = anchorCandidates();
  try {
    return await import(spec);
  } catch {}
  for (const anchor of anchors) {
    const req = nodeRequire(anchor);
    try {
      return await req(spec);
    } catch {}
    try {
      const resolved = req.resolve(spec);
      return await import(pathToFileURL(resolved).href);
    } catch {}
  }
  // 兜底：显式把 profile 的 node_modules 作为解析目录传进去。
  const searchPaths = anchors
    .map((anchor) => join(dirname(anchor), "node_modules"))
    .filter((value) => existsSync(value));
  for (const anchor of anchors) {
    const req = nodeRequire(anchor);
    for (const paths of searchPaths) {
      try {
        const resolved = req.resolve(spec, { paths: [paths] });
        return await import(pathToFileURL(resolved).href);
      } catch {}
    }
  }
  return undefined;
}

/** 构造 `WebError`（宿主缺席时降级为带 code 的普通 Error，保住错误分类）。 */
let webErrorCtor;
async function resolveWebError() {
  if (webErrorCtor !== undefined) return webErrorCtor;
  const mod = await loadHostModule("@deepseek-ai/dsh-web");
  webErrorCtor = mod?.WebError ?? null;
  return webErrorCtor;
}

async function webError(message, code, cause) {
  const Ctor = await resolveWebError();
  if (Ctor !== undefined && Ctor !== null) {
    return cause === undefined ? new Ctor(message, code) : new Ctor(message, code, { cause });
  }
  const error = new Error(message);
  if (code !== undefined) error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

// ─────────────────────────── 本地回落后端 ───────────────────────────

/**
 * dsh 自带的匿名公共 HTTP(S) 抓取后端。
 *
 * 直接实例化 `HttpFetchProvider`（**不注册**）有两个好处：
 * - 回落路径与装本插件之前**完全同源**，安全约束一字不差；
 * - 不额外占用 `ctx.web` 的 provider id，避免与真正的 `web-fetch-http` 行撞车。
 */
let localProviderPromise;
function loadLocalProvider(timeoutMs) {
  localProviderPromise ??= (async () => {
    const mod = await loadHostModule("@deepseek-ai/dsh-web-fetch-http");
    if (typeof mod?.HttpFetchProvider !== "function") return undefined;
    return mod.HttpFetchProvider;
  })();
  return localProviderPromise.then((Ctor) => {
    if (Ctor === undefined) return undefined;
    // 每次拿新实例：timeoutMs 来自配置，而实例把 limits 快照在字段上。
    return new Ctor({
      maxResponseBytes: 5e6,
      maxBodyChars: 1e5,
      timeoutMs,
      maxRedirects: 5,
      userAgent: `deepseek-harness/workbuddy-fetch (+https://github.com/deepseek-ai)`,
    });
  });
}

// ─────────────────────────── WorkBuddy 凭据桥 ───────────────────────────

/**
 * 与 `dsh-workbuddy-websearch` 的对接点。
 *
 * 该插件把「平台定位 + 凭据解密 + 区域绑定 + 令牌续期 + connect 增强」全部
 * 做完了，并通过 `__internals` 暴露了入口。本插件**复用**它而不是重写一遍：
 * - 两边的「哪一版账号」判定因此**必然一致** —— 搜索扣 A 版、抓取却扣 B 版
 *   会是账务事故，不是容错；
 * - 用户只需要登录一次 WorkBuddy。
 *
 * 两条路，优先级从高到低：
 *   1. `__internals`（**首选**）—— 它带区域绑定、令牌续期，以及 connect 增强。
 *      注意该导出在作者文档里标注为「仅供单测；宿主不会调用」，因此本插件是它
 *      的**外部消费者**：作者若改动这里，本插件会静默降级到第 2 条。
 *   2. 该包的**正式子路径导出** `dsh-workbuddy-websearch/platform` 与
 *      `.../credentials`（写在它 package.json 的 `exports` 里，是稳定契约）。
 *      用这两个拼一个最小桥：区域选择 + 凭据读取，不含内存续期 —— 令牌真过期时
 *      本插件会回落到本地抓取，而不是硬失败。
 */
let bridgePromise;
async function loadCredentialBridge() {
  bridgePromise ??= (async () => {
    const mod = await loadHostModule("dsh-workbuddy-websearch");
    const internals = mod?.__internals;
    if (internals !== undefined
      && typeof internals.resolveCredential === "function"
      && typeof internals.chatBase === "function") {
      return { kind: "internals", ...internals };
    }
    return await buildFallbackBridge();
  })();
  return bridgePromise;
}

/**
 * 用正式子路径导出拼最小桥（`__internals` 不再可用时的降级路径）。
 * 不做令牌续期：读到的凭据若已过期，`resolveCredential` 返回它并在请求时得到 401，
 * 上层据此回落到本地抓取。
 */
async function buildFallbackBridge() {
  const platform = await loadHostModule("dsh-workbuddy-websearch/platform");
  const credentials = await loadHostModule("dsh-workbuddy-websearch/credentials");
  if (platform === undefined || credentials === undefined) return undefined;
  const { VARIANTS, variantForRegion } = platform;
  const { resolveCredentialForVariant } = credentials;
  if (!Array.isArray(VARIANTS) || typeof resolveCredentialForVariant !== "function") return undefined;

  const REGION_ENV = "WORKBUDDY_SEARCH_REGION";
  const AUTO_ORDER = ["global", "cn"];

  const regionSetting = () => {
    const raw = String(runtimeConfig?.region ?? process.env[REGION_ENV] ?? "auto").trim().toLowerCase();
    if (raw === "cn" || raw === "china") return "cn";
    if (raw === "global" || raw === "ai" || raw === "intl" || raw === "international") return "global";
    return "auto";
  };

  const variantCredentialState = (variant) => {
    try {
      const paths = credentials.credentialPathsForVariant(variant, { env: process.env, dshHome: syncDshHome() });
      let sawEncrypted = false;
      for (const path of paths) {
        const parsed = credentials.parseAuthFileSync(path);
        if (parsed === undefined) continue;
        if (parsed.accessToken !== "") return "plain";
        if (parsed.encryptedWrapper === true) sawEncrypted = true;
      }
      return sawEncrypted ? "encrypted" : "absent";
    } catch {
      return "absent";
    }
  };

  const selectVariant = () => {
    const setting = regionSetting();
    if (setting !== "auto") return variantForRegion(setting);
    for (const region of AUTO_ORDER) {
      const variant = variantForRegion(region);
      if (variantCredentialState(variant) !== "absent") return variant;
    }
    return undefined;
  };

  const chatBase = (credential) => {
    if (credential?.variant?.region === "global") return "https://www.workbuddy.ai";
    const domain = String(credential?.domain ?? "").trim().toLowerCase();
    return domain === "workbuddy.ai" || domain.endsWith(".workbuddy.ai")
      ? "https://www.workbuddy.ai"
      : "https://copilot.tencent.com";
  };

  return {
    kind: "subpath",
    chatBase,
    selectVariant,
    variantCredentialState,
    async resolveCredential(_forceRefresh, signal) {
      const variant = selectVariant();
      if (variant === undefined) {
        throw await webError("没有找到可用的 WorkBuddy 凭据（请在 WorkBuddy 桌面端登录）", "WB_FETCH_CREDENTIAL_MISSING");
      }
      const credential = await resolveCredentialForVariant({ variant, dshHome: syncDshHome(), signal });
      if (credential === undefined || credential.accessToken === "") {
        throw await webError("没有找到可用的 WorkBuddy 凭据（请在 WorkBuddy 桌面端登录）", "WB_FETCH_CREDENTIAL_MISSING");
      }
      return credential;
    },
  };
}

/** dsh 数据目录（同步解析；不 import 宿主包）。 */
function syncDshHome() {
  const env = process.env.DSH_HOME;
  return env !== undefined && env.trim() !== "" ? env.trim() : join(homedir(), ".dsh");
}

/** 同步的可用性探测（不联网）：只问「本机有没有被绑定的那一版登录态」。 */
function probeCredentialSync(internals) {
  try {
    if (typeof internals?.selectVariant !== "function") return undefined;
    const variant = internals.selectVariant();
    if (variant === undefined || variant === null) return false;
    const state = internals.variantCredentialState(variant);
    return state !== "absent";
  } catch {
    return undefined;
  }
}

/** 网关地址：按凭据所在区域选（国内 copilot.tencent.com / 国际 www.workbuddy.ai）。 */
function gatewayBase(internals, credential, override) {
  if (override !== undefined) return override;
  try {
    return String(internals.chatBase(credential)).replace(/\/+$/u, "");
  } catch {
    return "https://copilot.tencent.com";
  }
}

// ─────────────────────────── 云端抓取 ───────────────────────────

/** 上游返回的错误码（数字）。语义见模块头部「端点取证」。 */
const CODE_SSRF_REJECTED = 15018;
const CODE_ROUTING_REJECTED = 15021;
const CODE_BAD_REQUEST = 15013;

/** 把上游错误翻译成 dsh 的错误码 + 一句话说明。 */
async function translateUpstreamError(code, message, status) {
  const detail = `${message}${code === undefined ? "" : ` (code: ${code})`}`;
  if (status === 401 || status === 403 && /401|authorization/i.test(message)) {
    return await webError(`WorkBuddy webfetch rejected the credential: ${detail}`, "WB_FETCH_SESSION_DEAD");
  }
  switch (code) {
    case CODE_SSRF_REJECTED:
      return await webError(`WorkBuddy webfetch blocked this URL: ${detail}`, "WEB_BLOCKED_URL");
    case CODE_ROUTING_REJECTED:
      return await webError(`WorkBuddy webfetch does not route this domain: ${detail}`, "WB_FETCH_DOMAIN_REJECTED");
    case CODE_BAD_REQUEST:
      return await webError(`WorkBuddy webfetch rejected the request: ${detail}`, "WEB_INVALID_URL");
    default:
      return await webError(`WorkBuddy webfetch failed: ${detail}`, "WEB_PROVIDER_ERROR");
  }
}

/**
 * 判定「这次失败该不该回落本地抓取」。
 *
 * 原则：**安全裁决不回落，路径不通才回落**。
 * - `decisive === true`（上游明确标记）→ 不回落；
 * - `WEB_BLOCKED_URL`（SSRF / 内网地址 / 端口不允许）→ **不回落**。
 *   回落等于拿本机网络再试一次「上游刚说危险的地址」，那就绕过了裁决。
 * - `WEB_INVALID_URL`、调用方 abort → 不回落。
 * - 凭据失效 → 先续期重试，仍失败再回落（用户可能只是没登录，本地抓取照样有用）。
 * - 其余（路由策略、网络、上游 5xx、正文为空）→ 回落，因为这些是「这一条路
 *   走不通」，不是「这个 URL 危险」。
 */
function shouldFallback(error) {
  if (error?.decisive === true) return false;
  const code = error?.code;
  if (code === "WEB_ABORTED") return false;
  if (code === "WEB_INVALID_URL") return false;
  if (code === "WEB_BLOCKED_URL") return false;
  return true;
}

/**
 * 发一次云端抓取。返回归一化后的 `{ url, statusCode, title, content, contentType, truncated }`。
 * 失败抛带 code 的错误；`error.decisive` 标记「安全裁决、不许回落」。
 */
async function callWebFetch(internals, credential, url, settings, signal) {
  const endpoint = `${gatewayBase(internals, credential, settings.endpoint)}${FETCH_PATH}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("WorkBuddy webfetch timed out")), settings.timeoutMs);
  const onAbort = () => controller.abort(signal?.reason);
  if (signal !== undefined) {
    if (signal.aborted === true) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const cleanup = () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  };

  let response;
  let rawText;
  try {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${credential.accessToken}`,
      "User-Agent": USER_AGENT,
    };
    if (typeof credential.enterpriseId === "string" && credential.enterpriseId.trim() !== "") {
      headers["X-Enterprise-Id"] = credential.enterpriseId.trim();
    }
    response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        url,
        format: "markdown",
        timeout: Math.max(1, Math.floor(settings.timeoutMs / 1_000)),
        max_length: settings.maxLength === 0 ? 1_000_000 : settings.maxLength,
      }),
      signal: controller.signal,
    });
    rawText = await response.text();
  } catch (error) {
    cleanup();
    if (signal?.aborted === true) throw await webError("WorkBuddy webfetch aborted", "WEB_ABORTED", signal.reason);
    throw await webError(`WorkBuddy webfetch transport failed: ${String(error)}`, "WB_FETCH_TRANSPORT_ERROR", error);
  } finally {
    cleanup();
  }

  let payload;
  try {
    payload = rawText === "" ? undefined : JSON.parse(rawText);
  } catch {
    payload = undefined;
  }

  if (!response.ok) {
    // 401 时网关回的是 HTML 页面，不是 JSON —— 先归因鉴权，再谈别的。
    if (response.status === 401) {
      throw await webError("WorkBuddy webfetch rejected the credential (HTTP 401)", "WB_FETCH_SESSION_DEAD");
    }
    if (payload !== undefined && payload.code !== undefined) {
      const error = await translateUpstreamError(payload.code, String(payload.msg ?? ""), response.status);
      if (payload.decisive === true) error.decisive = true;
      throw error;
    }
    throw await webError(
      `WorkBuddy webfetch failed: HTTP ${response.status} ${response.statusText}${rawText === "" ? "" : `: ${rawText.slice(0, 200)}`}`,
      "WB_FETCH_UPSTREAM_ERROR",
    );
  }

  if (payload === undefined) {
    throw await webError("WorkBuddy webfetch returned a non-JSON body", "WB_FETCH_UPSTREAM_ERROR");
  }
  // 200 也可能带业务错误（桌面端 CLI 就是这么判断的）。
  if (payload.code !== undefined) {
    const error = await translateUpstreamError(payload.code, String(payload.msg ?? ""), response.status);
    if (payload.decisive === true) error.decisive = true;
    throw error;
  }

  const content = typeof payload.content === "string" ? payload.content : "";
  if (content.trim() === "") {
    // 非文本资源（PDF/图片）与「正文抽不出来」都会落到这里 —— 交给回落路径给出
    // dsh 自己那套可操作的错误（WEB_UNSUPPORTED_CONTENT_TYPE 等）。
    throw await webError(
      `WorkBuddy webfetch returned no readable text for ${url}`,
      "WB_FETCH_EMPTY_RESULT",
    );
  }
  const statusCode = Number.isInteger(payload.status_code) ? payload.status_code : 200;
  const contentType = typeof payload.content_type === "string" ? payload.content_type : "text/markdown";
  const capped = settings.maxLength > 0 ? content.slice(0, settings.maxLength) : content;
  return {
    url: typeof payload.url === "string" && payload.url !== "" ? payload.url : url,
    statusCode,
    title: typeof payload.title === "string" ? payload.title : "",
    content: capped,
    contentType,
    truncated: payload.truncated === true || capped.length !== content.length,
  };
}

// ─────────────────────────── provider ───────────────────────────

/**
 * WorkBuddy 抓取 provider。
 *
 * `id` 固定为 `workbuddy-fetch`，由 profile 的 `web` 行 `fetchProvider` 选中。
 * 与搜索侧不同，这里**默认允许回落**：见模块头部的实测结论 —— 该网关对
 * 相当一部分站点直接拒绝，硬失败会让 `web_fetch` 比装插件之前更难用。
 */
class WorkBuddyFetchProvider {
  id = PROVIDER_ID;

  #lastProbeAt = 0;
  #lastProbeValue = true;

  /**
   * 可用性检查：便宜、本地、不联网。
   *
   * 开着回落时**恒为 true** —— 回落后端本机必有（随 dsh 发布），所以
   * 「这个 provider 能不能跑」的答案确实是能。关掉回落时才看登录态，
   * 让宿主给出 `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`。
   */
  available() {
    if (readSettings().fallback) return true;
    const now = Date.now();
    if (now - this.#lastProbeAt < 3_000) return this.#lastProbeValue;
    this.#lastProbeAt = now;
    this.#lastProbeValue = true; // 异步探测在 fetch() 里给出可操作错误；这里不阻塞。
    return true;
  }

  async fetch(request, signal) {
    const settings = readSettings();
    const url = typeof request?.url === "string" ? request.url.trim() : "";
    if (url === "") throw await webError("web fetch requires a non-empty url", "WEB_INVALID_URL");
    if (signal?.aborted === true) throw await webError("web fetch aborted", "WEB_ABORTED", signal.reason);

    /**
     * 云端这条路走不通时改用本地抓取。
     *
     * ⚠️ 两边都失败时**必须把云端的原因带出来**。很多环境（研发网、隔离网）
     * 本地直连本来就不通，此时本地抓取抛的是 `TypeError: fetch failed` ——
     * 单看这句话，用户会以为是插件坏了，而真正的原因（比如「WorkBuddy 网关
     * 不路由这个域名」）被吃掉了。所以这里把两条原因合并上报。
     */
    const fallback = async (reason) => {
      if (!settings.fallback) throw reason;
      const provider = await loadLocalProvider(settings.fallbackTimeoutMs);
      if (provider === undefined) throw reason;
      logOnce(`[dsh-workbuddy-fetch] falling back to local fetch (${reason?.code ?? "unknown"}): ${url}`);
      try {
        return await provider.fetch({ url }, signal);
      } catch (localError) {
        if (signal?.aborted === true) throw await webError("web fetch aborted", "WEB_ABORTED", signal.reason);
        const primary = `${reason?.code ?? "unknown"}: ${reason?.message ?? String(reason)}`;
        const local = `${localError?.code ?? "unknown"}: ${localError?.message ?? String(localError)}`;
        throw await webError(
          `web_fetch 的两条路径都失败了。\n`
            + `  · WorkBuddy 网关：${primary}\n`
            + `  · 本地抓取：${local}\n`
            + `  若本机本来就不能直连外网，这是预期结果；可设 WORKBUDDY_FETCH_FALLBACK=0 让错误只报告网关那一条。`,
          // 保留云端错误码：它比本地那条更有信息量（例如 WB_FETCH_DOMAIN_REJECTED）。
          reason?.code ?? localError?.code ?? "WEB_PROVIDER_ERROR",
          localError,
        );
      }
    };

    const internals = await loadCredentialBridge();
    if (internals === undefined) {
      return fallback(await webError(
        "dsh-workbuddy-fetch 需要 dsh-workbuddy-websearch 来提供 WorkBuddy 登录态，但没能加载它；已改用本地抓取。",
        "WB_FETCH_BRIDGE_MISSING",
      ));
    }

    let credential;
    try {
      credential = await internals.resolveCredential(false, signal);
    } catch (error) {
      return fallback(await webError(
        `无法取得 WorkBuddy 凭据：${error?.message ?? String(error)}`,
        error?.code ?? "WB_FETCH_CREDENTIAL_MISSING",
        error,
      ));
    }

    let result;
    try {
      result = await callWebFetch(internals, credential, url, settings, signal);
    } catch (error) {
      if (signal?.aborted === true) throw await webError("web fetch aborted", "WEB_ABORTED", signal.reason);
      if (error?.code === "WB_FETCH_SESSION_DEAD") {
        // 会话可能只是过期：强制续期一次再重试（与搜索侧同样的补救顺序）。
        let refreshed;
        try {
          refreshed = await internals.resolveCredential(true, signal);
        } catch {}
        if (refreshed !== undefined) {
          try {
            result = await callWebFetch(internals, refreshed, url, settings, signal);
          } catch (retryError) {
            if (!shouldFallback(retryError)) throw retryError;
            return fallback(retryError);
          }
        } else if (!shouldFallback(error)) {
          throw error;
        } else {
          return fallback(error);
        }
      } else if (!shouldFallback(error)) {
        throw error;
      } else {
        return fallback(error);
      }
    }

    return {
      url: result.url,
      statusCode: result.statusCode,
      // 云端已把正文抽成 markdown，按 `text` 交给 dsh-tool-web 原样渲染；
      // 若上游明确回了 HTML（format 被拒时不会发生，防御性处理），交回去让它转。
      body: result.contentType.includes("html")
        ? { kind: "html", content: result.content }
        : { kind: "text", content: result.content },
      truncated: result.truncated,
    };
  }
}

// ─────────────────────────── 日志去抖 ───────────────────────────

const loggedKeys = new Set();
function logOnce(line) {
  if (loggedKeys.has(line)) return;
  loggedKeys.add(line);
  try {
    console.log(line);
  } catch {}
}

// ─────────────────────────── 插件入口 ───────────────────────────

/** 注册 fetch provider；随宿主 fiber 自动清理。 */
export function apply(ctx, config) {
  runtimeConfig = typeof config === "object" && config !== null ? config : {};

  // 记下这一行的上下文根（loader 会把它设成配置文件所在目录，也就是 profile 目录）。
  // 这是本插件解析宿主包时**唯一不依赖环境变量**的可靠锚点 —— 宿主进程不保证
  // 有 `DSH_PROFILE_DIR`，而 `link:` 装法又让「从自身真实路径向上找」失效。
  try {
    if (ctx?.baseUrl !== undefined) contextBaseUrl = new URL(ctx.baseUrl);
  } catch {}

  // ⚠️ 同一个 provider id 只能由一个插件注册（`ctx.web` 按 id 去重，后注册者抛
  // `WEB_DUPLICATE_PROVIDER`）。这里把裸错误翻译成可操作指引 —— 否则用户只看到
  // 一行 `1 entry did not activate`，不知道该卸谁。
  try {
    ctx.web.registerFetchProvider(new WorkBuddyFetchProvider());
  } catch (error) {
    if (error?.code === "WEB_DUPLICATE_PROVIDER") {
      const translated = new Error(
        `[dsh-workbuddy-fetch] 无法注册 fetch provider "${PROVIDER_ID}"：该 id 已被另一个插件占用。\n`
          + `  ctx.web 按 provider id 去重，同一个 id 只能有一个插件注册，**只能留一个**。\n`
          + `  常见于：本插件的旧版本仍在装，或任何自行注册 "${PROVIDER_ID}" 的插件。\n`
          + `  排查：打开该 profile 的 package.json，看 dependencies 与 dsh.profile.bundles，卸掉重复的那个。\n`
          + `  原始错误：${error.message}`,
        { cause: error },
      );
      translated.code = error.code;
      throw translated;
    }
    throw error;
  }

  const settings = readSettings();

  // ── 搜索侧：**委托**上游插件注册，不复制它的实现 ───────────────────────────
  //
  // 本插件要能**单独安装就同时提供 search + fetch**，所以搜索也得有人注册。
  // 但搜索的实现（SSE 解析、综述清理、来源提取、双版本凭据、令牌续期）都在
  // `dsh-workbuddy-websearch` 里，抄一份意味着两条维护线立刻分叉。
  // 这里改为**调用它自己导出的 `apply()`** —— 它做的事就是往 `ctx.web` 注册
  // `workbuddy-agentic`，用我们传进去的 ctx，效果与它自己被挂载时一模一样。
  //
  // 两件必须处理的事：
  //  1) **幂等**：上游若也被挂载（两个都装），它会先注册成功，我们再调就撞
  //     `WEB_DUPLICATE_PROVIDER`。这不是错误，正确反应是**静默跳过** ——
  //     注册表里已经有一个能用的了，用户不该因为这个看到激活失败。
  //  2) **失败不致命**：委托失败（上游没装、导出变了）不该拖垮抓取能力。
  //     抓取是本插件的主业，搜索是增益 —— 前者必须照常工作。
  const searchStatus = registerSearchByDelegation(ctx);
  const healStatus = enforceFetchProviderSelection(ctx);

  const line = `[dsh-workbuddy-fetch] registered "${PROVIDER_ID}" into ctx.web`
    + ` (WorkBuddy agenttool webfetch; fallback=${settings.fallback ? "local" : "off"},`
    + ` timeout=${settings.timeoutMs}ms)`
    + `; search=${searchStatus}`
    + `; fetchSelection=${healStatus}`;
  try {
    ctx.root?.logger?.("workbuddy-fetch").info?.(line);
  } catch {}
  console.log(line);

  // 委托没成功时，`web` 行的 `searchProvider` 可能悬空（本插件 patch 复述了它）。
  // 那会让 `web_search` 整体报 `WEB_PROVIDER_CONFIGURED_MISSING`，必须主动说清楚，
  // 否则用户只会看到「搜索莫名其妙坏了」。
  //
  // 注意 `upstream-mounted` 是**正常且最常见**的情形（两个都装）：上游行在、
  // 由它自己注册，我们不查注册表也不报警 —— 并发激活下这一刻可能还没注册上。
  if (searchStatus !== "delegated"
    && searchStatus !== "already-registered"
    && searchStatus !== "upstream-mounted") {
    warnIfSearchProviderDangling(ctx);
  }
}

/**
 * 把 `web` 行的 `fetchProvider` 顶回本插件 ——**免疫 patch 层叠顺序**。
 *
 * 为什么需要这一步：`web` 行的 patch 是「按 id 整行替换 config」，谁后装谁生效。
 * 其它插件（`dsh-codex-subscription`、上游 `dsh-workbuddy-websearch` 等）的 patch 会把
 * `fetchProvider` 写成它们自己的 id，于是「本插件先装、它们后装」时，本插件的抓取
 * provider 明明注册好了却永远不会被选中，而且**不报任何错**。这是最难发现的一类故障。
 *
 * ── 为什么不能写 `web.fetchProviderId` ──
 *
 * 早先版本假设 `WebRuntime` 有个可写的 `fetchProviderId` 实例字段，赋值即可纠正。
 * 那是错的：`@deepseek-ai/dsh-web` 的 `WebRuntime` 只有 `searchProviders` /
 * `fetchProviders` 两个 Map 和 `fetchProviderEnv`，**没有 `fetchProviderId`**。
 * 给不存在的属性赋值不会抛错，也不会生效 —— 于是这个「修复」一直是个空操作。
 *
 * 更麻烦的是它还有反向副作用：`dsh-codex-subscription` 的
 * `configuredFetchProviderId()` 第一行就是 `if ("fetchProviderId" in web) return web.fetchProviderId`。
 * 我们那一次赋值凭空创建了这个字段，于是 codex 把它当成了「用户配置」读走，
 * 反而让 codex 的路由永久认定配置是 `workbuddy-fetch`。空操作 + 污染别人，两头都不对。
 *
 * ── 正确写法 ──
 *
 * 真正的选择逻辑在 `WebRuntime.selectFetchProvider()`：
 *
 * ```js
 * const configuredId = this.config.fetchProvider.get() ?? this.fetchProviderEnv;
 * ```
 *
 * 即每次调用都实时读 `ctx.web.config.fetchProvider`（cordis 的响应式配置对象）。
 * 所以要纠正的就是它。只有在「已配置的 id 不是我们自己、且我们的 provider 确实注册
 * 成功」时才动手 —— 用户若刻意配了别的 fetch provider，本插件不该抢。
 *
 * @returns {"already-selected"|"healed"|"skipped"|"no-config"} 结果分类，用于日志。
 */
function enforceFetchProviderSelection(ctx) {
  try {
    const web = ctx?.web;
    if (web === undefined || web === null) return "skipped";
    // 我们的 provider 真的注册上了吗？（撞 id 失败时这里可能没有）
    const registry = web.fetchProviders;
    if (registry instanceof Map && !registry.has(PROVIDER_ID)) return "skipped";

    // 读当前配置：`WebRuntime.selectFetchProvider()` 用的就是这个表达式。
    const field = web.config?.fetchProvider;
    const readCurrent = () => {
      if (typeof field?.get === "function") return field.get();
      return undefined;
    };
    const previous = readCurrent();
    if (previous === PROVIDER_ID) return "already-selected";

    // 写回。cordis 的响应式配置对象提供 `set()`；没有就只能放弃并留下诊断，
    // 不冒险直接改内部状态（那正是上一版犯的错）。
    if (typeof field?.set !== "function") {
      try {
        console.warn(
          `[dsh-workbuddy-fetch] 无法纠正 web 行的 fetchProvider（当前是 "${previous ?? "(未配置)"}"）：`
            + `该配置对象没有 set()。本插件的抓取 provider 已注册但不会被选中，`
            + `请手动把 profile 里 web 行的 fetchProvider 改为 "${PROVIDER_ID}"。`,
        );
      } catch {}
      return "no-config";
    }
    field.set(PROVIDER_ID);
    try {
      console.warn(
        `[dsh-workbuddy-fetch] web 行的 fetchProvider 原本是 "${previous ?? "(未配置)"}"，`
          + `已纠正为 "${PROVIDER_ID}"。\n`
          + `  这通常意味着有别的插件（如 dsh-codex-subscription）在本插件之后安装，`
          + `它的 patch 把 fetchProvider 写成了自己的 id。本插件已自行修正，无需手动处理。`,
      );
    } catch {}
    return "healed";
  } catch {
    return "skipped";
  }
}

/**
 * 通过调用上游插件的 `apply()` 来注册搜索 provider（幂等、失败不致命）。
 *
 * ⚠️ **只在「上游没被挂载」时才委托。** 这是修掉一个真实回归后的规则：cordis 的
 * 插件激活是**并发**的，不是按 bundles 顺序串行。上游插件行（本机在 bundles 第 15 位）
 * 和我们（第 19 位）几乎同时 activate —— 我们执行到这里时，上游可能还没往
 * `ctx.web` 注册，于是「查注册表」看到的是空的，误判为没人管，就去调它的 `apply()`；
 * 随后上游自己也 activate 并注册，两个撞 `WEB_DUPLICATE_PROVIDER`，
 * 用户每次启动都会看到一条吓人的激活失败警告。
 *
 * 正确判据不是「注册表里有没有」，而是「loader 里有没有这个插件行」：
 * 有 → 它自己会注册，我们不插手；没有 → 才由我们代劳。
 *
 * @param {object} ctx - 本插件的上下文；原样交给上游，使它在同一个 `ctx.web` 上注册。
 * @returns {"delegated"|"already-registered"|"upstream-mounted"|"upstream-missing"|"failed"}
 *   结果分类，用于日志与自检。
 */
function registerSearchByDelegation(ctx) {
  // 1) 上游插件行已挂载 → 由它自己注册，本插件完全不碰搜索。
  //    这条必须放最前面：并发激活下「查注册表」不可靠，查 loader 才可靠。
  if (isUpstreamEntryMounted(ctx)) return "upstream-mounted";

  // 2) 注册表里已经有该 id（别人抢先注册，或上游已 activate 完）→ 认领，不重复。
  const configured = ctx?.web?.searchProviderId;
  const registry = ctx?.web?.searchProviders;
  if (typeof configured === "string" && configured !== "" && registry instanceof Map && registry.has(configured)) {
    return "already-registered";
  }

  let upstream;
  try {
    upstream = requireUpstreamSync();
  } catch {
    upstream = undefined;
  }
  if (upstream === undefined || typeof upstream.apply !== "function") return "upstream-missing";

  try {
    upstream.apply(ctx, {}); // 上游的 apply 只接受 ctx；它的配置走它自己的行
    return "delegated";
  } catch (error) {
    // 撞 id = 别人已经注册好了，等于成功。
    if (error?.code === "WEB_DUPLICATE_PROVIDER") return "already-registered";
    try {
      console.warn(
        `[dsh-workbuddy-fetch] 委托注册搜索 provider 失败（抓取不受影响）：${error?.message ?? String(error)}`,
      );
    } catch {}
    return "failed";
  }
}

/**
 * **同步**加载上游插件模块。
 *
 * 为什么必须同步：cordis 的 `apply()` 是同步函数，而这里要在其中完成搜索注册。
 * `createRequire` 能同步拿到 ESM 模块的命名空间（Node 22 起支持 require(esm)），
 * 因而不必把 `apply` 改成异步 —— 改成异步会让插件的激活时序变含糊，不值得。
 */
function requireUpstreamSync() {
  for (const anchor of anchorCandidates()) {
    try {
      const loaded = nodeRequire(anchor)(UPSTREAM_PACKAGE);
      if (loaded !== undefined && typeof loaded.apply === "function") return loaded;
    } catch {}
  }
  return undefined;
}

/**
 * 上游插件行是否已挂在当前 loader 上。
 *
 * 用 loader 的 entry 列表判断，而不是看 provider 注册表 —— 原因见
 * {@link registerSearchByDelegation} 的说明：并发激活下注册表可能还没填，
 * 但 entry 在 activate 之前就已存在。
 *
 * 拿不到 `ctx.loader`（理论上不该发生）时返回 **true**：宁可假设上游在、
 * 由它自己注册，也不要冒险重复注册制造一条启动期错误。
 *
 * @param {object} ctx - 本插件的上下文。
 * @returns {boolean} 上游行是否已挂载。
 */
function isUpstreamEntryMounted(ctx) {
  try {
    const loader = ctx?.loader;
    if (typeof loader?.entries !== "function") return true;
    for (const entry of loader.entries()) {
      const entryName = entry?.options?.name;
      if (typeof entryName !== "string") continue;
      // 包名精确匹配，或它的子路径（如 `dsh-workbuddy-websearch/platform`）。
      if (entryName === UPSTREAM_PACKAGE || entryName.startsWith(`${UPSTREAM_PACKAGE}/`)) return true;
    }
    return false;
  } catch {
    return true;
  }
}

/**
 * 检查 `web` 行声明的 `searchProvider` 是否真的有人注册。
 *
 * **只读注册表，不发请求。** `ctx.web`（`WebRuntime`）把两个 provider 表作为实例
 * 字段持有（`searchProviders` / `fetchProviders`）并记录 `searchProviderId`，
 * 直接查这两个字段既准确又零成本。
 *
 * 刻意**不**用「调一次 `search()` 看它报什么错」来探测：provider 正常时那次调用
 * 会真的打到上游，空查询也可能计费 —— 一个启动期自检不该花用户的钱。
 * 字段在未来的 dsh 版本里若改名/消失，这里静默跳过（`try` 包住，取不到就不查），
 * 自检失败绝不影响插件本身。
 */
function warnIfSearchProviderDangling(ctx) {
  try {
    const runtime = ctx?.web;
    const configured = runtime?.searchProviderId;
    const registry = runtime?.searchProviders;
    if (typeof configured !== "string" || configured === "") return;
    if (!(registry instanceof Map)) return;
    if (registry.has(configured)) return;
    console.warn(
      `[dsh-workbuddy-fetch] 注意：web 行的 searchProvider 指向 "${configured}"，`
        + `但当前没有插件注册该 provider —— web_search 会因此报 WEB_PROVIDER_CONFIGURED_MISSING。\n`
        + `  原因通常是上游包 dsh-workbuddy-websearch 没装上（本插件委托它注册搜索 provider）。\n`
        + `  解决办法（二选一）：\n`
        + `    1) 装上上游：dsh plugin --profile <你的 profile> add dsh-workbuddy-websearch\n`
        + `    2) 或者把 web 行的 searchProvider 改回 deepseek-official`,
    );
  } catch {}
}

// ─────────────────────────── 测试钩子（不进入运行时路径） ───────────────────────────

/** 仅供单测/探针脚本使用；宿主不会调用。 */
export const __internals = {
  PROVIDER_ID,
  FETCH_PATH,
  readSettings,
  loadHostModule,
  loadCredentialBridge,
  loadLocalProvider,
  callWebFetch,
  shouldFallback,
  translateUpstreamError,
  WorkBuddyFetchProvider,
  isUpstreamEntryMounted,
  registerSearchByDelegation,
  enforceFetchProviderSelection,
};
