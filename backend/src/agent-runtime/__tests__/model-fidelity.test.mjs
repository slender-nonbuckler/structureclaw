import { describe, expect, test } from '@jest/globals';

const draft = {
  inferredType: 'truss',
  engineeringDraft: {
    topology: {
      nodes: [
        { id: 'A', x: 0, y: 0, z: 0, restraints: [true, false, true, false, false, false] },
        { id: 'B', x: 3, y: 0, z: 2 },
        { id: 'C', x: 6, y: 0, z: 0 },
      ],
      members: [{ id: 'M1', nodes: ['A', 'B'] }, { id: 'M2', nodes: ['B', 'C'] }],
    },
    loads: [
      { id: 'L1', kind: 'nodal', magnitude: 10, unit: 'kN', direction: 'gravity', location: { nodeId: 'B' }, caseId: 'LC1' },
      { id: 'L2', kind: 'nodal', magnitude: 10, unit: 'kN', direction: 'gravity', location: { nodeId: 'B' }, caseId: 'LC1' },
    ],
    analysis: { loadCombinations: [{ id: 'ULS', factors: { LC1: 1 } }] },
  },
};
const model = {
  nodes: [
    { id: 'C', x: 6, y: 0, z: 0 },
    { id: 'B', x: 3, y: 0, z: 2 },
    { id: 'A', x: 0, y: 0, z: 0, restraints: [true, true, true, false, false, false] },
  ],
  elements: [{ id: 'X', type: 'truss', nodes: ['B', 'A'] }, { id: 'Y', type: 'truss', nodes: ['B', 'C'] }],
  load_cases: [{ id: 'LC1', loads: [{ node: 'B', fz: -10 }, { node: 'B', fz: -10 }] }],
  load_combinations: [{ id: 'ULS', factors: { LC1: 1 } }],
};
const compare = async (state = draft, built = model) => {
  const { compareModelToDraft } = await import('../../../dist/agent-runtime/model-fidelity.js');
  return compareModelToDraft(state, built);
};
const codes = (result) => result.discrepancies.map((item) => item.code);

describe('model fidelity against accepted explicit draft', () => {
  test('matches reordered nodes, reversed member endpoints, 2D restraints, and independent same-node loads', async () => {
    expect((await compare()).status).toBe('pass');
  });
  test('finds missing load without collapsing other independent same-node loads', async () => {
    expect(codes(await compare(draft, { ...model, load_cases: [{ id: 'LC1', loads: [{ node: 'B', fz: -10 }] }] }))).toContain('NODAL_LOAD_MISMATCH');
    expect(codes(await compare(draft, { ...model, load_cases: [{ id: 'LC1', loads: [...model.load_cases[0].loads, { node: 'B', fz: -10 }] }] }))).toContain('NODAL_LOAD_MISMATCH');
  });
  test('finds wrong connectivity, extra members, coordinates, and restraints', async () => {
    const changed = { ...model,
      nodes: model.nodes.map((node) => node.id === 'B' ? { ...node, z: 2.5 } : node.id === 'A' ? { ...node, restraints: [false, true, true, false, false, false] } : node),
      elements: [...model.elements.slice(0, 1), { id: 'Y', type: 'truss', nodes: ['A', 'C'] }, { id: 'Z', type: 'truss', nodes: ['A', 'C'] }],
    };
    expect(codes(await compare(draft, changed))).toEqual(expect.arrayContaining(['NODE_COORDINATE_MISMATCH', 'SUPPORT_RESTRAINT_MISMATCH', 'MEMBER_CONNECTIVITY_MISMATCH']));
  });
  test('finds missing or duplicated cases and combination factors', async () => {
    const state = { ...draft, engineeringDraft: { ...draft.engineeringDraft,
      loads: [...draft.engineeringDraft.loads, { id: 'L3', kind: 'nodal', magnitude: 5, unit: 'kN', direction: 'gravity', target: 'C', caseId: 'LC2' }],
      analysis: { loadCombinations: [{ id: 'ULS', factors: { LC1: 1, LC2: 0.5 } }] },
    } };
    expect(codes(await compare(state, model))).toEqual(expect.arrayContaining(['LOAD_CASE_MISMATCH', 'LOAD_COMBINATION_MISMATCH']));
  });
  test('omitted defaults do not fail; unsupported distributed and self-weight comparisons are explicit', async () => {
    const state = { inferredType: 'truss', engineeringDraft: { loads: [{ kind: 'area', magnitude: 2, unit: 'kN/m2', target: 'floor' }], analysis: { includeSelfWeight: false }, sections: { sectionProperties: { member: { areaM2: 0.01 } } } } };
    const result = await compare(state, model);
    expect(result.status).toBe('inconclusive');
    expect(result.unsupportedFields).toEqual(expect.arrayContaining(['engineeringDraft.loads', 'engineeringDraft.analysis.includeSelfWeight', 'engineeringDraft.sections.sectionProperties']));
  });
  test('does not treat unresolved draft evidence as accepted or compare generated topology', async () => {
    const unresolved = { ...draft, draftIssues: [{ field: 'topology', severity: 'ambiguous', reason: 'Joint unknown.' }] };
    const result = await compare(unresolved, model);
    expect(result.unsupportedFields).toContain('engineeringDraft.topology');
    expect(result.discrepancies).toEqual([]);
    const generated = await compare({ inferredType: 'truss', engineeringDraft: { geometry: { lengthM: 6 } } }, model);
    expect(generated.status).toBe('inconclusive');
  });
});
