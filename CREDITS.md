# 致谢与来源声明（Credits & Attribution）

本插件以 **MIT** 发布，构建在他人的成果之上。此处如实列出每个来源、许可，
以及**具体借鉴了什么、哪些是本项目原创**。

> 原则：**能调用就不复制，复制不了的必须重写，重写必标注来源。**

## 来源总览

| 项目 | 作者 | 许可证 | 与本插件的关系 | 是否分发其代码 |
|---|---|---|---|---|
| **`dsh-workbuddy-websearch`** | XingLang & WorkBuddy（小研） | MIT | **运行时依赖 + 部分逻辑参考** | ❌ 否（`peerDependencies` 声明，运行时调用） |
| **`@deepseek-ai/dsh-web`** | DeepSeek | MIT | 契约级依赖：`registerFetchProvider` 接缝 | ❌ 否 |
| **`@deepseek-ai/dsh-web-fetch-http`** | DeepSeek | MIT | 回落后端：实例化其导出的 `HttpFetchProvider` | ❌ 否 |
| **`dsh-workbuddy-connect`** | Corrine Hu | MIT | 间接来源（经上面第一个项目的可选增强路径） | ❌ 否 |
| **WorkBuddy 桌面端 `app.asar`** | 腾讯 / WorkBuddy | 专有 | **端点取证**，不含任何代码 | ❌ 否 |

## 一、`dsh-workbuddy-websearch`（最重要的来源）

仓库：<https://github.com/arnen7000/DSH-Workbuddy-WebSearch>

**关系是「运行时依赖」，不是「fork 或摘取代码」。** 本插件通过 `peerDependencies`
依赖它，在运行时调用它导出的函数：

```js
// 首选路径：它自己的 __internals 导出
internals.resolveCredential(forceRefresh, signal)   // 凭据解析 + 令牌内存续期
internals.chatBase(credential)                      // 网关地址（国内 / 国际分流）
internals.selectVariant()                           // 选哪一版账号
internals.variantCredentialState(variant)           // 该版登录态的形态

// 降级路径：它 package.json 里声明的正式子路径导出
dsh-workbuddy-websearch/platform    → VARIANTS, variantForRegion
dsh-workbuddy-websearch/credentials → resolveCredentialForVariant,
                                       credentialPathsForVariant,
                                       parseAuthFileSync
```

**为什么复用而不是自己写一遍。** 国内版（WorkBuddy）与国际版（WorkBuddy AI）
是两套账号、两套积分；`$wbEncrypted` 凭据的加密格式还会随桌面端版本变化。
如果本插件自带一套判定逻辑，就可能出现「搜索扣国际版、抓取扣国内版」——
那是账务事故，不是容错。复用它意味着两边**必然**指向同一版账号。

### 确实借用其实现的部分

`buildFallbackBridge()` 里约 58 行，是**参照上游同名函数重写的等价逻辑**
（不是复制原文，但规则与结构同源）：

| 本插件函数 | 上游对应 | 说明 |
|---|---|---|
| `regionSetting()` | `regionSetting()` | 区域设置解析，含 `china`→`cn`、`ai`/`intl`/`international`→`global` 的别名兼容 |
| `variantCredentialState()` | `variantCredentialState()` | 判断某版的登录态是 `plain` / `encrypted` / `absent` |
| `selectVariant()` | `selectVariant()` | `auto` 模式下按 `AUTO_REGION_ORDER` 选版本 |
| `chatBase()` | `chatBase()` | 按凭据域名/变体选国内或国际网关 |

这段属于「读了别人的实现再重写同样的事」，按 MIT 合法，但**必须注明**——
这就是它出现在这里的原因。如果你认为标注不足，请提 Issue，我们会补正或重写。

## 二、`@deepseek-ai/dsh-web` / `dsh-web-fetch-http`

DeepSeek 的 DSH 官方包，MIT。本插件只通过它们的**公开接缝**接入：

- `ctx.web.registerFetchProvider(provider)` —— 注册抓取 provider；
- `HttpFetchProvider` —— 回落路径直接实例化它（**不注册**，因此不占用
  `ctx.web` 的 provider id，也不会与真正的 `web-fetch-http` 行撞车）。

回落后端刻意复用官方实现而非自研，原因写在 README 的「安全」一节：
它的防护（仅公共地址、DNS 结果全量校验、连接固定、同源重定向、字节/字符上限）
与本插件装之前**完全一致**，所以回落后不会让安全边界变松。

## 三、WorkBuddy 桌面端（端点取证）

**本插件不打包、不修改、不分发该 App 的任何代码。**

`/agenttool/v1/webfetch` 的请求形状（`format` / `timeout` / `max_length` 字段，
`timeout` 以**秒**为单位）、响应形状（`{url, title, content, content_type,
status_code, truncated}`）与错误码（`15018` SSRF 拒绝 / `15021` 路由策略拒绝 /
`15013` 参数错误），来自对**本机已安装**的 WorkBuddy 桌面端产物的只读检查
（`resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs` 中的 `WebFetchTool`）。

相关权利归 **腾讯 / WorkBuddy** 所有。本插件只是使用其登录态与这套接口，
不声称对任何端点、协议或商标拥有权利。

## 四、本项目的原创部分

- 把 WorkBuddy 抓取网关接入 dsh `ctx.web` 的 fetch 接缝的 **provider 实现**；
- **「安全裁决不回落、路径不通才回落」** 的降级判定
  （`shouldFallback()`：`decisive` / `WEB_BLOCKED_URL` / `WEB_INVALID_URL` /
  `WEB_ABORTED` 一律不回落，其余才回落）；
- **两条路径都失败时合并上报原因**（避免只剩一句 `TypeError: fetch failed`
  把真实原因吃掉）；
- **不依赖环境变量的宿主模块解析**（`ctx.baseUrl` 为主锚点 + 多级降级），
  解决 `link:` 装法下裸模块解析必然失败的问题；
- 配置项设计（`fallback` / `timeoutMs` / `fallbackTimeoutMs` / `maxLength` /
  `endpoint`）与环境变量映射。

## 如果我们是错的

若你是上述任一项目的作者，认为标注不足、使用方式不当，或不希望被以这种方式参考，
请提 Issue 或直接联系。我们会**在下一次发布中补正标注**，或**按要求移除/重写相应实现**。

---

本插件以 **MIT License** 发布，`Copyright (c) 2026 RomanticMysteryLH`。
MIT 与上述所有来源的许可证（均为 MIT 或未分发其代码）兼容；按 MIT 要求，
我们在 [LICENSE](./LICENSE) 中保留了来源与版权声明。
