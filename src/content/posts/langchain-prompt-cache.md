---
title: "LangChain Prompt Cache 原理详解：一次命中，究竟省掉了哪段计算？"
published: 2026-09-10T14:30:00+08:00
description: "从 LangChain 的 lookup 调用链走到模型服务端的 KV cache，解释结果缓存、前缀匹配、缓存断点、Anthropic 中间件和 OpenAI cache key，并给出命中验证方法。"
tags: ["LangChain", "Prompt Cache", "KV Cache", "LLM", "AI Agent"]
category: "AI / Architecture"
draft: false
lang: "zh_CN"
---

假设你用 LangChain 做了一个文档问答服务。每次请求都带上同一份很长的产品手册，用户先问“怎么安装”，再问“怎么升级”。你打开缓存，第二次请求仍然调用了模型，监控里却出现了缓存命中的 token。

答案取决于缓存保存的对象。LangChain 可以保存一次模型调用的**生成结果**；模型服务端可以保存一段输入前缀的**中间计算状态**。前者复用回答，后者让模型带着已经算好的前缀继续回答新问题。

我们沿着这两个请求，把调用链拆开。

## 1. 先画清两层缓存的位置

把模型调用前后的缓存放进一张表，职责就清楚了。

| 机制 | 存什么 | 怎么匹配 | 命中后做什么 |
| --- | --- | --- | --- |
| LangChain 结果缓存，例如 `InMemoryCache` | `Generation` / `ChatGeneration` 等生成结果 | 序列化消息与模型调用配置 | 从模型封装这一层直接返回已有结果 |
| 模型服务端 prompt caching | 可复用前缀的计算状态，通常以 KV cache 理解 | 模型上下文中的一致前缀，以及服务端可用的缓存边界 | 处理新增输入，再生成回答 |

在结果缓存这一层，“安装”和“升级”是两次不同的输入。到了服务端，这两次输入仍可能共享“系统指令 + 产品手册”这一大段前缀。

