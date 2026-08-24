---
title: "8 张 H20 部署 DeepSeek-V4-Flash 正式版：PD 分离与每周 Token 产能"
published: 2026-08-24T16:30:00+08:00
description: "从公开实测和 SGLang 配置出发，估算 8 张 H20 部署 DeepSeek-V4-Flash-0731 正式版，在 30 并发、每天 9 小时、每周 5 天条件下的输出 token 产能，并拆解 PD 分离的真实边界。"
tags: ["DeepSeek", "SGLang", "H20", "推理部署", "PD分离"]
category: "AI / Infrastructure"
draft: false
---

如果手里有 8 张 H20，目标是长期跑 DeepSeek-V4-Flash，最容易被误导的不是显存容量，而是把“模型能启动”“单请求很快”和“30 并发持续吞吐”当成同一个指标。它们分别对应装载、延迟和容量，计算方式完全不同。

本文最终核算的是**输出 token**，但评测不能只看输出 token/s。条件是每周工作 5 天、每天 9 小时、服务保持满载，客户端最多维持 30 个并发请求。平均输入长度、输出长度、输入吞吐、是否开启 thinking、前缀缓存命中率和硬件 SKU 都会改变结果，所以文中的点估算是预算口径，区间才是部署决策口径。

## 先给结论

如果使用 DeepSeek-V4-Flash-0731 正式版，我会把 8×H20 的生产预算写成：

| 方案 | 可用于预算的稳态输出吞吐 | 每周输出 token | 证据状态 |
| --- | ---: | ---: | --- |
| SGLang，非 PD，官方 0731，统一 TP=8 | 400–600 tok/s | 6480 万–9720 万 | 以公开 H20/SGLang 实测为基线的工程区间 |
| SGLang，PD，4P+4D | 250–500 tok/s | 4050 万–8100 万 | 规划区间，必须用目标版本复测 |

因此，今天可以负责地回答的是：**8×H20、非 PD、正式版、30 并发的合理周产能约为 6480 万–9720 万输出 token；PD 分离先按 4050 万–8100 万预算。**如果压测只跑出 100 tok/s，那么周产能就是 1620 万；如果稳定跑到 700 tok/s，就是 1.134 亿。公式比一个脱离 workload 的“峰值数字”更有用。

## 1. “满血精度”到底指什么

DeepSeek 官方将 V4-Flash 描述为 284B 总参数、每 token 激活约 13B 的 MoE 模型，并支持百万 token 上下文。[1][2] 但“满血”不能直接等同于 BF16。公开的 0731 正式检查点是混合精度打包权重：配置标注 `expert_dtype=fp4`，非 expert 路径含 FP8 E4M3 量化元数据，并带有 DSpark 字段，因此不能简化成纯 FP8 或纯 BF16。[4][13]

本文的主口径是：使用官方 0731 混合精度正式权重，不做 NVFP4、W4 或其他二次量化。这里的“满血”指官方发布权重，不指纯 BF16；0731 检查点约 167 GB，8 张 H20 96GB 的总显存是 768 GB，权重装载本身不是瓶颈。[4][9][10][13]

如果你把“满血精度”严格理解为所有权重都用 BF16，那是另一个未按本文基线验证的目标：需要把权重原始容量粗算为 `284B × 2 bytes ≈ 568 GB`，再加通信缓冲、激活、CUDA Graph、KV cache 和运行时碎片。它可能装得下，但每卡可留给 KV 和批处理的余量会明显变小，尤其是 30 并发和长上下文同时出现时，不能沿用本文正式权重的吞吐预算。实际生产中还要先确认具体 H20 是 96GB 还是 H20-3e 144GB；后者的容量余量不同，不能混算。[9][12]

## 2. 8 张 H20 的瓶颈是 decode，不是“13B 激活参数”

V4-Flash 每 token 只激活约 13B 参数，并不意味着它只需要一张 13B 显卡。MoE 的总权重仍要被分片放置，decode 阶段还要持续读权重、访问 KV cache、执行路由和跨卡通信。公开的 H20 96GB 规格表列出 4.0 TB/s 显存带宽、148 FP16/BF16 TFLOPS；H20 是 Hopper，但不能用 H100/H200 的吞吐数字直接替代。[9][10]

SGLang 对 PD 分离的解释很准确：prefill 偏计算，decode 偏 KV cache 和显存访问。统一引擎会让两类请求争抢同一组调度和显存资源；PD 把它们拆成 Prefill worker 和 Decode worker，再通过 Mooncake 或 NIXL 传输 KV。[5][6] 这能改善资源隔离和长请求尾延迟，但在只有 8 张卡时，拆成 4P+4D 也意味着每一侧只剩 TP=4，并且需要运行两份模型副本。

