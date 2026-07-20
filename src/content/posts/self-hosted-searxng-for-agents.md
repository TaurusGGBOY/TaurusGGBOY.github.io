---
title: "把 SearXNG 变成可靠的本地搜索服务"
published: 2026-07-20T21:23:33+08:00
description: "从一次真实部署出发，整理 SearXNG 的通用安装、JSON API、服务常驻、逐引擎验收、Agent 接入与维护方法。"
tags: ["searxng", "self-hosted", "ai-agent", "search"]
category: "AI / Tools"
draft: false
---

我最近把本机的 SearXNG 从“偶尔启动一下的搜索页面”，整理成了一个能长期运行、可以被 AI Agent 稳定调用的服务。最终效果并不复杂：浏览器能访问，程序能拿 JSON，机器重启后服务会回来，某个搜索引擎失效时也能知道坏在哪里。

真正花时间的不是安装，而是把安装之后的几个问题逐一处理掉：配置放在哪里、进程由谁管理、代理是否真的传进服务、JSON 接口有没有启用、每个上游引擎是否可用，以及 Agent 应该知道哪些运行约定。

这篇文章以我的部署为案例，但不会假设你也在用 macOS、相同端口或同一组搜索引擎。Docker、Linux 原生安装和 macOS 原生安装的命令不同，后面的设计原则是相通的。

## 先定义“能正常运行”

看到 SearXNG 首页，只能证明 Web 进程启动了。对一个长期使用、还要交给 Agent 调用的实例，我会检查四层状态：

1. **进程层**：服务管理器能看到进程，异常退出后可以拉起。
2. **HTTP 层**：首页和健康检查能在超时时间内返回。
3. **API 层**：`format=json` 返回可解析的数据，而不是 HTML 错误页。
4. **引擎层**：常用引擎分别测试，失败信息能在 `unresponsive_engines` 中看到。

这四层要分开。聚合搜索的 Web 服务可以完全健康，但百度、Google 或其他上游仍可能因为 CAPTCHA、地区限制、限流和页面结构变化而暂时失效。

## 选择部署方式

