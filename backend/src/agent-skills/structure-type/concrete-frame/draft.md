# Concrete Frame Skill – Draft Extraction

## Purpose
Extract a regular reinforced concrete frame model from a natural language description.

## Input Format
A single natural language paragraph describing the frame, e.g.:
- "A 3‑story 2‑bay concrete frame, story heights 3.5 m each, bay widths 6 m, concrete C30, rebar HRB400, fixed base."
- "混凝土框架，4层3跨，层高3.6 m，跨度7.2 m，混凝土C40，钢筋HRB400，固接基础。"

## Output Format
A `DraftExtraction` JSON object with the following optional keys (see `constants.ts` for the complete list):

### Geometry
| Key | Type | Example | Notes |
|-----|------|---------|-------|
| `frameDimension` | `"2d"` or `"3d"` | `"2d"` | Inferred from "planar", "space", "3‑d", "三维", etc. |
| `storyCount` | `number` | `3` | Number of stories (above ground). |
| `bayCount` | `number` | `2` | For 2D frames, total number of bays. |
| `bayCountX` | `number` | `3` | For 3D frames, number of bays in X direction. |
| `bayCountY` | `number` | `2` | For 3D frames, number of bays in Y direction. |
| `storyHeightsM` | `number[]` | `[3.5, 3.5, 3.5]` | Each story's height (m). Length must equal `storyCount`. |
| `bayWidthsM` | `number[]` | `[6.0, 6.0]` | For 2D frames, each bay's width (m). Length must equal `bayCount`. |
| `bayWidthsXM` | `number[]` | `[6.0, 6.0, 6.0]` | For 3D frames, bay widths in X direction. Length = `bayCountX`. |
| `bayWidthsYM` | `number[]` | `[5.0, 5.0]` | For 3D frames, bay widths in Y direction. Length = `bayCountY`. |

### Loads & Boundaries
| Key | Type | Example | Notes |
|-----|------|---------|-------|
| `floorLoads` | `Array<{ story: number; verticalKN?: number; lateralXKN?: number; lateralYKN?: number; liveLoadKN?: number }>` | `[{ story: 1, verticalKN: -200, lateralXKN: 50 }]` | Vertical load negative (downward). Lateral loads positive in global X/Y. |
| `frameBaseSupportType` | `"fixed"` or `"pinned"` | `"fixed"` | Default `"fixed"`. |

### Materials & Sections
| Key | Type | Example | Notes |
|-----|------|---------|-------|
| `frameConcreteGrade` | `string` | `"C30"` | Concrete grade (C20–C80). Default `"C30"`. |
| `frameRebarGrade` | `string` | `"HRB400"` | Rebar grade (HPB300, HRB400, HRB500). Default `"HRB400"`. |
| `frameColumnSection` | `string` | `"400X400"` | Column cross‑section description. See section parsing below. |
| `frameBeamSection` | `"string"` | `"300X600"` | Beam cross‑section description. |

### Site, Seismic & Wind
| Key | Type | Example | Notes |
|-----|------|---------|-------|
| `siteSeismic` | `object` | `{ "intensity": 7, "accelerationG": 0.1, "designGroup": "第三组", "siteCategory": "III" }` | Use for PKPM/YJK-style seismic design parameters. Normalize "3类" to `"III"`. |
| `wind` | `object` | `{ "basicPressureKNM2": 0.4, "terrainRoughness": "B" }` | Basic wind pressure in kN/m² and terrain roughness A/B/C/D. |
| `analysisControl` | `object` | `{ "rigidFloor": true, "modalCount": 15 }` | Optional calculation-control values such as rigid diaphragm, modal count, P-Delta. |
| `skillState.seismicWorkflow` | `object` | `{ "methodPreference": "auto", "designBasis": { "codes": ["GB 55002-2021", "GB/T 50011-2010-2024"], "siteSeismic": { "intensity": 8, "designGroup": "2", "siteCategory": "III" } }, "designRequirements": { "fortificationCategory": "standard", "seismicGrade": 2, "irregularity": "regular" } }` | Use for China-code seismic workflow intent. This must come from semantic understanding of the request, not keyword matching. |

## Section Parsing
Concrete frame sections are described as rectangular cross‑sections:

- **Rectangular**: `"400X400"`, `"B400H600"`, `"RECT400X500"` → width × height (mm).
- The parser expects width (B) and height (H) in millimeters.
- Default column section: `"500X500"` for up to 5 stories, `"600X600"` for 6–10 stories, `"700X700"` for >10 stories.
- Default beam section: `"300X600"` for up to 5 stories, `"350X700"` for 6–10 stories, `"400X800"` for >10 stories.