这就是为什么 PD 不是天然加速开关。它适合“prefill 和 decode 负载比例变化很大、需要独立扩缩容、长上下文排队拖慢短请求”的服务；如果流量主要是短输入、短输出，统一 TP=8 往往更容易把 8 张卡的算力和通信效率吃满。

## 3. 输入性能也必须纳入吞吐口径

输入 token 不会被“生成”出来，因此周产能表仍然只统计 output token；但输入性能会直接决定系统能否维持目标 output tok/s。这里要把四个指标分开：

| 指标 | 含义 | 主要瓶颈 |
| --- | --- | --- |
| input tok/s | Prefill 每秒处理的输入 token 数 | 输入长度、上下文长度、计算吞吐、前缀缓存命中率 |
| output tok/s | Decode 每秒生成的输出 token 数 | 并发、输出长度、显存带宽、KV Cache 容量 |
| request/s | 每秒完成的请求数 | 输入输出长度、排队和调度 |
| TTFT / ITL | 首 token 延迟 / 后续 token 间隔 | Prefill 排队、Decode 争抢、KV 传输和调度 |

在稳定运行时，如果平均完成率为 `λ` 请求/秒，平均每个请求有 `I` 个输入 token、`O` 个输出 token，则：

```text
input tok/s = λ × I
output tok/s = λ × O
total token/s = input tok/s + output tok/s
```

例如 30 个并发请求，平均每个请求输入 8000 token、输出 1000 token，平均从进入到完成需要 60 秒，则完成率约为 `30 ÷ 60 = 0.5 request/s`，对应 4000 input tok/s 和 500 output tok/s。这里的 500 tok/s 才是通常意义上的模型生成产能；4000 input tok/s 是系统必须承受的 Prefill 处理量，不能漏掉。

因此，前文的“400–600 output tok/s”必须理解为带有 workload 条件的区间，而不是脱离输入长度的硬件常数。如果只给出“30 并发”而不固定输入长度、输出长度和缓存命中率，就不能复现一个有意义的吞吐数字。NVIDIA 的分离式服务文档也把 Prefill 的压力归因于输入长度、上下文和提示词复用，把 Decode 的压力归因于并发、输出长度和活跃 KV Cache。[21]

输入负载还决定 PD 是否值得使用。非 PD 中，长 Prefill 会与正在生成的请求争抢同一组调度、计算和显存资源，可能拖高 Decode 的 ITL 和 p99；PD 可以把 Prefill 和 Decode 分到不同 GPU 池，并分别扩容，但需要额外传输 KV Cache。低并发或短输入时，传输和 GPU 池切分可能抵消收益；长输入、输入长度波动大、又需要稳定 TTFT/ITL 时，PD 的资源隔离价值更明显。[21][22]

所以 8×H20 的验收不能只记录聚合 output tok/s，至少应同时记录：

```text
input tok/s、output tok/s、request/s
TTFT、平均 ITL、p95/p99 ITL
输入长度、输出长度、并发数、前缀缓存命中率
GPU 利用率、KV Cache 使用率、PD 场景的 KV 传输耗时
```

测试矩阵建议固定为 1K/4K/8K/32K 输入，512/2K/8K 输出，并将并发从 1、8、16、30 逐级提高。最终比较的是相同输入输出分布下的 output tok/s、input tok/s 和 p99 延迟，而不是把不同 workload 的“总 token/s”直接排名。周产能公式仍为：

```text
周输出 token = 162000 × R
R = 真实压测得到的聚合 output tok/s
```

如果业务还需要计费或带宽口径的总 token，则另行计算 `input tok/s + output tok/s`，不要把它与模型生成产能混写。

## 4. 非 PD：公开 H20/SGLang 数据能支撑什么

目前最接近本问题的公开现场数据，是一份在 8×H20 96GB 上对 DeepSeek-V4-Flash-0731 的部署记录。它的 SGLang 结果是：128 input / 64 output、并发 8 时，输出吞吐 480.99 tok/s；4096 input / 128 output、并发 4 时，输出吞吐 531.47 tok/s。[11] 这不是 30 并发的实测，也不是任意上下文长度都能复现的保证，但足以说明 8×H20 的整机级输出吞吐大约处于数百 tok/s，而不是简单用单卡速度乘 8。

