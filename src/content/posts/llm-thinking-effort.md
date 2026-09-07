---
title: "Thinking effort 如何训练，又怎样改变推理链路？"
published: 2026-09-07T16:00:00+08:00
updated: 2026-09-07T18:30:00+08:00
description: "从 SFT、RL 与停止率的训练目标，算到运行时推理 token、decode FLOPs、KV cache、延迟、计费与答案截断。"
tags: ["llm", "reasoning", "thinking", "inference", "transformer"]
category: "AI / Architecture"
lang: "zh_CN"
draft: false
---

thinking effort 不是一个只在解码器里临时打开的“深度思考开关”。训练先塑造模型在不同条件下如何展开推理、何时停止；部署后，同一个模型再根据本次请求的 effort 改变生成分布与停止边界。权重在请求期间通常不变，但生成轨迹会变，差异随后传导到每一个 token 的计算。

把链路压缩成一行：

```text
训练数据、奖励与模式标签
  → 学到 pθ(推理轨迹, 答案 | 问题, effort)
  → 请求传入 effort e
  → 推理策略 / 停止规则
  → 实际推理长度 R 与轨迹 r₁…rᴿ
  → 最终答案 a₁…aᴬ
  → 总 decode 步数 T = R + A
  → FLOPs、KV cache、延迟、输出额度与费用
```

本文只分析这条链：训练阶段究竟学了什么，运行时调整 effort 后又怎样变成可计算的 FLOPs、KV cache、延迟、费用和答案空间。界面设计与思维链是否展示不在讨论范围内。

## 第一步：训练不等于预制 low、medium、high 三种长度

设训练样本为 \((x,e,z,y)\)：\(x\) 是问题，\(e\) 是 effort 或思考模式，\(z=(z_1,\ldots,z_R)\) 是推理轨迹，\(y=(y_1,\ldots,y_A)\) 是答案。监督微调可以优化：

$$
\mathcal L_{\mathrm{SFT}}(\theta)
=-\sum_{t=1}^{R+A}
\log p_\theta(u_t\mid x,e,u_{<t}),
\qquad u=(z,y).
$$

如果样本包含 `/think`、`/no_think` 或 low/high 等条件，模型就能学习不同的条件分布 \(p_\theta(z,y\mid x,e)\)。如果样本只有长思维链而没有 effort 条件，它学到的是“怎样继续推理”，并不会自动得到一个可靠的三档旋钮。

长度差异可以更精确地写成**结束推理的条件概率**。定义第 \(t\) 步的停止率：

$$
h_t(e)=P_\theta(R=t\mid R\ge t,x,e)
=P_\theta(\texttt{</think>}\mid x,e,z_{<t}).
$$

那么推理长度超过 \(t\) 的概率以及期望长度分别是：

$$
P(R>t\mid x,e)=\prod_{k=1}^{t}\bigl(1-h_k(e)\bigr),
$$

$$
\boxed{
E[R\mid x,e]
=\sum_{t=0}^{\infty}P(R>t\mid x,e)
=\sum_{t=0}^{\infty}\prod_{k=1}^{t}\bigl(1-h_k(e)\bigr)
}.
$$

所以“high 的思维链更长”在概率上意味着：相同问题和已有轨迹下，high 在一段位置上的 \(h_t\) 更低，或者解码器暂时不接受结束标记。它不要求训练集里恰好存在 512、2048、4096 token 三套一一对应的答案。

公开方案恰好说明了三种不同做法：

