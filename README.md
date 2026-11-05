# dsh-workbuddy-fetch

把 DeepSeek Harness 的 **`web_fetch`（抓取）** 也接到 [WorkBuddy](https://www.workbuddy.cn) 的网页抓取网关，
复用你已经登录的 WorkBuddy 账号 —— 不需要任何 API Key。

这是 [`dsh-workbuddy-websearch`](https://github.com/arnen7000/DSH-Workbuddy-WebSearch) 的**抓取侧补全**：
那个插件接管了 `web_search`，把 `web_fetch` 明确留给了 dsh 内置的 `web-fetch-http`（直连目标站点）。
本插件补上这一半，两个可以同时装、互不干扰 —— 它们注册的 provider 分属 **两个不同的注册表**。

> ⚠️ **本插件只提供 `web_fetch`，不提供 `web_search`。**
> 它**不含**搜索 provider，也**不会**接管搜索；`web_search` 仍由
> `dsh-workbuddy-websearch` 负责。本插件的 `cordis.patch.yml` 里会复述
> `searchProvider: workbuddy-agentic`，但那只是**避免整行替换时把搜索字段抹掉**
> （见下方「和搜索插件的 patch 会互相覆盖吗」），本插件自己并不实现搜索。

## 目录

- [它做什么](#它做什么)
- [安装](#安装)
- [配置](#配置)
- [行为细节](#行为细节)
- [和搜索插件的 patch 会互相覆盖吗](#和搜索插件的-patch-会互相覆盖吗)
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

## 安装

前置有两条：

1. 本机已安装**并登录** WorkBuddy 桌面端（国内版或国际版任一）。
2. 已安装 [`dsh-workbuddy-websearch`](https://github.com/arnen7000/DSH-Workbuddy-WebSearch) ——
   本插件复用它的平台定位、凭据解密、区域绑定与令牌续期，**不重复实现一遍**。
   这不只是省代码：两边的「用哪一版账号」判定因此必然一致，不会出现
   「搜索扣国际版、抓取扣国内版」这种账务意外。

```bash
# 以本机目录安装（插件市场里搜 workbuddy-fetch 也可以）
dsh plugin --profile <你的 profile> add <本插件目录的绝对路径>
```

重启 dsh 后生效。核验（应看到 `fetchProvider: workbuddy-fetch`）：

```bash
dsh --profile <你的 profile> --dump-config
```

> ⚠️ **同一个 fetch provider id 只能由一个插件注册。** 若你还装着注册了
> `workbuddy-fetch` 的其他插件（旧版、fork），`ctx.web` 会按 id 去重，
> 后注册的那个静默不激活。撞上时本插件会直接打印「该 id 已被占用」和排查步骤。

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

**内容上不会，但机制上有一个必须知道的坑。**

`web` 行的 patch 语义是「**按 id 整行替换 `config`**」，不是深合并。
所以任何插件的 `cordis.patch.yml` 只要写了 `- id: web`，就必须把
`searchProvider` 和 `fetchProvider` **两个字段都写全**，否则没写的那个会被抹成
`undefined`。两个插件的 patch 都遵守了这一点：

| 插件 | patch 里写了 | 效果 |
|---|---|---|
| `dsh-workbuddy-websearch` | `searchProvider: workbuddy-agentic` + `fetchProvider: http` | 搜索走它；抓取保持 dsh 原生 |
| `dsh-workbuddy-fetch`（本插件） | `searchProvider: workbuddy-agentic` + `fetchProvider: workbuddy-fetch` | 抓取走它；搜索字段被**原样复述**，不受影响 |

两个都装时，后装的那层 patch 覆盖前者；因为两边写的是同一组值，最终结果正确。

> ⚠️ **但本插件不能单独用。** 如果装了本插件而**没装** `dsh-workbuddy-websearch`，
> `web` 行仍指向 `workbuddy-agentic` —— 那个 id 没有任何插件注册，`web_search`
> 会整体报 `WEB_PROVIDER_CONFIGURED_MISSING`（而本插件不提供搜索，救不了）。
> 这种情况本插件启动时会**主动打一行警告**并给出两种修法，不会让你只看到
> 「搜索莫名其妙坏了」。

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