因此，两层缓存可以叠加：本地结果命中时，这次模型调用提前结束；本地 miss 时，请求继续到达服务端，服务端再判断前缀能复用多少。[LangChain 的缓存模块](https://github.com/langchain-ai/langchain/blob/60357692c76651a7cd6153496a24658fa355bdcc/libs/core/langchain_core/caches.py)在模块说明里就明确区分了这两种机制。

还有两个容易混进来的概念。`PromptTemplate` 负责把变量组织成消息；LangGraph checkpointer 负责保存、恢复线程状态。前者决定最终发出什么，后者决定下一轮能拿回什么历史。它们会影响可复用前缀，但各自保存的对象和上表不同。

## 2. `InMemoryCache` 怎样让一次调用提前返回

先看一个无需 API key 的小实验。这里直接操作缓存接口，观察键和值：

```python
from langchain_core.caches import InMemoryCache
from langchain_core.outputs import Generation

cache = InMemoryCache()
cache.update("手册 + 怎么安装", "model=A", [Generation(text="安装步骤")])

assert cache.lookup("手册 + 怎么安装", "model=A")[0].text == "安装步骤"
assert cache.lookup("手册 + 怎么升级", "model=A") is None
assert cache.lookup("手册 + 怎么安装", "model=B") is None
```

实际调用聊天模型时，`prompt` 比这里的字符串复杂。以所引用版本的 [`BaseChatModel._generate_with_cache()`](https://github.com/langchain-ai/langchain/blob/60357692c76651a7cd6153496a24658fa355bdcc/libs/core/langchain_core/language_models/chat_models.py)为例，执行顺序是：

1. 选择模型实例指定的缓存，或全局缓存；实例设置 `cache=False` 时跳过结果缓存。
2. 用 `_get_llm_string()` 整理模型配置与调用参数。
3. 把消息的 `id` 归一化为 `None`，再序列化消息列表，避免仅消息 ID 不同就改变缓存键。
4. 调用 `lookup(prompt, llm_string)`。命中生成结果列表后，直接返回 `ChatResult`。
5. miss 才继续执行限流与模型生成，完成后通过 `update()` 保存结果。

`InMemoryCache` 的核心就是一个以 `(prompt, llm_string)` 为键的字典。相同手册只占键的一部分；用户问题变了，整个键就变了。模型配置也是键的一部分，具体哪些字段参与，要沿所用模型类的序列化实现检查。

例如，你重复提交同一个问题，希望再采样一个答案。如果输入和参与键计算的参数都没变，结果缓存会把上次生成结果交回来。业务需要重新采样时，应关闭或绕过这一层。

这个内存缓存跟着 Python 进程存在。所引用实现支持 `maxsize`，没有 TTL 参数；查找只读字典，不会把命中的条目移动到队尾。把它当作带自动过期和 LRU 的缓存使用，会误判驻留时间与淘汰顺序。上面的调用链讨论的是 `invoke` 所经的生成路径，流式接口要单独核对。

## 3. 模型已经算过的前缀，为什么能继续用

我们先用标准 decoder-only Transformer 建立最小模型。

模型处理输入，大体可以分成两段：prefill 处理输入上下文，decode 逐步生成后续 token。注意力层会为已经处理的 token 保存 key 和 value，后续 token 的 query 再与它们做注意力计算。

在因果注意力中，位置 `i` 只能读取它自己与前面的位置。后面追加一句话，不会倒过来改变此前 token 的表示。于是，前缀已经算出的各层 K、V 可以保留下来。

把位置编码和注意力掩码暂时略去，后续一步可以写成：

```text
K = concat(K_已有前缀, K_新位置)
V = concat(V_已有前缀, V_新位置)
新位置的输出 = Attention(Q_新位置, K, V)
```

这里省掉的是旧前缀状态的重复计算。新位置仍要读取这些 K、V 并做注意力运算，所以长上下文的存储与读取成本依然存在。[Hugging Face 的 KV cache 说明](https://huggingface.co/docs/transformers/main/cache_explanation)给出了逐层追加 K、V 的实现模型。

单次生成内部的 KV cache，服务于同一个请求不断追加 token。跨请求的 prompt caching 在此基础上，还要处理前缀识别、缓存存放、查找、过期和调度。LangChain 把请求发出去之后，这部分工作发生在模型服务端。

回到产品手册：第二次请求找到可复用的手册前缀状态，就能接着处理“怎么升级”，然后生成一个新答案。输出 token 仍要计算；缓存通常首先影响输入处理和首 token 等待时间，整段响应的耗时还取决于输出长度、推理过程与排队。

## 4. 前缀相同，是怎样一种“相同”

我们把请求画成几个块：

![两个请求共享系统指令与手册前缀，问题从边界后分叉；开头插入变化时间戳会截断后续前缀复用](/images/posts/langchain-prompt-cache/prefix-boundary.svg)

在前两个请求中，手册之前的内容相同，问题放在尾部。在第三个请求中，每次变化的时间戳被放到了开头，后面再接相同手册。

对于这种前缀缓存，第三个请求无法直接跳过变化位置，再把手册当作原位置上的旧状态接回来。后面的 token 已经处在不同的前文和位置条件下。根据同一个机制推导，把两段内容调换顺序，即使文字集合相同，也会改变可复用的状态。

实际匹配对象还包括模型最终渲染的角色、工具定义、内容块和有关设置。只比较 Python 里的手册字符串，会漏掉外围变化。工具的描述、参数 schema 或排列顺序改变，都值得检查。

因此，组织提示词时可以采用下面的顺序：稳定指令与工具定义、稳定参考材料、持续追加的历史，最后是当前问题与必要的动态信息。这个顺序须服从业务语义；例如某条新权限规则必须生效，就应修改相应上下文并接受缓存重建。

### 公共前缀还需要一个可用的结束位置

假设两个请求分别是 `P + Q1` 和 `P + Q2`。即使 `P` 很长，也要看服务端有没有在 `P` 的末尾或更早位置保存可查找的状态。

如果只有 `P + Q1` 的末尾被设为缓存断点，第二次请求走到该位置时内容已经不同。此时，`P` 在逻辑上是公共前缀，却可能没有对应的可复用缓存条目。

断点承担的作用，就是把某个位置声明为缓存前缀的终点。实际命中同时需要：前缀匹配、长度满足该模型要求、查找规则能到达对应断点，而且缓存条目仍可用。

OpenAI 当前文档专门列出了“公共前缀存在，但没有可复用缓存前缀”的情况。新旧模型的隐式断点位置与查找方式有差异，旧教程里的固定分块规则不能直接套到所有模型。[见 OpenAI 的前缀匹配与迁移说明](https://developers.openai.com/api/docs/guides/prompt-caching#how-prefix-matching-works)。

## 5. LangChain 在 Anthropic 请求里加了什么

需要精确缓存“稳定指令 + 手册”时，可以在稳定内容块末尾放置 `cache_control`：

```python
import os
from pathlib import Path
from langchain_anthropic import ChatAnthropic

manual = Path("manual.txt").read_text(encoding="utf-8")
model = ChatAnthropic(model=os.environ["ANTHROPIC_MODEL"], cache=False)

def ask(question):
    return model.invoke([
        {
            "role": "system",
            "content": [{
                "type": "text",
                "text": "依据产品手册回答问题。\n" + manual,
                "cache_control": {"type": "ephemeral", "ttl": "5m"},
            }],
        },
        {"role": "user", "content": question},
    ])

for question in ["怎么安装？", "怎么升级？"]:
    response = ask(question)
    print(response.usage_metadata)
```

运行需要安装 `langchain-anthropic`、设置 `ANTHROPIC_API_KEY`，并把 `ANTHROPIC_MODEL` 设为账户可用且支持缓存的模型。手册前缀要达到该模型的最低缓存长度。示例刻意设置 `cache=False`，让两次请求都到达服务端，方便观察前缀缓存。

Anthropic 按 `tools → system → messages` 的顺序组织缓存前缀。标记某个块，会把它前面的前缀一起纳入范围；它不会把那个块变成脱离前文、可随意搬动的缓存片段。[Anthropic 官方说明](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#how-prompt-caching-works)给出了这个顺序；[LangChain 集成文档](https://docs.langchain.com/oss/python/integrations/chat/anthropic#prompt-caching)提供了内容块写法。

如果使用 `create_agent()`，还可以接入 `AnthropicPromptCachingMiddleware`。在本文引用的源码版本中，中间件执行三个具体动作：标记 system message 的最后一个内容块，标记最后一个工具定义，再把 `cache_control` 合并进 `model_settings`。模型适配层和供应商负责后续消息尾部及传输协议的处理。

所以，中间件的工作重点是整理请求的缓存控制信息。它的 `min_messages_to_cache` 检查消息数量；供应商检查可缓存 token 长度，二者属于不同条件。中间件也不会替你保存跨调用历史，连续对话仍需要消息传递或 checkpointer。[中间件源码](https://github.com/langchain-ai/langchain/blob/60357692c76651a7cd6153496a24658fa355bdcc/libs/partners/anthropic/langchain_anthropic/middleware/prompt_caching.py)可以逐项核对这些动作。

## 6. OpenAI 的 cache key 控制哪一层

在 `ChatOpenAI.invoke()` 中传入 `prompt_cache_key`，这个值会进入供应商请求。它和 `InMemoryCache` 的 `(prompt, llm_string)` 不在同一层。

可以把它理解为一组请求的缓存分组控制。固定 key 无法让两个不同前缀变成相同前缀；每次生成随机 key，又会使本可共享的一组请求被拆开。设计 key 时，让它跟着需要共享缓存的稳定请求组走，并保留业务所需的租户或用户分隔。

缓存断点则决定“前缀在哪里结束”。截至 2026 年 9 月 10 日，[LangChain 的 OpenAI 集成文档](https://docs.langchain.com/oss/python/integrations/chat/openai#prompt-caching)对新旧接口作了如下区分：

| 范围 | 配置入口 | 含义 |
| --- | --- | --- |
| 支持缓存分组的请求 | `prompt_cache_key` | 区分请求组的缓存复用 |
| GPT-5.6 及后续模型，且 `langchain-openai >= 1.3.5` | `prompt_cache_options` | 选择隐式或显式模式等请求级选项 |
| 上述显式断点能力 | 内容块里的 `prompt_cache_breakpoint` | 声明一个可缓存前缀的终点 |
| GPT-5.6 之前的模型 | `prompt_cache_retention` | 使用该模型支持的保留时间选项 |

显式模式下，稳定材料末尾要有显式断点；仅切换模式并不会自动替你选择位置。旧版模型的参数、阈值和分块间隔应按具体型号核对。升级模型时，值得重新跑一次前缀命中实验。

## 7. 用什么证据判断命中

“第二次快了”只能提出一个猜测。连接复用、服务端排队和输出变短，也可能让总耗时下降。

先记录 LangChain 返回的完整 usage，再观察缓存明细：

```python
usage = response.usage_metadata or {}
details = usage.get("input_token_details", {})
print("input_tokens:", usage.get("input_tokens"))
print("input_token_details:", details)
print("cache_read:", details.get("cache_read"))
```

常规映射里，`cache_read` 是缓存读取 token。具体字段取决于集成、版本和 service tier；例如当前 OpenAI 集成在部分服务等级使用带等级前缀的明细键。因此，排障时打印完整 `input_token_details`，缺失字段先记为缺失，别直接当成零命中。

再对照供应商原始 usage。OpenAI 常见字段为 `input_tokens_details.cached_tokens`，Chat Completions 对应 `prompt_tokens_details.cached_tokens`。Anthropic 使用 `cache_read_input_tokens`、`cache_creation_input_tokens`，原始 `input_tokens` 只统计未进入这两项的输入部分：

```text
Anthropic 总输入 = input_tokens
                + cache_read_input_tokens
                + cache_creation_input_tokens
```

LangChain 的归一化统计与供应商原始统计要分别阅读，避免重复相加。缓存 token 仍然属于模型上下文；计费归类变化，不会凭空扩大上下文窗口。[Anthropic usage 口径](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#tracking-cache-performance)可以用来核对这一点。

还有一层观测陷阱：结果缓存可能把旧 `AIMessage` 的 usage 一起带回来。统计“本次实际 API 消耗”时，要结合真实出站请求数，不能把每次返回消息的历史 usage 都重新累计。

### 把实验拆成四次请求

关闭 LangChain 结果缓存，固定模型、工具和其他配置，给稳定前缀设置适用的缓存断点，然后按顺序执行：

| 请求 | 唯一变化 | 验证目标 |
| --- | --- | --- |
| A | 首次发送手册和问题 | 观察缓存写入或冷请求统计 |
| B | 完全重复 A，等 A 完成后再发送 | 验证有可用的缓存读取 |
| C | 只改末尾问题 | 验证手册边界能被单独复用 |
| D | 改手册开头一段，其余不变 | 验证变化位置对后续前缀的影响 |

这是一套验证步骤，云端命中数和耗时需在实际账户中采集。D 仍可能命中变化位置之前的系统或工具前缀，要把读取长度与变化位置对应起来。

如果 B 能命中、C 不能，优先看手册末尾有没有可查找断点。如果 B 也不能，再查长度阈值、缓存有效期、最终请求内容、模型与分组设置。先把顺序请求跑通，再增加并发，可以减少多个冷请求同时到达带来的干扰。

## 8. 缓存收益要按复用次数算

假设稳定前缀为 `P` 个 token，每次请求新增 `S` 个 token，共调用 `n` 次。用普通输入、缓存写入和缓存读取的每 token 单价分别表示为 `c_in`、`c_write`、`c_read`。在“第一次写入，后面全部命中，前缀期间不变且不过期”的简化条件下：

```text
不使用缓存：n × (P + S) × c_in
使用缓存：P × c_write + (n - 1) × P × c_read + n × S × c_in
```

这两个式子只算输入费用。相同输出工作量可以在比较时抵消；真实账单还要计入输出，以及适用的工具等费用。

从式子可以直接看出，长前缀只是收益条件之一。写入后有没有再次读取，同样决定成本。如果每轮都在开头塞入新时间戳，就可能不断付出写入成本，却读不到上一轮条目。TTL 拉长能增加复用机会，也要结合对应写入价格和请求间隔判断。

落到文档问答服务，先做三个记录就够了：每次实际出站的请求数、读取与写入的输入 token、首 token 和总响应耗时。再把问题放在手册之后，在稳定材料末尾设置合适断点，运行 A 到 D。你就能定位，这次优化省掉的是一整次模型调用，还是一段前缀的重复计算。
