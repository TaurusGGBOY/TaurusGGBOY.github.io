---
title: "2026 年 PDF OCR 怎么选：Pipeline、专用 VLM 与整页识别的分数和边界"
published: 2026-09-20T22:25:00+08:00
description: "从 OmniDocBench 公开成绩出发，区分传统 OCR、分阶段 VLM 与整页识别，给出扫描件、论文、表格、坐标定位和 RAG 的选型与验收方法。"
tags: ["OCR", "PDF", "VLM", "RAG", "模型选型"]
category: "AI / Architecture"
image: "/images/posts/pdf-ocr-pipeline-vlm-2026/cover.png"
imageAlt: "PDF 页面中的文字、表格和公式经过光学透镜重组为结构化文档的概念插图"
draft: false
---

复杂 PDF 的解析，已经值得把文档专用 VLM 放进第一轮候选。2026 年 9 月查阅的 OmniDocBench 官方榜单中，TeleOCR、OvisOCR2、PaddleOCR-VL-1.6 的综合分超过 96，而传统 MinerU-Pipeline 为 86.47。这个差距足以改变选型起点，却还不足以让所有 PDF 都走同一条模型链路。[官方榜单](https://github.com/opendatalab/OmniDocBench#end-to-end-evaluation)

原因在于，我们说的“PDF OCR”经常包含几种不同工作：把扫描件变成可搜索 PDF，把论文还原成带公式的 Markdown，把表格变成数据，或者只从合同中提取几个字段。输入一样，合格输出却完全不同。

本文以 **2026 年 9 月 20 日**查阅的官方榜单、论文和项目文档为资料截点。公开成绩是来源方报告，本文没有在同一硬件上复测各方案；场景推荐和验收方案是工程判断。

## Pipeline 和 VLM，其实是两个维度

Pipeline 描述任务怎样分阶段完成；VLM（Vision-Language Model，视觉语言模型）描述用什么模型。一个系统可以既是 pipeline，又使用 VLM。

传统 OCR pipeline 通常先分析版面，找到文字、表格和公式，再调用各自的识别模块，最后恢复阅读顺序。文档专用 VLM 则让视觉与语言模型承担识别、结构生成等工作；它既可以处理整页，也可以只处理版面模型切出的区域。

| 路线 | 主要处理方式 | 代表候选 |
| --- | --- | --- |
| 传统 OCR pipeline | 版面分析、文字 OCR、表格与公式模块、排序拼接 | PP-StructureV3、MinerU-Pipeline、Docling 标准管线 |
| 分阶段 VLM pipeline | 先定位区域，再识别内容，组织文档结构 | PaddleOCR-VL-1.6、TeleOCR、MinerU2.5-Pro |
| 整页端到端专用 VLM | 页面图片直接生成结构化文档 | OvisOCR2 |
| 通用 VLM | 用提示词驱动通用多模态模型转录或理解页面 | Gemini、Qwen-VL 等 |

例如，PaddleOCR-VL-1.6 的完整解析系统由 PP-DocLayoutV3 和 0.9B VLM 组成：前者定位区域，后者识别文字、表格、公式等内容，再由后处理组织 Markdown 或 JSON。OvisOCR2 则明确采用整页端到端方式。TeleOCR 的实现保留 Detection、Segmentation 两种版面处理模式。[PaddleOCR-VL-1.6 论文](https://arxiv.org/html/2606.03264v1)、[OvisOCR2 模型卡](https://huggingface.co/ATH-MaaS/OvisOCR2)、[TeleOCR 项目](https://github.com/caipeng328/TeleOCR)

比较时应分别看模型能力和系统架构：**专用 VLM 已经显著抬高复杂文档解析的公开成绩；分阶段处理仍然是头部方案的重要组成部分。**

## 公开分数：专用 VLM 领先，整页与分阶段接近

下面统一取自 OmniDocBench 官方 README 中标为 **`v1.6_full`** 的成绩表，保留具体模型名称。仓库更新日志、数据集和评分代码都有各自版本，复现时应记录提交与配置，不能只写“用了最新版”。

| 模型或系统 | 榜单分类 | 综合分 ↑ |
| --- | --- | ---: |
| TeleOCR | 专用 VLM | **96.91** |
| OvisOCR2 | 专用 VLM | **96.47** |
| PaddleOCR-VL-1.6 | 专用 VLM | **96.34** |
| MinerU2.5-Pro | 专用 VLM | 95.75 |
| GLM-OCR | 专用 VLM | 95.22 |
| Gemini 3 Pro | 通用 VLM | 92.91 |
| Qwen3-VL-235B | 通用 VLM | 89.78 |
| MinerU-Pipeline | Pipeline Tools | 86.47 |
| Marker | Pipeline Tools | 78.44 |

数据来源：[OmniDocBench 官方成绩表](https://github.com/opendatalab/OmniDocBench#end-to-end-evaluation)。这里的 Marker 和 MinerU-Pipeline 是榜单所评配置，不能代表这些项目当前全部后端与增强模式。

TeleOCR 比表中最高的传统 pipeline 高 10.44 分；与整页端到端 OvisOCR2 相差 0.44 分。这能支持候选优先级，不能单独证明某种架构具有普遍优势：训练数据、模型、预处理和后处理同时在变化，这不是控制其他变量的架构消融实验。

还要读懂综合分的含义：

```text
Overall = [(1 − 文字归一化编辑距离) × 100
           + 表格 TEDS
           + 公式 CDM] / 3
```

它不是“整份文档有多少字符正确”。阅读顺序另行计分，延迟、显存、人工修订成本也不在这个平均数里。[OmniDocBench 指标定义](https://github.com/opendatalab/OmniDocBench#end-to-end-evaluation)

作者发布成绩与当前榜单也可能略有不同。例如 OvisOCR2 模型卡报告 96.58，PaddleOCR-VL-1.6 论文报告 96.33。本文统一使用上面的官方表，没有从不同来源挑选最高数字。[OvisOCR2](https://huggingface.co/ATH-MaaS/OvisOCR2)、[PaddleOCR-VL-1.6](https://arxiv.org/html/2606.03264v1)

### 换一个测试集，结论会不会变？

会。olmOCR-Bench 使用类似单元测试的断言来检查内容与顺序，例如某段文字是否出现、两个元素的顺序是否正确。其当前结果表中，olmOCR 2 对应的 v0.4.0 为 **82.4±1.1**，Marker 1.10.1 为 **76.1±1.1**，DeepSeek-OCR 为 **75.7±1.0**。[olmOCR-Bench](https://github.com/allenai/olmocr/blob/main/olmocr/bench/README.md)

这组结果说明，模型带有 VLM 标签，并不保证每个测试集都压过传统系统；两个接近且区间重叠的成绩，也不宜解读为明确胜负。olmOCR 2 主要面向英文印刷文档，其结果不能直接替代中文票据或手写资料的评估。[Ai2 的 olmOCR 2 介绍](https://allenai.org/blog/olmocr-2)

## 先决定交付物，再选识别方案

选型时，我会先问“识别之后拿来做什么”。全文检索、精确回填、结构化入库与知识问答，对错误的容忍方式不一样。

### 普通文字与可搜索 PDF：保留轻量路线

如果 PDF 有可靠文字层，先尝试原生提取，再检查乱码、漏字和顺序。Docling 提供原生 PDF 解析及可配置 OCR 的路径，适合把文字层和扫描区域区别处理。[Docling 架构](https://docling-project.github.io/docling/concepts/architecture/)、[配置说明](https://docling-project.github.io/docling/reference/pipeline_options/)

如果输入是普通扫描件，目标只是提取文字，可以从 PP-OCRv6 等传统 OCR 开始。其 tiny、small、medium 提供不同规模，适合按部署资源比较。若目标是让原文件可以搜索和选中文字，OCRmyPDF 的任务定义更直接：给扫描 PDF 加文字层。[PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR)、[OCRmyPDF](https://ocrmypdf.readthedocs.io/en/latest/introduction.html)

这类项目不必把公式和表格生成能力当成主要购买理由。应测实际语言的文字错误、空白页误识别，以及搜索和复制是否正确。

### 论文、教材与复杂表格：专用 VLM 优先

复杂文档转 Markdown 或 JSON，我会将 PaddleOCR-VL-1.6、MinerU2.5-Pro 列为主要候选，加入 TeleOCR 作为精度挑战者，并用 OvisOCR2 比较整页路线。Paddle 的两阶段系统还提供跨页表格合并与标题层级后处理；这些能力要用整份文档验收，不能只看单页图片。[PaddleOCR-VL-1.6](https://arxiv.org/html/2606.03264v1)、[MinerU2.5 论文](https://aclanthology.org/2026.acl-industry.3.pdf)

对表格，合格结果应同时保留“值”和“值属于谁”。例如金额识别正确，却从“本期”列移动到了“上期”列，字符错误可能很少，业务含义已经改变。这个例子是验收设计：除了文字比较，还应检查行列关联、合并单元格、单位、小数点与负号。

### 坐标、回填与高亮：单独验收几何精度

Markdown 读起来顺畅，不代表能在原 PDF 上准确框选证据。需要逐行高亮、表格单元格定位或表单回填时，应明确坐标粒度与坐标系，再选模型。

PP-StructureV3 的官方说明特别指出，它提供比 PaddleOCR-VL 更细的文字和表格单元格坐标。因此，这类需求值得保留传统结构化 pipeline 作对照；不能只拿全文解析总分决定。[PaddleOCR 能力说明](https://github.com/PaddlePaddle/PaddleOCR)

### 弯曲、拍照、历史资料：用真实退化样本验证

手机拍摄的书页会弯曲，有反光和透视变形。TeleOCR 面向数字文档与拍摄文档提供统一方案；PaddleOCR-VL 系列也包含不规则区域定位和真实畸变评估。它们值得进入候选，但“复杂版面高分”与“严重模糊仍能可靠转录”不是同一个承诺。[TeleOCR](https://github.com/caipeng328/TeleOCR)、[Real5-OmniDocBench 论文](https://arxiv.org/abs/2603.04205)

英文历史印刷资料可以加入 olmOCR 2；古籍、手写体和低资源语言则应独立成组。输入本身不可辨认时，验收应该允许标记不确定，而不是奖励一段流畅的补全文字。

### 场景选型速查

下表是我的候选建议，不是新的跨场景实测排名。

| 输入与目标 | 优先候选 | 最应检查的结果 |
| --- | --- | --- |
| 有可靠文字层的电子 PDF | 原生提取、Docling；异常区域补 OCR | 文字覆盖、乱码、阅读顺序 |
| 普通扫描件转纯文本 | PP-OCRv6 | 目标语言错误率、漏行、吞吐 |
| 扫描件增加搜索与选择能力 | OCRmyPDF＋Tesseract | 文字层对齐、搜索、复制 |
| 论文、公式、多栏转 Markdown | PaddleOCR-VL-1.6、MinerU2.5-Pro、OvisOCR2 | 公式、段落顺序、截断、跨页内容 |
| 复杂表格转结构化数据 | TeleOCR、PaddleOCR-VL-1.6 | 单元格关系、数字与单位 |
| 精确坐标、高亮、回填 | PP-StructureV3；与带坐标 VLM 对照 | 框位置、粒度、坐标变换 |
| 拍照、弯曲、倾斜文档 | TeleOCR、PaddleOCR-VL-1.6 | 畸变分组表现、漏区、误补全 |
| 英文历史印刷资料 | 加入 olmOCR 2 对照 | 历史字体、页眉页脚、扫描噪声 |
| CPU 或边缘部署 | 轻量 OCR；按需启用结构分析 | 峰值内存、冷启动、P95 延迟 |
| 不维护模型服务 | Mistral OCR 等托管文档 API | 当前服务版本、输出格式、账单 |

托管 API 按当前文档和实际样本评估，不把榜单里的旧服务成绩套给今天的接口。Mistral 的 OCR 接口提供结构化文档输出，是这条路线的一个候选。[Mistral OCR 文档](https://docs.mistral.ai/studio/document-processing/basic_ocr)

## 用一条可观测的路由替代全量重识别

对一个新建的 PDF → RAG 系统，我倾向于保留原生提取，把专用 VLM 用在扫描件和需要恢复结构的区域，并记录每块结果来自哪一页。

![PDF 解析路由：可靠文字层走原生提取，扫描件与复杂区域走专用识别，汇入带来源位置的结构化结果后验收](/images/posts/pdf-ocr-pipeline-vlm-2026/routing.svg)

这是一条建议架构。路由可以按页执行，也可以按区域执行，但要检查合并边界：混合型 PDF 可能在同一页同时有原生正文和截图表格。只判断“这个文件是否存在文字”，会漏掉图片中的内容；整页全部重识别，又可能增加不必要的计算和识别误差。

进入索引前，我会保留页码、区域位置、元素类型，以及表格或公式的结构化表示。这样，发现答案错误时可以回到对应原文，区分是解析错误、切块丢失上下文，还是检索没有找对证据。对流程图等视觉信息，还需单独设计图像保留或理解路径，不能假设全文转录已经保留全部语义。

对于只要几个字段的业务，可以另测直接 VLM 抽取，未必先转录整份 PDF。它的验收单位应是字段和证据位置，而不是全文解析综合分。

## 验收：把分数换成可以决定上线的指标

我的起步建议是抽取 **200～500 页真实样本**，并加入少量完整长文档。这个数量是启动评估的预算建议，不是统计充分性的保证。普通文字、表格、公式、低质量扫描、混合页和主要语言都要有覆盖；开发调参和最终验收使用不同文档。

每个候选保留两种记录：官方推荐配置下的效果，以及业务资源预算下的效果。固定模型版本、渲染分辨率、提示词、输出上限和后处理，才能解释质量变化来自哪里。分阶段模型按其完整管线运行，不能只取识别权重做整页提示，再把结果标成官方系统成绩。

| 指标 | 回答什么问题 |
| --- | --- |
| 文字编辑错误、漏行与整页失败率 | 是否忠实而完整地转录 |
| 数字字段完全匹配率 | 金额、编号、日期能否直接使用 |
| 表格 TEDS 与单元格关系检查 | 内容和结构是否同时正确 |
| 公式与阅读顺序 | 科研文档是否保持原意 |
| 坐标误差、证据定位成功率 | 能否回到原页验证 |
| 重复生成、截断、异常补全文本 | 输出是否看似成功但实际不可用 |
| 每页 P50/P95、吞吐、显存、失败重试 | 能否满足运行预算 |
| 修订时间、每千页合格输出成本 | 是否真的节省总投入 |

成本应覆盖同一个交付目标。可以按下面的方式汇总：

```text
每千页合格输出成本
  =（推理或 API 费用 + 重试费用 + 人工校对费用 + 分摊运维费用）
    / 验收合格页数 × 1000
```

同时报告失败页比例，避免通过丢弃难页把单价变好看。自托管的 GPU 每小时价格、API 每页价格、人工一分钟价格属于不同计费单位，只有放到实际流量和质量要求里才可比较。

若质量接近，就让部署、速度和修订成本决定；若某个文档切片明显落后，就考虑分流或专门处理。对于已有系统，新模型还需覆盖重解析、重新切块和重建索引的迁移成本。

## 我的默认起点

复杂 PDF 转 Markdown 或进入 RAG，我会先试 **PaddleOCR-VL-1.6 或 MinerU2.5-Pro**，再加入 **TeleOCR 与 OvisOCR2** 比较质量和运行方式。可靠的电子文字层继续原生提取，简单扫描文本保留轻量 OCR，需要精确坐标时把 PP-StructureV3 留在候选中。

上线应依据目标文档上的完整性、结构、位置与总成本。公开榜单负责缩小候选范围，业务验收负责做最终选择。
