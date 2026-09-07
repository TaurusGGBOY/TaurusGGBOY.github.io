---
title: "调整 thinking effort 后，推理链路到底变了什么？"
published: 2026-09-07T16:00:00+08:00
updated: 2026-09-07T17:22:00+08:00
description: "从 effort 控制量一路算到推理 token、上下文长度、decode FLOPs、KV cache、延迟、计费与答案截断。"
tags: ["llm", "reasoning", "thinking", "inference", "transformer"]
category: "AI / Architecture"
lang: "zh_CN"
draft: false
---

同一个模型，把 thinking effort 从 low 调到 high，权重通常没有变化。真正改变的是这次请求的**生成策略与停止边界**，它们先改变推理段的长度与路径，再把差异传导到后续每一个 token 的计算。

把链路压缩成一行：

```text
effort e
  → 推理策略 / 停止规则
  → 实际推理长度 R 与轨迹 r₁…rᴿ
  → 最终答案 a₁…aᴬ
  → 总 decode 步数 T = R + A
  → FLOPs、KV cache、延迟、输出额度与费用
```

本文只算这条链。训练史、界面设计、思维链是否展示等问题，除非会改变公式，否则不展开。

## 第一步：effort 改变的是条件分布，不是参数

设模型参数为 \(\theta\)，输入为 \(x\)，effort 为 \(e\)，生成序列为 \(z=(r,a)\)。第 \(t\) 步仍然是一次普通的自回归采样：

$$
p_\theta(z_t\mid x,e,z_{<t})
=\operatorname{softmax}(\ell_\theta(x,e,z_{<t}))_{z_t}.
$$

从 low 改成 high 时，\(\theta\) 不动；变化的是条件 \(e\)，以及服务端可能随 \(e\) 选择的停止规则。于是 logits、采到的 token、后续上下文都可能从第一步开始分叉。

这里有两类实现，必须分开：

1. **软控制**：把 effort 编码进提示、控制 token 或模型条件，使停止时间 \(\tau_e(x)\) 的分布改变。high 往往更容易继续拆解、复核或回溯，但并不保证生成固定数量的 token。
2. **硬控制**：解码器直接设置推理段预算 \(B_e\)，到上限便插入或强制接受结束推理的标记。简化后可写成

$$
R=\min\bigl(\tau_e(x),B_e\bigr).
$$