把并发从 8 提到 30，不能把 480.99 直接乘以 30。连续批处理在并发增加后会先提升设备利用率，随后进入显存带宽、MoE 通信、KV cache 或调度瓶颈；曲线会变平，首 token 延迟则继续上升。因此我把非 PD 的预算区间放在 400–600 tok/s：下沿覆盖长输出、thinking、缓存命中率低或版本略旧的情况，上沿覆盖短到中等输入、充分 warmup、CUDA Graph 和合适 kernel 都正常的情况。这是基于公开实测的工程推断，不是新的现场测量。

SGLang 的公开 V4 benchmark 还给出了 H200 上的参考点：V4-Flash FP4、balanced 策略、并发 64 时，单卡报告 3072 output tok/s。[7] 这个数字只用来说明高端 H200 的基准位置，不能拿来给 H20 做线性换算；硬件、量化格式、并发、版本和测试策略都不同。

## 5. PD：为什么公开结果看起来会慢很多

同一份 H20 部署记录还测试了单节点 4P+4D。短请求 128/64、并发 8 时，4P+4D 只有 65.85 tok/s；4096/128、并发 4 时是 33.63 tok/s。[11] 这组数字不能被解读为“PD 在 H20 上只有 30–70 tok/s”，因为测试同时关闭了 DSpark 和 CUDA Graph，而且从一个 TP=8 引擎改成了两个 TP=4 引擎。作者也明确指出，主要损失来自这两个改变，而不是 NIXL 本身。[11]

但这组结果仍然有工程价值：它展示了 PD 的失败模式。只打开 Prefill/Decode 角色、让两侧各跑一份模型、关闭图捕获和 speculative decoding，然后用一个并发代理压测，PD 很容易因为 TP 变小、重复权重、代理排队和额外 KV 交接而掉到统一部署的一个小分数。SGLang 文档要求分别启动 `--disaggregation-mode=prefill` 和 `--disaggregation-mode=decode`，并配置传输后端；这不是一个可以在单进程里“顺手打开”的开关。[5][6]

在目标 workload 还没跑通之前，我建议 PD 先按非 PD 的 60%–85% 做容量预算。因此，当非 PD 按 400–600 tok/s 预算时，PD 的规划区间约为 250–500 tok/s，对应每周 4050 万–8100 万输出 token。这个比例是容量规划假设，不是公开 benchmark 结论；如果业务以超长输入为主，PD 的收益可能体现在 TTFT 和尾延迟，而不是周输出 token。

## 6. 正式版的复现边界：权重、随附模块与运行时要一起固定

DeepSeek-V4-Flash-0731 正式版不是一个只写下模型名就能复现的数字。公开配置显示它是混合精度正式权重，并注明它携带 DSpark；SGLang 的 V4 配置也把正式版与随附的 speculative decoding 路线分开列出。[4][8][13] 因此，压测时必须固定 checkpoint、SGLang 版本、Hopper kernel、KV dtype、Graph capture、上下文长度和是否使用随附模块。

公开 H20 数据中，SGLang 结果来自特定版本和 warmup，C=8 与 4K 请求还存在波动。[11] 这意味着“正式版”只能保证模型和权重口径一致，不能替代对运行时的验收。第一次启动完成也不等于所有真实 batch shape 都完成 JIT 或 CUDA Graph 捕获；上线前应覆盖 30 并发、常见输入输出长度、thinking 和工具调用。

本文的周产能公式仍然是：

```text
周输出 token = 162000 × R
R = 经过真实压测验证的聚合输出 tok/s
```

正式版的随附模块是否开启，应作为一个单独的 A/B 变量记录；不能把开启和关闭、不同版本、不同 KV 配置的结果混成同一个“模型速度”。

## 7. 一周到底能产出多少

每天 9 小时、每周 5 天，工作时间是 45 小时，也就是 162000 秒。因此每增加 100 tok/s 稳态输出吞吐，周产能就增加 1620 万输出 token：

| 稳态聚合输出 | 每天 9 小时 | 每周 5 天 |
| ---: | ---: | ---: |
| 100 tok/s | 324 万 | 1620 万 |
| 300 tok/s | 972 万 | 4860 万 |
| 400 tok/s | 1296 万 | 6480 万 |
| 500 tok/s | 1620 万 | 8100 万 |
| 600 tok/s | 1944 万 | 9720 万 |
| 900 tok/s | 2916 万 | 1.458 亿 |

这里的“30 并发”是最多 30 个未完成请求，不是 30 req/s。假设平均每个请求输出 512 token，那么 500 tok/s 约等于每秒完成 0.98 个请求；若平均输出只有 128 token，同样的 token 吞吐会完成约 3.9 req/s。想从 token 产能换算请求数，必须再给出平均输出长度。