1. **直接准备模式数据。** Qwen3 的 Thinking Mode Fusion 混合 thinking 与 non-thinking 数据，并在训练请求中加入 `/think` 和 `/no_think`。non-thinking 样本仍保留空的 `<think></think>` 块。报告同时说明，中间预算是在模型学会两种模式后，通过阈值处停止并注入收尾指令实现的；它没有为每一个中间长度单独训练一档。[Qwen3 Technical Report §4.3](https://arxiv.org/html/2505.09388v1#S4.SS3)
2. **不先提供长度档，用结果奖励让长推理涌现。** DeepSeek-R1-Zero 从 base model 直接做强化学习，没有先做 reasoning SFT。训练模板只要求先推理再回答，没有规定反思方式；随着 RL 进行，更长推理、反思和自我纠错逐渐出现。[DeepSeek-R1 §2.2](https://arxiv.org/html/2501.12948v1#S2.SS2)
3. **训练长推理能力，运行时再强控长度。** s1 用 1000 条精选推理样本微调；推理时抑制结束标记并追加 “Wait” 来延长，或插入结束标记来缩短。这里的长度控制主要发生在解码阶段。[s1 §3.1](https://arxiv.org/html/2501.19393v1#S3.SS1)

因此，准备不同长度的思维链**可以**帮助模型学习 effort 条件，但不是唯一办法，也不是所有公开系统的共同前提。真正需要训练的是轨迹分布和停止行为；精确预算还可以留给运行时。

### 强化学习具体更新了什么

以 DeepSeek-R1-Zero 使用的 GRPO 为例。对同一道题采样 \(G\) 条完整输出 \(o_1,\ldots,o_G\)，得到奖励 \(r_1,\ldots,r_G\)，组内标准化优势为：

$$
A_i=\frac{r_i-\operatorname{mean}(r_1,\ldots,r_G)}
{\operatorname{std}(r_1,\ldots,r_G)}.
$$

令旧策略到新策略在第 \(t\) 个 token 上的概率比为

$$
\rho_{i,t}(\theta)=
\frac{\pi_\theta(o_{i,t}\mid q,o_{i,<t})}
{\pi_{\theta_{\mathrm{old}}}(o_{i,t}\mid q,o_{i,<t})},
$$

省略论文中的 KL 正则细节后，裁剪目标的核心项是：

$$
J_{\mathrm{GRPO}}(\theta)
=\frac1G\sum_{i=1}^{G}\frac1{|o_i|}\sum_{t=1}^{|o_i|}
\min\!\left(
\rho_{i,t}A_i,
\operatorname{clip}(\rho_{i,t},1-\varepsilon,1+\varepsilon)A_i
\right).
$$

假设同一道数学题采样出两条轨迹：300-token 的轨迹过早结束且答错，奖励为 0；900-token 的轨迹先犯错、随后复核并答对，奖励为 1。后者的 \(A_i\) 为正，训练会提高其轨迹中各 token 的相对概率；前者的 \(A_i\) 为负，概率被压低。模型学到的是“这种展开、检查与停止方式更可能得到奖励”，不是机械记忆“正确答案必须写到 900 token”。

如果只奖励正确性，更长轨迹只要提高成功率就可能被保留。若训练者希望显式交换正确率与计算成本，可以定义：

$$
r_i'=r_{\mathrm{correct},i}-\lambda |o_i|,
$$

其中 \(\lambda\) 是每个生成 token 的成本。两条正确轨迹相差 \(\Delta L\) 个 token 时，长轨迹只有带来超过 \(\lambda\Delta L\) 的其他奖励增益才占优。不过 DeepSeek-R1-Zero 公开的主要奖励是准确率和格式奖励，并没有采用这里这个长度惩罚；该式只是说明怎样把预算写进训练目标，不能当作其训练细节。

训练阶段由此可以分为三个互不等价的问题：SFT 或蒸馏教模型产生可用轨迹，RL 依据结果重新分配轨迹概率，模式标签或控制 token 教模型服从 effort。它们学到能力和条件分布；真正的本次计算量，要等运行时采样出 \(R\) 后才能确定。

## 第二步：运行时 effort 改变条件分布，不改变本次请求中的参数

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

## 第三步：多出的推理 token 会进入后续每一步

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

## 第四步：精确到一次 decode forward 的 FLOPs

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

## 第五步：把整段 reasoning 与答案加总

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

## 第六步：算一个 low → high 的完整例子

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

## 第七步：KV cache 增长多少

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

## 第八步：为什么 FLOPs、延迟和费用不是同一个倍率

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

## 第九步：high 还可能挤掉答案

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

训练阶段不一定要准备 low、medium、high 三套固定长度的思维链。它可以通过监督轨迹、结果奖励和模式标签，改变模型展开推理与输出结束标记的概率；运行时的 effort 和硬预算再把这种能力变成本次请求的实际长度 \(R\)。

从这一刻起，后果才是可逐项计算的：\(R\) 改变后续上下文，增加串行 decode forward、FLOPs 和 KV cache，占用延迟、费用与答案空间。high 的本质不是“临时获得更多参数”，而是让请求更可能或被迫走过更多推理 token。至于这些 token 有没有换来更高正确率，只能由同任务、同工具、重复采样的评测回答，不能由 effort 标签或长度本身保证。
