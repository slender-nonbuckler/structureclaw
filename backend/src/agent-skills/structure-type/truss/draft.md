# Draft

- Required legacy fields for executable analysis: `lengthM`, `loadKN`.
- Recommended legacy fields: `heightM`, `bayCount`, `loadType`, `loadPosition`.
- Preferred structured field: `engineeringDraft`.

## Geometry

- Span / length maps to `engineeringDraft.geometry.lengthM` and legacy `lengthM`.
- Truss height maps to `engineeringDraft.geometry.heightM` and legacy `heightM`.
- Panel count / number of bays maps to legacy `bayCount`.
- If the user asks you to recommend the truss form, keep the stated geometry and do not invent load values.

## Loads

- Nodal load, joint load, node force, upper-chord/top-chord node load, lower-chord/bottom-chord node load, `kN/节点`, or `kN per node` maps to `engineeringDraft.loads`.
- For a stated nodal load such as "10 kN at each top chord node", output one load entry:
  `{ "kind": "nodal", "magnitude": 10, "unit": "kN", "direction": "gravity", "target": "top chord nodes", "location": { "nodeRole": "top" } }`
- Also output legacy compatibility fields when the value is explicit:
  - `loadKN`: numeric magnitude in kN.
  - `loadType`: `point` for nodal/joint loads.
  - `loadPosition`: `top-nodes` for upper-chord/top-chord nodes, `middle-joint` for a mid-height joint, `free-joint` for a named or otherwise specified joint.
- Do not leave `engineeringDraft.loads` empty when the user explicitly gives a nodal load.
- When a follow-up changes existing chord-node loads to a new magnitude, output only the updated load entry with the same chord/location and load case. The new magnitude replaces the old one; do not preserve both entries.
- If the user gives a line/distributed load on the truss, output `kind: "line"` or `kind: "distributed"`, `unit: "kN/m"`, and legacy `loadType: "distributed"`.
- If the magnitude or unit is ambiguous, omit `loadKN`, add a `draftIssues` entry for `loadKN`, and include `loadKN` in `skillState.invalidDraftFields`.

## Topology

- A geometric crossing is not automatically a structural joint. Compare joint dots or symbols across the drawing, check whether the crossing itself is marked, and trace whether each member continues through it or terminates there. When connected joints are consistently marked but two continuous members cross without a marker, preserve the continuous members and do not add a node or split them at the crossing. Respect an explicit connection detail or user instruction, including a connected crossing without a dot or a member terminating at the connection. If the vision summary both splits members at a crossing and says connectivity is uncertain, resolve that conflict from the available drawing evidence; if it remains ambiguous, emit a blocking `draftIssues` entry for `topology` and include `topology` in `skillState.invalidDraftFields` rather than accepting the split topology as confirmed.
- 几何交叉点不自动等于结构节点。比较图中各处节点圆点或符号，检查交叉点本身是否标记，并追踪杆件是穿过交叉点连续延伸还是在此终止。若实际连接节点均有标记，而两根连续杆件在未标记处相交，应保留连续杆件，不要在交叉点增设节点或拆分杆件。尊重明确的连接详图或用户说明；即使没有圆点，明确连接的交叉点或终止于连接处的杆件仍应建为节点。若视觉摘要一面在交叉处拆分杆件，一面又称连接关系不确定，应根据现有图纸证据核实；仍有歧义时，为 `topology` 输出阻塞性 `draftIssues`，并将 `topology` 加入 `skillState.invalidDraftFields`，不要把拆分拓扑当作已确认事实。
- Warren / 华伦桁架 maps to `skillState.trussTopology: "warren"`.
- Pratt / 普拉特桁架 maps to `skillState.trussTopology: "pratt"`.
- Howe / 豪式桁架 maps to `skillState.trussTopology: "howe"`.
- K truss / K形桁架 maps to `skillState.trussTopology: "k"`.
- Do not silently add members that contradict the user's topology description. If a named triangulated truss system is combined with the absence of the web members needed to form that system, report a `draftIssues` conflict for `trussTopology`, add `trussTopology` to `skillState.invalidDraftFields`, and ask which requirement should be retained.
- 不要静默补上与用户拓扑描述冲突的杆件。若用户指定了需要腹杆形成的三角桁架体系，同时又要求取消形成该体系所需的腹杆，应为 `trussTopology` 输出 `draftIssues` 冲突，将其加入 `skillState.invalidDraftFields`，并追问保留哪一项要求。

## Examples

Input: `跨度15m，高度3m，采用华伦桁架，每个上弦节点荷载10kN`

Output:

```json
{
  "engineeringDraft": {
    "structureType": "truss",
    "geometry": { "lengthM": 15, "heightM": 3 },
    "loads": [
      {
        "kind": "nodal",
        "magnitude": 10,
        "unit": "kN",
        "direction": "gravity",
        "target": "top chord nodes",
        "location": { "nodeRole": "top" }
      }
    ]
  },
  "draftPatch": {
    "inferredType": "truss",
    "lengthM": 15,
    "heightM": 3,
    "loadKN": 10,
    "loadType": "point",
    "loadPosition": "top-nodes"
  },
  "skillState": {
    "trussTopology": "warren"
  }
}
```

Input: `每个上弦节点荷载 10 kN`

Output:

```json
{
  "engineeringDraft": {
    "structureType": "truss",
    "loads": [
      {
        "kind": "nodal",
        "magnitude": 10,
        "unit": "kN",
        "direction": "gravity",
        "target": "top chord nodes",
        "location": { "nodeRole": "top" }
      }
    ]
  },
  "draftPatch": {
    "inferredType": "truss",
    "loadKN": 10,
    "loadType": "point",
    "loadPosition": "top-nodes"
  }
}
```