SearXNG 官方同时提供[容器安装](https://docs.searxng.org/admin/installation-docker.html)和[逐步安装](https://docs.searxng.org/admin/installation-searxng.html)文档。第一次部署时，容器通常更省事；需要调试引擎源码、复用宿主机代理或精确控制 Python 环境时，原生安装更直观。

无论选哪种方式，我都建议把下面四类内容分开：

| 内容 | 作用 | 维护原则 |
| --- | --- | --- |
| 程序源码或镜像 | SearXNG 本体 | 可以升级或重新拉取 |
| 运行环境 | Python 虚拟环境或容器 | 可以重建 |
| `settings.yml` | 实例配置 | 单独备份，限制权限 |
| 日志与缓存 | 排错和运行数据 | 有明确位置和清理策略 |

我的旧方案是 Docker，后来迁移到 Python 虚拟环境，并交给 macOS 的 `launchd` 常驻。这个选择只代表我的机器更适合这样维护，不意味着原生安装普遍优于容器。

## 从最小配置开始

SearXNG 的配置项以当前版本的[官方 Settings 文档](https://docs.searxng.org/admin/settings/index.html)为准。下面是适合本地程序调用的最小思路，不是一份可以覆盖所有版本的完整配置：

```yaml
use_default_settings: true

search:
  formats:
    - html
    - json

server:
  bind_address: "127.0.0.1"
  port: 8888
  secret_key: "<使用随机值替换>"
```

这里最容易漏掉的是 `json`。SearXNG 的[搜索 API 文档](https://docs.searxng.org/dev/search_api.html)说明，客户端请求 `format=json` 之前，服务端必须在 `settings.yml` 中允许这种格式。

建议一开始只监听 `127.0.0.1`。如果确实要给局域网设备使用，再改监听地址，并同时考虑系统防火墙、反向代理、访问控制和可信网络边界。不要把一个没有访问控制的私人实例直接暴露到公网。

`secret_key` 不要提交到 Git，也不要复制文章里的示例值。可以用系统的安全随机数工具生成，并把配置文件权限限制为仅当前用户可读。

## 用服务管理器接管进程

手动在终端运行适合验证安装，不适合长期服务。终端退出、机器重启或进程崩溃后，搜索能力就消失了。

不同系统使用各自成熟的进程管理方式：

- Docker 或 Podman：使用 Compose 的重启策略，并持久化配置。
- Linux 原生安装：使用 `systemd`，设置工作目录、环境变量、启动命令和日志。
- macOS 原生安装：使用 LaunchAgent，设置 `RunAtLoad` 和异常退出后的重启行为。

服务定义至少要写清楚以下内容：

```text
工作目录        SearXNG 源码或应用目录
启动命令        已经在终端验证成功的服务器命令
配置路径        SEARXNG_SETTINGS_PATH 或等价参数
PATH            服务真正需要的可执行文件目录
标准输出/错误   固定日志文件或日志系统
重启策略        异常退出后重启，避免无休止快速重试
```

我这次踩到的坑是：**服务管理器不会自动继承交互式 Shell 的环境**。终端里设置过 `HTTP_PROXY`，并不能保证 `systemd`、`launchd` 或容器里的进程也能看到。代理、证书路径和自定义 `PATH` 都应该写入服务配置或 SearXNG 的 `outgoing` 配置，并通过运行中的进程再次确认。

## 给自己一个固定入口

Agent 和脚本不应该猜测服务现在跑在哪个端口。我会先确定一个只在本机使用的固定地址，再围绕它写健康检查和调用方式。以下命令使用示例端口 `8888`：

```bash
SEARXNG_URL="http://127.0.0.1:8888"

curl -fsS --max-time 3 "$SEARXNG_URL/" >/dev/null

curl -fsS --get \
  --data-urlencode 'q=SearXNG documentation' \
  --data 'format=json' \
  "$SEARXNG_URL/search" \
  | jq '{count: (.results | length), unresponsive_engines}'
```

查询字符串用 `--data-urlencode` 处理，比手工拼 URL 稳妥，中文、空格和特殊符号都不会破坏请求。`--max-time` 也很重要，否则上游网络异常时，健康检查本身可能长时间挂住。

## 聚合成功不等于每个引擎成功

只跑一次默认搜索很容易得到假阳性：五个引擎里只要一个返回结果，页面看起来就“正常”。部署完成后，我会把准备长期使用的引擎逐个测一遍：

```bash
SEARXNG_URL="http://127.0.0.1:8888"

for engine in google bing baidu; do
  curl -fsS --get \
    --data-urlencode 'q=SearXNG documentation' \
    --data 'format=json' \
    --data-urlencode "engines=$engine" \
    "$SEARXNG_URL/search" \
    | jq -c --arg engine "$engine" \
      '{engine: $engine, results: (.results | length), unresponsive_engines}'
done
```

测试时同时看结果数和 `unresponsive_engines`。零结果可能只是查询不合适，也可能是 CAPTCHA、超时或解析器失效。换两三个稳定关键词复测，并查看服务日志，才能判断是哪一种。

我的实例目前把五个中文和英文 Web 引擎放在 `general` 分类中。写这篇文章前重新验收时，四个引擎正常返回，百度仍被 CAPTCHA 挂起。这反而验证了逐引擎测试的价值：服务是健康的，上游并不保证同时健康。

## 我为什么修改了两个引擎

迁移完成后，我把本地源码与上游基线做了 diff。改动集中在两个文件：百度引擎增加约 88 行，夸克引擎增加 15 行。

百度的匿名 JSON 入口很快会跳到 CAPTCHA。我的本地补丁先解析移动端 HTML，失败后再尝试隔离的 JSON 出口，并缓存最近一次成功结果。夸克对单个出口的请求阈值较低，因此在检测到 CAPTCHA 后，让本地网络层轮换出口重试。

这类补丁有三个明确代价：

- 页面结构变化后，解析器需要跟着维护。
- 本地分支升级时要重新审查和移植补丁。
- 多代理只是降低单点阻塞概率，不能绕过服务条款或保证长期可用。

所以我不会建议每个读者照抄这两个文件。更通用的处理顺序是：减少引擎数量和请求频率，调整超时，选择在自己网络中稳定的上游，最后才考虑维护本地补丁。搜索引擎持续要求验证码时，也应该尊重其访问策略，而不是无限重试。

## 把 SearXNG 接给 Agent

飞书里那条“本机 SearXNG Agent 配置提示词”给了我一个很实用的结构：不要把整份部署文档塞进系统提示词，只写 Agent 每次执行任务都必须遵守的运行契约。

下面是去掉本机路径和固定引擎后的通用模板：

```markdown
## Local SearXNG

- Endpoint: `<SEARXNG_URL>`
- JSON search: `<SEARXNG_URL>/search?q=<query>&format=json`
- Health check: `curl -fsS --max-time 3 <SEARXNG_URL>/ >/dev/null`
- The service is persistent and managed by `<SERVICE_MANAGER>`.
- Do not start another container or process unless the health check fails and
  the documented recovery command also fails.
- Operations guide: `<OPERATIONS_DOC>`
- Prefer an appropriate category or engine instead of sending every request to
  `general`.
- Check `unresponsive_engines`; an empty result is not automatically a healthy
  search.
- Before upgrades or proxy changes, read the operations guide and preserve
  local configuration.
```

这段提示词解决的是协作边界：固定入口在哪里、怎样判断健康、谁负责拉起服务、失败时看什么，以及 Agent 不应该做什么。端口、服务管理器和运维文档路径都应该由部署者填写，不能假定别人的环境与我的机器相同。

真正执行搜索时，我还会要求 Agent：

- 对查询参数做 URL 编码，设置合理超时。
- 按任务选择 `general`、`packages`、`repos` 或其他分类。
- 只截取需要的字段和结果数量，避免把整份 JSON 塞进上下文。
- 重要事实继续打开原始来源核对；SearXNG 是发现工具，不是事实本身。

## 常见故障的排查顺序

### `format=json` 返回 403 或 HTML

先确认 `search.formats` 包含 `json`，再检查实际加载的是不是这份 `settings.yml`。改完配置后要重启服务。

### 终端可用，常驻服务不可用

检查服务管理器里的 `PATH`、代理和配置路径。不要只看当前 Shell 的环境变量。

### 首页正常但没有搜索结果

使用指定引擎查询，查看 `unresponsive_engines`，再看错误日志。超时、限流、CAPTCHA 和解析失败的处理方式不同。

### 重启后配置消失

检查容器挂载或服务读取路径。配置、源码和运行环境不要混在一个会被重建的目录里。

### 升级后本地引擎又坏了

升级前记录上游版本和本地 diff。升级后先迁移补丁，再逐个验证引擎。直接覆盖源码会安静地丢掉本地修改。

## 最后保留一份运维记录

我给这个实例单独写了一页短运维文档，记录服务标签、配置与日志位置、健康检查、重启方式、当前上游版本、本地补丁、备份和回滚路径。它既给人看，也给 Agent 的提示词引用。

部署完成只是起点。一个更可靠的 SearXNG 实例，应该允许你在几分钟内回答这些问题：进程是否活着、API 是否可用、哪个引擎坏了、配置从哪里加载、上次改了什么，以及升级失败后怎样退回去。

当这些答案都有固定位置，SearXNG 才真正从一个网页变成可复用的本地搜索基础设施。