两者也可以叠加。公开的 s1 `budget forcing` 就展示了硬干预：模型想结束时抑制结束标记并追加 “Wait”，或在达到上限时强制结束推理。[s1 论文 §3.1](https://arxiv.org/html/2501.19393v1#S3.SS1) 但这只能证明“可以这样控制”，不能反推任何闭源产品的 high 都等于某个 \(B_e\)。社区复现实验也发现，相同干预在不同模型上可能提升、平台期甚至退化。[ICLR Blogposts 复现实验](https://iclr-blogposts.github.io/2026/blog/2026/wait-do-we-need-to-wait/)

因此，用户能观察或统计的是 \(R\)，不是 effort 标签本身。后面的数学都从实际的 \(R\) 开始。

## 第二步：多出的推理 token 会进入后续每一步

假设输入有 \(N\) 个 token，模型先生成 \(R\) 个推理 token，再生成 \(A\) 个答案 token：

$$
z=(r_1,\ldots,r_R,a_1,\ldots,a_A),\qquad T=R+A.
$$

第一个答案 token 不是只看原问题，而是看长度为 \(N+R\) 的前缀：

$$
p(a_1\mid x,e)=\sum_r p_\theta(r\mid x,e)\,p_\theta(a_1\mid x,r,e).
$$

这个式子同时说明 high 的潜在收益与风险：它改变了模型在推理轨迹 \(r\) 上的概率质量。多出来的轨迹可能包含有效分解与纠错，也可能把原本正确的路径带偏。effort 不是给同一个答案“多算几遍”，而是在改变通向答案的路径分布。

![effort 先改变生成策略和停止条件，推理段随后成为最终答案的上下文；总输出耗尽时可能没有答案](/images/posts/llm-thinking-effort/control-flow.svg)

图中最重要的箭头是“推理序列 → 最终答案”：每个 \(r_i\) 都先被写入 KV cache，后面的 \(r_{i+1}\) 和 \(a_j\) 才能注意到它。

## 第三步：精确到一次 decode forward 的 FLOPs

下面采用一个可复算的一阶模型：batch size 为 1、dense decoder-only Transformer、标准 multi-head attention、KV cache 开启；一次乘法加一次加法按 2 FLOPs 计。忽略 softmax、归一化、激活函数和采样等低阶项。

记：

- \(P\)：每个 token 实际激活的非 embedding 参数量；dense 模型近似等于参数量，MoE 应换成 active parameters；
- \(L\)：Transformer 层数；
- \(d\)：hidden size；
- \(S\)：当前 decode forward 能注意到的 token 总数，包含这一步新送入模型的 token。

一次 decode 主要有两块计算。

**参数矩阵计算。** 当前 token 依次经过各层的 Q/K/V/O 投影和 FFN。每个权重对当前 token 大致参与一次乘加：

$$
C_{\text{weights}}\approx 2P.
$$

**对 KV cache 的注意力。** 每层中，当前 query 与 \(S\) 个 key（历史 cache 加当前 token）做点积约需 \(2Sd\) FLOPs；注意力权重再乘 value 约需 \(2Sd\) FLOPs。共 \(L\) 层：

$$
C_{\text{attn}}(S)\approx 4LSd.
$$

所以生成一个新 token 的计算量近似为：

$$
\boxed{C_{\text{token}}(S)\approx 2P+4LSd}
$$

KV cache 省掉的是对旧 token 的 K/V 投影重算，却没有让历史消失。上下文每增长 1，下一步仍要多读并注意一个位置。关于 \(2P\) 与 KV cache 的矩阵推导，可对照 [Transformer Inference Arithmetic](https://kipply.github.io/blog/transformer-inference-arithmetic/) 和 [LLM Inference from First Principles](https://mlkan.substack.com/p/llm-inference-from-first-principles)。

## 第四步：把整段 reasoning 与答案加总

prefill 一次性处理 \(N\) 个输入 token，并直接给出第一个生成 token 的 logits。此后，已采样的第 \(j\) 个 token 被送回模型，才得到第 \(j+1\) 个 token 的 logits。因此，生成 \(T=R+A\) 个 token 需要 **1 次 prefill 加 \(T-1\) 次单-token decode forward**，不是 \(T\) 次 decode。

第 \(j\) 次 decode forward（\(j=1,\ldots,T-1\)）能注意到 \(S_j=N+j\) 个 token。只加总 decode：

$$
\begin{aligned}
C_{\text{decode}}(T)
&\approx\sum_{j=1}^{T-1}\left[2P+4Ld(N+j)\right]\\
&=2P(T-1)+4Ld\left[(T-1)N+\frac{T(T-1)}{2}\right].
\end{aligned}
$$

输入和模型相同，则 prefill 是 low 与 high 的共同项，做差时抵消。decode 的第一项随生成长度线性增长；第二项包含 \(T(T-1)/2\)，因为越晚执行的 forward 面对越长的历史。于是“thinking token 增加 \(k\) 倍”不等于“总计算恰好增加 \(k\) 倍”。

若 effort 调高后多生成 \(\Delta\) 个推理 token，而答案长度暂时不变，从原来的 \(T\) 增长到 \(T+\Delta\)，额外计算为：

$$
\boxed{
\Delta C
\approx 2P\Delta
+4Ld\left[\Delta(N+T)+\frac{\Delta(\Delta-1)}{2}\right]
}
$$

括号中的第一部分，是新增 token 都要看原有 \(N+T\) 个位置；第二部分，是这些新增 token 彼此又形成了一个逐步增长的三角形。

## 第五步：算一个 low → high 的完整例子

取一个便于复算的假想 dense 模型：

| 量 | 数值 |
| --- | ---: |
| 参数 \(P\) | \(7\times10^9\) |
| 层数 \(L\) | 32 |
| hidden size \(d\) | 4096 |
| 输入 \(N\) | 2048 tokens |
| 最终答案 \(A\) | 512 tokens |
| low 的实际推理 \(R_l\) | 512 tokens |
| high 的实际推理 \(R_h\) | 4096 tokens |

注意：512 与 4096 是为了演算而设的**实际观测长度**，不是任何厂商对 low/high 的承诺。

low 时 \(T_l=512+512=1024\)：

$$
\begin{aligned}
C_l
&\approx 2(7\times10^9)(1023)\\
&\quad+4(32)(4096)\left[1023(2048)+\frac{1024\times1023}{2}\right]\\
&=14.322\ \text{TFLOPs}+1.373\ \text{TFLOPs}\\
&=15.695\ \text{TFLOPs}.
\end{aligned}
$$

high 时 \(T_h=4096+512=4608\)：

$$
\begin{aligned}
C_h
&\approx 2(7\times10^9)(4607)\\
&\quad+4(32)(4096)\left[4607(2048)+\frac{4608\times4607}{2}\right]\\
&=64.498\ \text{TFLOPs}+10.512\ \text{TFLOPs}\\
&=75.010\ \text{TFLOPs}.
\end{aligned}
$$

结果是：推理段从 512 增到 4096，变成 8 倍；但因为 512-token 答案固定存在，总生成长度从 1024 增到 4608，是 4.5 倍；再加上后段注意力面对更长历史，decode 近似计算量从 15.695 增到 75.010 TFLOPs，是 **4.779 倍**，额外增加 **59.315 TFLOPs**。共同的 prefill 未计入这两个数；若计入，两档的比值会更接近 1，但差值不变。

在这一演算中，“调高 effort”使模型多执行了 3584 个串行 decode forward，并且越靠后的 forward 越贵；并不是某个抽象的思考模块临时变强。

## 第六步：KV cache 增长多少

标准 multi-head attention 中，每层、每个 token 都要保存一份 key 和一份 value。设 KV 元素精度为 \(b\) bytes，则：

$$
M_{\text{KV/token}}=2Ldb.
$$

例子使用 BF16，即 \(b=2\)：

$$
2\times32\times4096\times2
=524{,}288\ \text{bytes}
=0.5\ \text{MiB/token}.
$$

生成最后一个 token 时无需再把它送回模型，因此响应刚结束时，cache 中通常有 \(N+T-1\) 个位置；若服务为后续续写保留最后一个 token，则是 \(N+T\)。按前一种口径，low 的 cache 长度为 3071：

$$
3071\times0.5\ \text{MiB}=1535.5\ \text{MiB}\approx1.500\ \text{GiB}.
$$

high 的 cache 长度为 6655：

$$
6655\times0.5\ \text{MiB}=3327.5\ \text{MiB}\approx3.250\ \text{GiB}.
$$

只改 effort，这个请求的峰值 KV cache 就增加了 **1.75 GiB**。如果模型使用 GQA/MQA，应把 \(d\) 换成 KV heads 的总宽度 \(H_{kv}d_h\)：

$$
M_{\text{KV/token}}=2L H_{kv}d_h b.
$$

所以 GQA 会显著改变内存常数，却不改变“每多一个推理 token，cache 线性增长；后续注意力历史变长”这条链。[KV cache 内存推导](https://mbrenndoerfer.com/writing/kv-cache-memory-calculation-llm-inference-gpu)

## 第七步：为什么 FLOPs、延迟和费用不是同一个倍率

FLOPs 是工作量，延迟还取决于硬件与服务方式。batch 为 1 时，一次 decode 往往需要读取大量权重，可能受显存带宽而非峰值算力限制。一个一阶下界是：

$$
t_j\gtrsim\max\left(
\frac{2P+4LS_jd}{F_{\text{eff}}},
\frac{Pb_w+2LdS_jb}{B_{\text{eff}}}
\right),
$$

其中 \(F_{\text{eff}}\) 是有效 FLOP/s，\(B_{\text{eff}}\) 是有效显存带宽，\(b_w\) 是权重字节数。实际服务还会加入 batching、张量并行通信、调度排队、分页 KV、量化与推测解码，因此不能拿 4.779 直接断言墙钟时间也恰好变成 4.779 倍。[prefill/decode 与带宽分析](https://jamwithai.substack.com/p/llm-inference-101)

计费则通常更接近 token 账本。若输入单价为 \(p_{in}\)，输出侧把隐藏推理与可见答案都按 \(p_{out}\) 计费，单次费用可写成：

$$
\text{cost}=\frac{Np_{in}+(R+A)p_{out}}{10^6}.
$$

若 \(A\) 不变，low 调到 high 的增量就是：

$$
\Delta\text{cost}=\frac{(4096-512)p_{out}}{10^6}
=0.003584p_{out}.
$$

例如仅为演算，若 \(p_{out}=10\) 美元/百万 token，增量为 0.03584 美元。实际是否把 reasoning tokens 计入输出、如何定价，以具体服务的当期规则为准。

## 第八步：high 还可能挤掉答案

设一次响应的总生成上限为 \(M\)，格式或工具协议占用 \(O\) 个 token，那么留给最终答案的最大空间是：

$$
A_{\max}=\max(0,M-R-O).
$$

若 \(M=5000\)、\(O=100\)：

- low 的 \(R=512\)，还剩 \(4388\) 个答案 token；
- high 的 \(R=4096\)，只剩 \(804\) 个答案 token。

如果任务原本需要 1200 个 token 才能完整作答，high 路径会在数学上必然截断，除非服务把“推理预算”和“总输出上限”分开管理或提前收尾。结束 thinking 与结束整个 response 是两个不同的停止事件。

## 最后：真正该比较的是整条函数

对同一批任务，effort 的有效性应记录成：

$$
e\longmapsto
(R,A,C_{\text{decode}},M_{\text{KV}},t,\text{cost},\text{correct}).
$$

只看回答是否更长，会漏掉隐藏推理；只看 reasoning tokens，会漏掉答案被挤压；只看 FLOPs，会漏掉显存带宽与排队；只看正确率，又看不出同样收益付出了多少计算。

调整 thinking effort 后，最先变的是生成轨迹与停止时间，随后才是可精确计算的系统后果。对固定权重的模型，high 的本质不是“临时获得更多参数”，而是允许或迫使这一次请求走过更多串行 token；这些 token 既是后续推理的上下文，也是 FLOPs、KV cache、延迟、额度和费用的共同来源。至于它们有没有换来更高正确率，只能由同任务、同工具、重复采样的评测回答，不能由 effort 标签本身保证。