## Extraction Rules
1. **Story/bay numbers**: Look for patterns like "3‑story 2‑bay", "4层3跨".
2. **Dimensions**: Extract numbers followed by "m", "米", "mm", "毫米". Convert mm to m for story heights and bay widths.
3. **Loads**: "dead load 5 kN/m²", "恒载 5 kN/m²", "live load 3 kN/m²", "活载 3 kN/m²". Prefer `engineeringDraft.loads` with `kind: "area"` and `unit: "kN/m2"` when floor geometry is available; the runtime can convert it to per-story total loads. Use legacy `floorLoads` only when the total kN per story is explicitly given or can be computed reliably.

4. **Materials**: Look for concrete grades (C20–C80) and rebar grades (HPB300, HRB400, HRB500).
5. **Seismic / wind design basis**: Semantically identify seismic fortification inputs such as intensity, design acceleration, design group, site category, fortification category, seismic grade, regularity, and explicit method requirements. Put scalar site parameters into `siteSeismic`; put China-code workflow intent into `skillState.seismicWorkflow`. Do not infer the analysis method through keyword/regex matching.
6. **Boundary**: "fixed base", "pinned base", "固接", "铰接".

### Full-floor area loads / 整层楼面荷载
- 对明确指定楼层、且图纸或说明可确定该层完整楼面边界的均布面荷载，若无局部区域、洞口、排除区或相反指示，可按整层楼面作用。输出 `engineeringDraft.loads`，保留 `location.story`、`kind: "area"`、`unit: "kN/m2"`、向下方向及工况/组合，`target` 标明整层楼面；不要重复输出同一荷载的 `floorLoads` 总力。说明尺寸、面积、压力和合力 `p × A`；荷载传递方式只按实际分析结果说明。
- For a uniform area load explicitly assigned to a story with a complete floor footprint established by the drawing or specification, use the full floor if no partial region, opening, exclusion, or contrary instruction exists. Preserve `location.story`, `kind: "area"`, `unit: "kN/m2"`, downward direction, and case/combination; identify the full floor in `target`. Do not duplicate it as a `floorLoads` total. Report dimensions, area, pressure, and resultant `p × A`, and name the transfer method only from the actual analysis result.
- 若图纸标注、图例或荷载说明结合结构语境明确表明 F1、F2、…、Fn 是楼面面荷载的楼层编号，且模型具有对应的第 n 个地上楼面标高，可将 Fn 映射至 `location.story: n`；在 `target` 标明该层完整楼面及“楼层编号推断”，并在报告中说明对应关系。显式楼层指定优先于标签推断；不能仅凭标签符合 F 加数字的形式或出现顺序认定其为楼层编号。若缺少某层标签，不得补造该层荷载；若图纸要求该层荷载但位置或数值不明，应保留阻塞性问题。遇到荷载工况编号、图例或其他注释相矛盾时，不采用此推断。
- When drawing annotations, a legend, or a load note together with structural context establish floor-indexed area-load labels F1, F2, …, Fn and corresponding elevated floor levels exist, map Fn to `location.story: n`. Identify the full floor and the inferred floor index in `target`, and disclose each label-to-story mapping as a modeling assumption in the report. An explicit story assignment takes precedence over the label. An F followed by a number or label order alone is insufficient evidence of floor semantics. Do not invent loads for missing labels; if a required floor load has no known location or value, keep a blocking issue. Do not infer from labels that conflict with load-case definitions or other annotations.
- 不得仅凭 F1/F2 出现顺序推断楼层。若楼层或完整边界不明，或存在局部面压、挡土墙侧压力、洞口/排除区、矛盾信息，须保留阻塞性问题并追问；不得套用整层楼面约定。
- Do not assign F1/F2 to stories solely from their order. Keep an unresolved issue for an unknown story or complete perimeter, partial or localized pressure, retaining-wall pressure, opening/exclusion, or contradictory evidence; do not apply this convention.

## Examples
1. "A 2‑story 1‑bay concrete frame, story heights 4 m, bay width 8 m, concrete C35, rebar HRB400, fixed base."
   → `{ frameDimension: "2d", storyCount: 2, bayCount: 1, storyHeightsM: [4, 4], bayWidthsM: [8], frameConcreteGrade: "C35", frameRebarGrade: "HRB400", frameBaseSupportType: "fixed" }`
2. "混凝土框架，5层4跨，层高3.6 m，跨度6 m，混凝土C40，钢筋HRB500，固接。"
   → `{ frameDimension: "2d", storyCount: 5, bayCount: 4, storyHeightsM: [3.6,3.6,3.6,3.6,3.6], bayWidthsM: [6,6,6,6], frameConcreteGrade: "C40", frameRebarGrade: "HRB500", frameBaseSupportType: "fixed" }`

## Missing Values
If a required key (see `REQUIRED_KEYS` in `constants.ts`) is missing after extraction, the skill will generate interactive questions to fill the gap.