如果要计算输入+输出总 token，还要把平均输入长度纳入模型。以 500 tok/s 输出为例，若每个请求平均输入 4096、输出 512，则输入/输出比为 8:1，计费或带宽口径的总 token 可能远高于 8100 万；但“模型生成能力”通常应报告 output tok/s，二者不要混写。

## 8. 和其他模型、其他机器的并发吞吐对比

为了知道我们的预算处在什么位置，我又补了一组公开并发评测。下表把他们的吞吐统一换算成“每周 5 天、每天 9 小时”的周产能等价；这只是把数字放到同一把尺子上，不代表这些评测真的连续工作 45 小时，也不代表模型能力、成本和精度相同。

| 模型与机器 | 并发与 workload | 公开吞吐（tok/s） | 按 45 小时换算的周产能 | 说明 |
| --- | --- | ---: | ---: | --- |
| 我们：V4-Flash，8×H20，非 PD | C=30，真实 workload 待测 | 400–600 | 6480 万–9720 万 | 生产规划区间 |
| 我们：V4-Flash，8×H20，PD 4P+4D | C=30，真实 workload 待测 | 250–500 | 4050 万–8100 万 | 生产规划区间 |
| Qwen3-235B-A22B，8×H100 | C=500，4K input / 200 output | 931.21 | 1.5086 亿 | vLLM 现场 benchmark [14] |
| DeepSeek-V3/R1 671B，8×H100 | 约 C=100，1024 input / 256 output | 约 620 | 1.0044 亿 | 独立现场 benchmark [16] |
| Llama-3.1-70B，4×H100 | C=100，1000 input / 1000 output | 3794.76 | 6.1475 亿 | NVIDIA NIM，dense 70B [15] |
| GPT-OSS-120B，2×H100 | C=32，100 input / 1000 output | 3023.03 | 4.8973 亿 | Oracle token-level throughput，方向性参照 [18] |
| Qwen2.5-72B AWQ，1×L20 | C=10，约 512 input / 256 output | 108.84 | 1763.2 万 | 24 小时持续压测 [19] |

这张表不能拿来做简单的“谁更快”排名。Llama-3.1-70B 是 dense 70B，GPT-OSS-120B 的指标命名是 token-level throughput，Qwen2.5-72B 还是 AWQ 单卡路径；它们与 V4-Flash 的总参数、激活参数、权重格式、并行方式和 serving runtime 都不一致。[15][18][19] 更合理的读法是：8×H20 的非 PD 预算 400–600 tok/s，低于 8×H100 上 Qwen3-235B 的 931 tok/s，接近 8×H100 上超大 DeepSeek V3/R1 的约 620 tok/s；考虑到 GPU、版本和 workload 差异，这个区间是保守的容量规划，不是离谱的低估。[14][16]

并发也会改变结论。Qwen3-235B 的 931.21 tok/s 是 C=500 的高并发点；DeepSeek V3/R1 的公开记录则显示 C≈100 后输出吞吐基本见顶，继续加并发主要会把等待时间分摊给更多用户。[14][16] 这正是我们的 C=30 不能直接套用 C=8 结果的原因：要同时看 aggregate output tok/s、每用户 TPOT、TTFT 和 p95/p99。

还有一个适合做硬件敏感性参照的结果：SemiAnalysis InferenceX 在 DeepSeek R1 0528、8K/1K FP8、97 tok/s/user 的交互目标下，给出 H100 154.3 tok/s/chip、H200 500.1 tok/s/chip；页面明确说明这是从真实 benchmark 数据插值得到的 operating point，不是固定并发的一次性实测。[17] 它说明 H200 的显存带宽会显著改变大模型吞吐，但不能把单 chip、每用户交互指标直接乘成我们的 8 卡 aggregate 产能。

NVIDIA 还为 Qwen3-235B-A22B 定义了一个很适合复刻的统一 workload：16×H100/H200、4K input / 200 output、C=32，同时测试 aggregated 与 disaggregated；不过该页面发布的是拓扑和压测模板，没有给出可直接引用的 output tok/s。[20] 我们可以借用这个思路，把自己的验收矩阵固定为 4K/200、C=32 附近，再补上真实业务分布，最后比较非 PD 与 4P+4D 的吞吐和尾延迟。

