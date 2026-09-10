---
title: "模型为什么能严格输出 JSON？拆开 json_schema 与 strict 的实现"
published: 2026-09-10T21:40:00+08:00
description: "从 Schema 编译、增量匹配与动态 token mask，讲到 FSM、CFG、采样公式、性能优化，以及 strict 的 API 层级和保证边界。"
tags: ["llm", "json-schema", "structured-outputs", "constrained-decoding", "inference"]
category: "AI / Architecture"
lang: "zh_CN"
draft: false
---

给模型传入 `json_schema`，再设置 `strict: true`，在 Schema 受支持、响应正常完成且没有拒绝时，返回值就能按约定的字段、类型和枚举交给程序处理。这个保证的关键在采样阶段：**推理服务根据已生成的内容，动态计算下一步允许出现的 token，把其余候选的概率置零。** 模型负责在允许的范围内选择内容，约束引擎负责维持结构。

OpenAI 在 2024 年公开的实现说明中，将它描述为两部分配合：训练模型理解 Schema，再以约束解码提供格式保证。单次请求开启 `strict` 时，改变的是推理时的输出约束，并不需要为这份 Schema 重新训练权重。[OpenAI 的实现说明](https://openai.com/index/introducing-structured-outputs-in-the-api/)

## 先看清楚，究竟严格到了哪一层

假设我们要从一句话中提取订单状态，返回下面这样的对象：

```json
{"status":"paid","order_id":"A17"}
```

同样叫“输出 JSON”，实际有三层要求：

| 层次 | 检查什么 | 例子 |
| --- | --- | --- |
| JSON 语法 | 能否解析为 JSON 值 | `{"hello":123}` 能解析，但没有订单字段 |
| Schema 约束 | 字段、类型、枚举是否匹配 | `{"status":"paid","order_id":"A17"}` 形状正确，却可能认错订单 |
| 业务与事实 | 是否忠实于原文，是否符合业务关系 | 原文明明写着“未付款”，结果却标记为 `paid` |

自然语言提示“只返回 JSON”表达了意图。OpenAI 的 JSON mode 提供 JSON 格式约束；启用严格 Structured Outputs 才进一步约束所支持的 Schema。拒绝和输出未完成需要单独处理，不能直接当作成功对象。[Structured Outputs 文档](https://developers.openai.com/api/docs/guides/structured-outputs)

`strict` 也不是 JSON Schema 标准里的校验关键字，而是 API 的控制参数。Schema 内的 `type`、`enum`、`required` 定义对象要求；API 外层的开关告诉服务如何执行这些要求。

## 把一个 Schema 变成可以执行的规则

先只保留一个状态字段，避免其他细节遮住机制：

```json
{
  "type": "object",
  "properties": {
    "status": {
      "type": "string",
      "enum": ["paid", "unpaid", "unknown"]
    }
  },
  "required": ["status"],
  "additionalProperties": false
}
```

这份 Schema 允许三个状态，不允许漏掉 `status` 或增加 `comment`。一个编译器可以把它转换为如下示意文法，`ws` 表示 JSON 允许的空白：

```text
root   ::= "{" ws "\"status\"" ws ":" ws status ws "}"
status ::= "\"paid\"" | "\"unpaid\"" | "\"unknown\""
ws     ::= [ \t\n\r]*
```

这里采用固定键名拼写，是为了展示一种生成路径；它并非列举 JSON 所有等价转义写法。这些规则指定了怎样从头写出一个满足 Schema 的结果。`llama.cpp` 的 GBNF 文法与 JSON Schema 转换提供了可以直接查看的实现入口。[llama.cpp 文法说明](https://github.com/ggml-org/llama.cpp/blob/master/grammars/README.md)

编译完成后，每个请求还需要自己的 **增量匹配状态**：现在匹配到哪个规则、字符串是否闭合、还有哪些分支可走。共享的编译产物可以复用，请求已经写到哪里则必须分别记录。

当输出前缀为 `{"status":"un` 时，`unpaid` 和 `unknown` 两条路径仍然可走，`paid` 已经不可能。下一步允许哪些 token，必须根据这个前缀重新计算。

![Schema 编译为文法，文法匹配状态计算合法 token，模型 logits 经 mask 后采样，选中 token 更新匹配状态并进入下一轮](/images/strict-json-schema-decoding.svg)

图中两条支路在采样前汇合：模型提供分数，匹配器提供允许集合。选中 token 后，两边都进入下一轮。

## 真正施加约束的位置：logits 到采样之间

设模型在当前前缀下，为词表中的 token 给出分数 $z_i$；匹配器算出的允许集合为 $A$。加入掩码后：

$$
\tilde z_i =
\begin{cases}
z_i, & i\in A \\
-\infty, & i\notin A
\end{cases}
$$

对掩码后的分数做 softmax，非法候选的概率就是零。若忽略其他采样处理，也可以直接从原始概率 $p_i$ 写出新分布：

$$
q_i = \frac{\mathbf{1}[i\in A]p_i}{\sum_{j\in A}p_j}
$$

因此，在同一个前缀下，两个合法候选的概率比保持不变，但它们的绝对概率会因重新归一化而上升。这个过程约束了可选范围，不能判断 `paid` 和 `unpaid` 哪一个符合原文。LLGuidance 的技术说明给出了增量解析器、token 掩码与采样循环。[LLGuidance 实现讲解](https://guidance-ai.github.io/llguidance/llg-go-brrr)

下面用一段教学伪代码串起这些步骤；接口名称是示意，不是某个 SDK 的可运行调用：

```python
compiled = compile_schema(schema, tokenizer)
matcher = compiled.new_matcher()
output_ids = []

for _ in range(max_output_tokens):
    logits = model.next_logits(prompt_ids + output_ids)
    allowed = matcher.allowed_token_mask()

    # 只有完整结果已被文法接受，才允许结束。
    allowed[EOS] = matcher.can_finish()
    logits[~allowed] = -float("inf")
    if not has_finite_candidate(logits):
        raise DecodingError("no legal candidate")

    token = sample(logits)
    if token == EOS:
        return tokenizer.decode(output_ids)

    matcher.accept_token(token)
    output_ids.append(token)

raise IncompleteOutput("output token budget exhausted")
```

实际服务会复用 KV cache，不会像这段伪代码表面上那样每次完整计算全部前缀。`temperature`、top-p 等采样设置可以影响合法候选之间的选择，但最终采样必须保留硬掩码；把温度设成零本身并不能代替文法检查。

## 匹配器检查的是“还能完成”，不是“现在已经完整”

`{"status":"un` 不是一个能被 `JSON.parse` 接受的完整 JSON，却是合法结果的前缀。如果每生成一点就调用普通 JSON 解析器，并把解析失败视为非法，生成会在很早的位置被阻断。

增量匹配器要回答的问题是：**加上这个候选后，是否仍有一条路径能完成目标结构？** 对上面的文法来说，继续写 `paid"}` 可以完成；写一个让所有分支都消失的字符则不行。这是前缀匹配与事后校验的区别。[LLGuidance 的增量解析例子](https://guidance-ai.github.io/llguidance/llg-go-brrr)

还要注意 token 的粒度。token 可能对应一个词片段，也可能同时包含引号、逗号、下一个字段的开头。于是检查某个候选时，必须消费它对应的整段字节或字符序列；不能只看第一个字符是不是合法。实现还需要处理字符串转义和 UTF-8 边界。

这也解释了为什么一个固定的 `logit_bias` 表不够：双引号在某一刻是正确的结束符，在另一刻可能会提前关闭尚未完成的枚举。屏蔽规则要随着解析状态变化。

“每一步都保留可完成的前缀”也不等于“一定在预算内完成”。允许任意长字符串或空白时，输出可以继续延长，直到 token 额度耗尽。格式约束与终止条件是两件需要共同处理的事。

## FSM、CFG 和栈分别负责什么

对于固定枚举或简单正则，可以建立有限状态机 FSM：状态记录已经匹配到哪里，输入推动状态转移。把字符级转移与 tokenizer 词表组合起来，还能提前建立“状态 → 合法 token 集合”的索引。Willard 与 Louf 的论文给出了这种高效引导生成的思路。[Efficient Guided Generation](https://arxiv.org/abs/2307.09702)

递归结构需要记录更多信息。例如树节点的 `children` 里面又有节点，进入一个子对象后，要记住结束时返回到哪里。上下文无关文法 CFG 描述这种递归规则；解析器可以借助栈记录嵌套位置。

有限状态机也能处理预先限定深度的嵌套，只是展开状态可能很大。它无法用有限状态表达任意深度的递归括号匹配。OpenAI 2024 年的公开说明正是以递归结构解释选择 CFG 的原因；不能据此推断所有供应商、所有版本都使用同一种解析器。[OpenAI 对 CFG 与 FSM 的比较](https://openai.com/index/introducing-structured-outputs-in-the-api/)

CFG 也不等于完整 JSON Schema 解释器。Schema 中哪些关键字能转换、怎样处理引用与组合条件，仍取决于具体编译器。`llama.cpp` 的文档就单列了 Schema 转换的支持范围和限制。[Schema 转换范围](https://github.com/ggml-org/llama.cpp/blob/master/grammars/README.md#json-schema--gbnf)

## 性能为什么有时变慢，有时又能省时间

约束引擎新增了两类工作：请求前编译规则，生成过程中计算允许集合。朴素实现如果每一步都遍历整个词表，并为每个候选复制解析状态，开销会很明显。

优化主要是在减少重复检查。XGrammar 的论文把候选区分为可提前检查和需要运行时结合栈状态检查的部分，并通过缓存、持久化栈和与 GPU 推理重叠执行降低成本。这里的“上下文”指文法解析上下文，不是对用户问题的语义理解。[XGrammar 论文](https://arxiv.org/abs/2411.15100)

另一类节省来自固定文本。像键名、冒号和确定的括号，本来就没有选择空间。Jsonformer 采用填入固定结构、让模型生成内容部分的设计；它支持自己的 JSON Schema 子集，不能据此认定所有 `strict` 实现都跳过相同的模型计算。[Jsonformer 源码与说明](https://github.com/1rgs/jsonformer)

所以，仅仅把候选从整个词表缩到几个选项，并不意味着 Transformer 的前向计算按相同比例变少。端到端是否更快，还取决于规则复用、mask 开销、固定路径优化、输出长度，以及省下了多少格式失败后的重试。比较性能时，应分别测首次使用 Schema 和重复使用 Schema 的情况。

## json_schema 和 strict 在 API 的哪一层

以 OpenAI Chat Completions 为例，`response_format` 的结构是：

```json
{
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "order_status",
      "strict": true,
      "schema": {
        "type": "object",
        "properties": {
          "status": {
            "type": "string",
            "enum": ["paid", "unpaid", "unknown"]
          }
        },
        "required": ["status"],
        "additionalProperties": false
      }
    }
  }
}
```

这是请求的格式配置片段，还需与支持此能力的模型和消息一起发送。Responses API 对应的是 `text.format`，其中直接放 `type`、`name`、`strict` 和 `schema`；工具调用则在函数定义上开启严格参数约束。三个入口的字段层级不同，不能原样混用。[API 用法](https://developers.openai.com/api/docs/guides/structured-outputs)

工具参数满足 Schema，只说明模型生成的调用参数符合形状约定。工具由应用执行，订单是否存在、用户是否有权限修改，都仍由应用判断。

按 OpenAI 当前文档，严格模式要求对象设置 `additionalProperties: false`，并将所有属性列入 `required`。允许缺失信息时，可以让字段值接受 `null`；这样键仍存在，值可以表示未知。这些是该接口支持子集的要求，不是 JSON Schema 标准对所有应用的统一要求。[支持的 Schema](https://developers.openai.com/api/docs/guides/structured-outputs#supported-schemas)

SDK 的 Pydantic / Zod 辅助功能主要负责转换类型定义、发送 Schema、解析返回值。真正参与 token 选择的约束位于推理服务。客户端给一个普通文本 API 套上校验和重试，并不能凭空获得服务端的逐 token 控制能力。

## description 为什么仍然有用

下面两个定义表达的约束强度不同：

```json
{"type":"string","description":"订单状态，只能是 paid 或 unpaid"}
```

```json
{"type":"string","enum":["paid","unpaid"]}
```

JSON Schema 中的 `description` 是注释性信息，不是对取值范围的断言。第一份定义从校验角度也允许 `"maybe"`；第二份定义才排除了它。[JSON Schema annotations](https://json-schema.org/understanding-json-schema/reference/annotations)

description 和提示词仍然要解释字段含义，例如“原文明确说已付款才填 paid；缺少依据填 unknown”。这些说明帮助模型把概率分配给适当选项，而 `enum` 负责限制选项集合。硬约束负责可表达的规则，提示与训练负责理解任务，两者各有工作。

## 收到结果后，最后一段链路怎样接

应用处理可以按下面的顺序组织：

```text
请求成功
  → 检查拒绝、截断和其他未完成状态
  → 取出完整结构化结果，解析并校验
  → 核对来源与跨字段业务关系
  → 交给后续业务逻辑
```

流式传输中的一个 chunk 可能只有半个字符串，不能把每个 chunk 都当成完整 JSON。界面可以用增量解析做预览，业务提交则应等待本次响应完成，再走最终校验。[流式结构化输出](https://developers.openai.com/api/docs/guides/structured-outputs#streaming)

还可以给这个订单提取器做几条针对性的检查：原文没有付款信息时是否选择 `unknown`；提示要求增加 `comment` 时是否仍符合 Schema；输出额度不足时是否被识别为未完成。这几条分别检查任务语义、约束是否生效和异常处理，不要把它们合成一个“JSON 成功率”。

回到最初的问题：`json_schema` 把输出要求变成机器可读的规则，`strict` 请求服务严格执行受支持的规则，约束解码再把它们落实为每一步的候选集合。由此得到的是可供程序处理的结构；字段里的答案是否正确，还要由模型能力、输入证据和业务校验共同决定。
