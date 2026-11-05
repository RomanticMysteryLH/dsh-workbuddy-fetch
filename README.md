# dsh-workbuddy-fetch

把 DeepSeek Harness 的 **`web_fetch`（抓取）** 接到 [WorkBuddy](https://www.workbuddy.cn) 的网页抓取网关，
并**一并提供 `web_search`** —— 两个工具都用你已经登录的 WorkBuddy 账号，不需要任何 API Key。

背景：[`dsh-workbuddy-websearch`](https://github.com/arnen7000/DSH-Workbuddy-WebSearch) 接管了 `web_search`，
但明确把 `web_fetch` 留给了 dsh 内置的 `web-fetch-http`（直连目标站点）。
本插件补上抓取这一半；同时为了**装一个包就两个工具都能用**，它会在启动时**委托**上游插件
注册搜索 provider（调它自己的 `apply()`，不复制实现）。

| 工具 | 谁实现 | 装本插件后 |
|---|---|---|
| `web_search` | 上游 `dsh-workbuddy-websearch` 的实现 | ✅ 可用（本插件委托注册） |
| `web_fetch` | 本插件自己的 provider | ✅ 可用（云网关 + 本地回落） |

> 💡 **只装本插件就够了**：上游作为 `peerDependency` 会被一起装上。
> 若你**也**单独装了上游插件，两个不会打架 —— 本插件发现搜索已注册就静默跳过。

## 目录

- [它做什么](#它做什么)
- [安装](#安装)
- [配置](#配置)
- [行为细节](#行为细节)
- [和搜索插件一起装会冲突吗](#和搜索插件一起装会冲突吗)
- [已知边界](#已知边界)
- [安全](#安全)
- [卸载](#卸载)
- [致谢与来源](#致谢与来源)
- [许可证](#许可证)

## 它做什么

装上之后，模型调用 `web_fetch` 的路径变成：

```
web_fetch
  └─ ctx.web.fetch()
       └─ workbuddy-fetch provider
            ├─ ① POST {WorkBuddy 网关}/agenttool/v1/webfetch   ← 用你的登录态
            │     成功 → 返回云端抽取好的 markdown 正文
            └─ ② 网关拒绝 / 不可用 → 回落 @deepseek-ai/dsh-web-fetch-http
                  （就是装本插件之前 web_fetch 用的那个后端）
```

**为什么要第 ② 步。** 实测（2026-11，国内版账号）该网关**不是全站可用**：

| 站点 | 网关结果 |
|---|---|
| `github.com` / `zhihu.com` / `csdn.net` / `juejin.cn` / `docs.python.org` / `gov.cn` / `baidu.com` | ✅ 正常 |
| `en.wikipedia.org` / `medium.com` / `bbc.com` / `news.ycombinator.com` | ❌ `15021 domain rejected by via routing policy` |

如果严格只用网关，这些站点会从「能抓」变成「抓不了」—— 插件反而让能力倒退。
所以默认开启回落：**能走网关的走网关，走不通的走原来的路**，`web_fetch` 的能力只增不减。

> 💡 反过来也成立：在**本机不能直连外网**的环境（研发网 / 隔离网）里，
> dsh 原来的 `web_fetch` 一直是 `TypeError: fetch failed`；装本插件后，
> 那些网关支持的站点**第一次变得可抓**。

### `web_search` 是怎么来的

本插件**不复制**上游的搜索实现。启动时它调用上游包导出的 `apply(ctx)`，
让上游自己把 `workbuddy-agentic` 注册进同一个 `ctx.web` —— 效果与上游被单独挂载完全相同。
这样做的好处是：SSE 解析、综述清理、来源提取、双版本凭据、令牌续期**只有一条维护线**，
上游修 bug 你自动受益。

## 安装

前置只有一条：**本机已安装并登录 WorkBuddy 桌面端**（国内版或国际版任一）。

上游 [`dsh-workbuddy-websearch`](https://github.com/arnen7000/DSH-Workbuddy-WebSearch)
是 **`peerDependency`**。注意它**不会**被自动装上（dsh 的 profile 关掉了
`autoInstallPeers`），所以：

```bash
# ① 装上游（提供凭据能力 + 搜索实现）
dsh plugin --profile <你的 profile> add dsh-workbuddy-websearch

# ② 装本插件
dsh plugin --profile <你的 profile> add <本插件目录的绝对路径>
```

⚠️ **顺序最好别反。** 若先装本插件，上游会以「未声明 dsh.bundle 的普通依赖」
身份被 pnpm 链进来，而**不会**进入 profile 的 `bundles` 列表。本插件仍能正常
委托它注册搜索（它是个普通包，能 import 到就行），但上游自己的
`web-workbuddy-websearch` 那一行不会挂载 —— 少一层显式来源，排查时更难看清。
先装上游、再装本插件，两层 bundles 都在，`--dump-config` 里一目了然。

重启 dsh 后生效。核验（应同时看到两个 provider）：

```bash
dsh --profile <你的 profile> --dump-config | grep -A4 "id: web"
# searchProvider: workbuddy-agentic
# fetchProvider: workbuddy-fetch
```

> ⚠️ **同一个 provider id 只能由一个插件注册。** 若你还装着注册了
> `workbuddy-fetch` 或 `workbuddy-agentic` 的其他插件（旧版、fork），
> `ctx.web` 会按 id 去重。本插件对这两种撞车都做了处理：
> 搜索撞车时**静默认领**（别人已经注册好了，等于成功），
> 抓取撞车时才报错并给出排查步骤。

## 配置

全部可写在 profile 的 `cordis.patch.yml` 里（`config` 优先），或用环境变量。
**都有默认值，不设也能用。**

```yaml
- id: web-workbuddy-fetch
  name: dsh-workbuddy-fetch
  config:
    fallback: true          # 网关走不通时回落本地抓取
    timeoutMs: 20000        # 云端抓取预算
    fallbackTimeoutMs: 15000 # 回落后的本地抓取预算
    maxLength: 100000       # 回传正文字符上限；0 = 不截断
    # endpoint: https://copilot.tencent.com   # 覆盖网关地址（默认按凭据区域自动选）
```

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `WORKBUDDY_FETCH_FALLBACK` | `true` | 是否回落本地抓取。设 `0` 变成「严格只用 WorkBuddy」 |
| `WORKBUDDY_FETCH_TIMEOUT_MS` | `20000` | 云端抓取预算（毫秒），会换算成网关的 `timeout` 秒 |
| `WORKBUDDY_FETCH_FALLBACK_TIMEOUT_MS` | `15000` | 回落抓取预算（毫秒） |
| `WORKBUDDY_FETCH_MAX_LENGTH` | `100000` | 回传正文字符上限 |
| `WORKBUDDY_FETCH_ENDPOINT` | 按区域自动 | 覆盖网关地址 |

账号区域（国内版 / 国际版）**不在本插件里单独配置** —— 它跟着
`dsh-workbuddy-websearch` 的 `region` 设置走，保证搜索与抓取扣同一个账号。

## 行为细节

- **返回形态**：云端已把正文抽成 markdown，这里按 `text` 交给 `dsh-tool-web`
  原样渲染（就是 `Fetched <url> (HTTP <status>)` 那段）。不做云端 AI 摘要 ——
  摘要会丢原文细节，而且每次抓取多花一次云端模型调用。
- **正文优先级**：同一份 `web_fetch` 调用只走一条路径，不会「两边都抓一遍再挑」。
- **哪些失败会回落**：

  | 云端失败原因 | 是否回落 |
  |---|---|
  | 出口路由策略拒绝（`15021`） | ✅ 回落 |
  | 网络错误 / 上游 5xx / 正文为空 / 非文本资源 | ✅ 回落 |
  | 凭据失效（`401`） | 先强制续期重试一次，仍失败则回落 |
  | URL 安全裁决（`15018` SSRF、`WEB_INVALID_URL`） | ❌ **不回落** |
  | 上游标记 `decisive` 的拒绝 | ❌ **不回落** |
  | 调用方 abort | ❌ 不回落 |

  原则：**「这一条路径走不通」才回落，「这个 URL 危险」不回落** —— 后者回落等于绕过安全裁决。
- **两条路径都失败时**，错误信息会把两边的原因**都列出来**，不会只留一句
  `TypeError: fetch failed` 让人误以为是插件坏了。
- **同源重定向**：本地回落后端只跟随**同源**重定向（跨源会明确报错），这是它原有的安全策略。

## 和搜索插件的 patch 会互相覆盖吗

**会 —— 而且装错顺序会让抓取静默失效。** 这是本插件最需要注意的一条。

`web` 行的 patch 语义是「**按 id 整行替换 `config`**」，不是深合并。谁后装，
谁的 `config` 就是最终生效的那一份：

| 安装顺序 | 最终 `web` 行 | 结果 |
|---|---|---|
| 只装本插件 | `search=workbuddy-agentic` / `fetch=workbuddy-fetch` | ✅ 搜索、抓取都走 WorkBuddy |
| 上游先、本插件后 | `search=workbuddy-agentic` / `fetch=workbuddy-fetch` | ✅ 正确 |
| **本插件先、上游后** | `search=workbuddy-agentic` / **`fetch=http`** | ⚠️ **抓取被打回 dsh 原生** |

最后一行是真实存在的坑：上游的 patch 里写着 `fetchProvider: http`（它当初假设
没人会接管抓取），后装它就会把本插件的 `workbuddy-fetch` 覆盖掉。
**本插件不会报错，抓取只是悄悄变回直连** —— 这正是最难发现的一类故障。

**怎么避免**：装的时候**先装上游，再装本插件**。装完用这条命令核验：

```bash
dsh --profile <你的 profile> --dump-config | grep -A4 "id: web"
# 两个字段都必须是 workbuddy-* 才算对
```

万一顺序反了：重装一次本插件（`remove` 后再 `add`）即可把 patch 层顶回最后。

> 💡 上游作者已在它的 README 里写明「只管搜索，不管抓取」，
> 所以这个覆盖不是 bug，是**两个插件各自合理、组合起来才出现**的层叠问题。
> 本插件选择在文档里明说，而不是偷偷改别人的配置。

## 已知边界

- **网关的域名覆盖由腾讯侧决定**，本插件无法扩展。被 `15021` 拒绝的站点只能靠回落路径，
  而回落路径需要本机能直连外网。两头都不满足的站点（例如隔离网里的 `medium.com`）仍然抓不到 ——
  此时错误信息会明确说明是哪一条路径拒绝的。
- **`401` 的处理**：网关对无效凭据回的是 HTML 401 页面而不是 JSON，本插件按鉴权失败处理
  （强制续期 + 重试一次）。凭据长期失效需回 WorkBuddy 桌面端重新登录。
- **只解析 markdown**：本插件请求 `format: "markdown"`。网关另外支持 `html` / `screenshot`，
  但 `screenshot` 无法映射到 dsh 的 `WebFetchBody`（只接受 `html` / `text`），故不暴露。
- **非文本资源**（PDF / 图片）网关会回空正文，本插件据此回落到本地抓取 ——
  由本地那条路给出 dsh 原本那套 `WEB_UNSUPPORTED_CONTENT_TYPE` 之类的明确错误。

## 安全

- 对 WorkBuddy 的凭据文件**只读**；令牌续期只在内存中完成，**不回写磁盘**。
- 所有云端请求只发往 **WorkBuddy 官方网关**（国内 `https://copilot.tencent.com`、
  国际 `https://www.workbuddy.ai`），不经过任何第三方中转。
- **回落路径不会放宽安全边界**：它用的就是 dsh 自带的 `HttpFetchProvider`，
  保留仅公共地址、DNS 结果全量校验、连接固定到已校验地址、字节/字符上限、
  同源重定向等全部约束。回落后**不会**比装插件之前更宽松。
- 发现安全问题请**不要开公开 Issue**。

## 卸载

```bash
dsh plugin --profile <你的 profile> remove dsh-workbuddy-fetch
```

bundle patch 随包消失，`web` 行的 `fetchProvider` 自动回到上一层
（`dsh-base` 的 `http`，即 dsh 原生的本地抓取），无需手动改配置。

> ⚠️ 若你曾在 profile 的 `cordis.patch.yml` 里写过 `- id: web-workbuddy-fetch` 传 config，
> 卸载后需**手动删掉**那段，否则 dsh 启动会报 `entry not found`（仅告警）。

## 致谢与来源

**本插件不打包、不修改、不分发 WorkBuddy 桌面端的任何代码。** 端点与请求形状来自对
本机已安装 App 的只读检查（`resources/app.asar.unpacked/cli` 中的 `WebFetchTool`），
相关权利归腾讯 / WorkBuddy 所有。

凭据、平台定位、区域绑定与令牌续期**复用**自
[`dsh-workbuddy-websearch`](https://github.com/arnen7000/DSH-Workbuddy-WebSearch)（MIT，
XingLang & WorkBuddy 小研）—— 通过运行时调用其导出实现，而非复制其代码。

完整的来源清单、各来源许可、哪些是原创、哪些是参考重写（含 `buildFallbackBridge()`
的说明），见 **[CREDITS.md](./CREDITS.md)**。

## 许可证

[MIT](./LICENSE) © 2026 RomanticMysteryLH

本项目建立在他人成果之上，按 MIT 要求已在 `LICENSE` 末尾保留全部上游版权声明。