从部署决策看，我会保留三档：短中等输入、缓存命中正常时按非 PD 600 tok/s、9720 万/周做上沿预算；生产承诺按 500 tok/s、8100 万/周；thinking、长上下文或缓存命中差时按 400 tok/s、6480 万/周。PD 方案则先按 250 tok/s、4050 万/周做保守预算，只有在 30 并发的 p99 TTFT/TPOT 和独立扩缩容收益明确改善后，才上调到 400–500 tok/s。

## 最终建议：先做四格压测，再决定是否 PD

第一格是统一 TP=8、官方 0731、固定随附模块开关，分别压 128/64、4K/128 和真实业务分布；第二格在相同版本和相同请求上把并发阶梯跑到 8、16、30、48，记录 output tok/s、TTFT、TPOT、p95/p99、失败率和显存水位。第三格才是 4P+4D，Prefill 和 Decode 使用一致的 kernel、CUDA Graph、KV dtype 和 warmup，避免把“PD”与“关闭优化”混成一个变量。

我会把上线门槛写成：在真实请求分布、30 并发、连续 30 分钟压测中，非 PD 的 p99 TPOT、错误率和显存水位达标后，才把 400–600 tok/s 作为产能区间；PD 只有在长请求尾延迟或可独立扩缩容的收益足够大时才值得牺牲部分周 token 产能。

## 参考资料

[1] [DeepSeek V4 Preview announcement](https://deepseek.com/en/news/v4-preview/)

[2] [DeepSeek-V4-Flash model card](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash)

[3] [DeepSeek V4 model card PDF](https://fe-static.deepseek.com/chat/transparency/deepseek-V4-model-card-EN.pdf)

[4] [vLLM recipes: DeepSeek-V4-Flash](https://github.com/vllm-project/recipes/blob/main/models/deepseek-ai/DeepSeek-V4-Flash.yaml)

[5] [SGLang PD disaggregation guide](https://github.com/sgl-project/sglang/blob/main/docs/docs/advanced_features/pd_disaggregation.mdx)

[6] [SGLang server arguments](https://docs.sglang.io/docs/advanced_features/server_arguments)

[7] [SGLang DeepSeek V4 benchmark configuration](https://github.com/sgl-project/sglang/blob/main/docs/src/snippets/configs/deepseek-ai/deepseek-v4-benchmarks.jsx)

[8] [SGLang DeepSeek V4 serving configuration](https://github.com/sgl-project/sglang/blob/main/docs/src/snippets/configs/deepseek-ai/deepseek-v4.jsx)

[9] [NVIDIA H20 vGPU documentation](https://docs.nvidia.com/ai-enterprise/release-6/6.2/appendix/vgpu.html)

[10] [NVIDIA H20 96GB specification sheet](https://flopper.io/gpu/nvidia-h20-96gb/spec-sheet.pdf)

[11] [DeepSeek-V4-Flash-0731 H20 deployment benchmark](https://aik8s.run/ai-k8s/practices/deepseek-v4-flash-h20-evaluation/)

[12] [SGLang issue: V4 Flash H20 cache behavior](https://github.com/sgl-project/sglang/issues/35129)

[13] [DeepSeek-V4-Flash-0731 raw configuration](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash-0731/raw/main/config.json)

[14] [GPUStack: Qwen3-235B-A22B on 8×H100](https://docs.gpustack.ai/2.0/performance-lab/qwen3-235b-a22b/h100/)

[15] [NVIDIA NIM LLM performance benchmarks](https://docs.nvidia.com/nim/benchmarking/llm/1.0.0/performance.html)

[16] [DeepSeek-V3/R1 671B on 8×H100 throughput benchmark](https://github.com/dzhsurf/deepseek-v3-r1-deploy-and-benchmarks)

[17] [SemiAnalysis InferenceX: DeepSeek R1 H100 vs H200](https://inferencex.semianalysis.com/compare/deepseek-r1-h100-vs-h200)

[18] [Oracle OCI: GPT-OSS-120B benchmark](https://docs.oracle.com/en-us/iaas/Content/generative-ai/benchmark-openai-gpt-oss-120b.htm)

[19] [llm-quant-bench external serving comparisons](https://github.com/yinli-systems/llm-quant-bench)

[20] [NVIDIA Dynamo: Qwen3-235B-A22B FP8](https://docs.nvidia.com/dynamo/dev/recipes/qwen3-235b-a22b-fp8)

[21] [NVIDIA Dynamo: Disaggregated Serving Overview](https://docs.nvidia.com/dynamo/kubernetes/disaggregated-serving/overview)

[22] [NVIDIA Dynamo: Disaggregated Serving Architecture](https://docs.nvidia.com/dynamo/dev/knowledge-base/concepts/system-architecture/disaggregated-serving)
