# Draft

- 必填参数：`lengthM`, `supportType`, `loadKN`
- 建议参数：`loadType`, `loadPositionM`, `loadPosition`
- 输出 JSON 中使用 `draftPatch`

## 参数提取规则

### lengthM（跨度/长度）
- "6米" / "6m" / "跨度6m" / "span 6m" → `"lengthM": 6`
- "长3米" / "3m long" → `"lengthM": 3`
- "8米" / "8m" → `"lengthM": 8`

### supportType（支座类型）
- "简支" / "simply supported" / "简支梁" → `"supportType": "simply-supported"`
- "悬臂" / "cantilever" / "悬臂梁" → `"supportType": "cantilever"`
- "两端固" / "fixed-fixed" → `"supportType": "fixed-fixed"`
- 未指定支座类型时默认 / Default to `"supportType": "simply-supported"` when unspecified

### loadKN（荷载大小）
- "20kN/m" / "均布荷载20kN/m" → `"loadKN": 20`
- "10kN" / "集中力10kN" → `"loadKN": 10`
- "point load 15kN" → `"loadKN": 15`

### loadType（荷载类型）
- "均布荷载" / "distributed" → `"loadType": "distributed"`
- "集中力" / "point load" / "点荷载" → `"loadType": "point"`

### loadPositionM（荷载位置，距左端偏移）
- "距左端3米" / "at 3m from left end" → `"loadPositionM": 3`
- 当 loadPositionM 有具体数值时，应同时推断 `loadPosition`（如 `"midspan"`、`"free-joint"` 等）

## 荷载位置映射
- 点荷载优先位置：`end` 或 `midspan`
- 均布荷载优先位置：`full-span`
- 当荷载只作用于某个梁段时，在 `engineeringDraft.loads[].location.spanIndex` 中输出从 1 开始的梁段索引；不要只把“第几跨/哪一构件”写进 `target` 文本。
- 外伸梁或带内部分析节点的梁必须在 `engineeringDraft.boundary.supportPositionsM` 中明确输出实际支座坐标；分析节点不等于支座。

## 输出规则
- 必须同时输出所有已识别的参数，不能遗漏
- 若 Known draft state 已有部分参数，新输出必须保留原有值并补充新值
- 若用户只补充新参数（如只说"20kN"），draftPatch 中仍需包含之前已确认的全部参数

## Diagrammatic full-span UDL / 图示全跨均布荷载

- EN: A small, undimensioned clearance between a load bar or its outer arrows and a support can be diagrammatic. Interpret a uniform load as spanning the supported beam only when the drawing positively shows one load continuing across essentially the entire span, with no separate loaded region, endpoint offsets, break, or contrary written instruction. Do not use a pixel-percentage threshold.
- 中文：荷载线或端部箭头与支座之间的小段未标尺寸空隙可能只是绘图留白。只有图中明确表示同一均布荷载连续覆盖支座之间的整跨，且没有单独的加载区域、端部偏移尺寸、中断或相反的文字说明时，才按全跨解释；不得使用像素比例阈值。
- EN: For that supported but not explicitly dimensioned interpretation, set `engineeringDraft.loads[].target` to `beam` (or the identified supported span), retain its `caseId`, `unit`, and downward `direction`, and set `skillState.beamLoadInterpretation` to `diagrammatic-full-span`. This records a disclosed engineering-drawing convention for the calculation report. An interior analysis node does not split the physical loaded extent.
- 中文：采用这种有图示依据、但未明确标注起止尺寸的解释时，将 `engineeringDraft.loads[].target` 设为 `beam`（或已识别的支座间跨度），保留 `caseId`、`unit` 和向下的 `direction`，并将 `skillState.beamLoadInterpretation` 设为 `diagrammatic-full-span`，以便在计算报告中披露绘图约定。内部分析节点不截断实际加载范围。
- EN: Exact support-to-support load bars and explicit full-span specifications need no convention marker. Dimensioned partial loads, clearly shorter central loads, multiple adjacent load regions, explicit exclusions, and contradictory text take precedence. Preserve their actual extents and do not mark them full-span. If endpoints remain genuinely unclear, keep a load-location `draftIssue` and `invalidDraftFields` entry and request clarification.
- 中文：明确画到两支座的荷载线或文字指定全跨荷载无需约定标记。带尺寸的局部荷载、明显较短的中段荷载、相邻的多个加载区域、明确排除区域及相反文字均优先；保留实际加载范围，不标记为全跨。如端点仍确实不明，保留荷载位置的 `draftIssue` 与 `invalidDraftFields`，请求澄清。
