import { describe, expect, test } from '@jest/globals';

const frameBase = {
  inferredType: 'frame', frameDimension: '2d', storyCount: 1, bayCount: 1,
  storyHeightsM: [4.5], bayWidthsM: [6], floorLoads: [{ story: 1, verticalKN: 48 }],
};
const beam = { name: 'HN400X200', HMM: 400, BMM: 200, twMM: 8, tfMM: 13,
  areaM2: 0.00842, IyM4: 0.000237, IzM4: 1.74e-5, JM4: 8.44e-7 };
const topology = {
  nodes: [
    { id: 'A', x: 0, y: 0, z: 0, restraints: [true, true, true, true, true, true] },
    { id: 'B', x: 3, y: 0, z: 0 },
    { id: 'C', x: 6, y: 0, z: 0, restraints: [false, true, true, false, false, false] },
  ],
  members: [{ id: 'M1', nodes: ['A', 'B'] }, { id: 'M2', nodes: ['B', 'C'] }],
};
const load = { id: 'L1', kind: 'nodal', magnitude: 10, unit: 'kN', direction: 'gravity', caseId: 'LC1', location: { nodeId: 'B' } };

async function runtime() {
  const { normalizeLegacyDraftPatch, mergeLegacyState, computeLegacyMissing } = await import('../../../dist/agent-runtime/legacy.js');
  const { handler: frame } = await import('../../../dist/agent-skills/structure-type/frame/handler.js');
  return { normalizeLegacyDraftPatch, mergeLegacyState, computeLegacyMissing, frame };
}

describe('engineering issue recovery', () => {
  test('complete corrected beam properties clear a stale false conflict and permit frame model construction', async () => {
    const { normalizeLegacyDraftPatch, frame } = await runtime();
    const { buildPreservedDraftExtractionResult } = await import('../../../dist/agent-langgraph/tools.js');
    const progress = (state) => buildPreservedDraftExtractionResult({
      existingState: state, structuralTypeMatch: { key: 'frame', mappedType: 'frame', supportLevel: 'supported' },
      plugin: { id: 'frame', handler: frame }, locale: 'en',
    }).responseJson;
    const initial = frame.mergeState(undefined, normalizeLegacyDraftPatch({ ...frameBase,
      engineeringDraft: { sections: { beam: 'HN400X200' } },
      draftIssues: [{ field: 'frameBeamSectionProperties', severity: 'conflict', reason: 'Earlier section data conflicted.' }],
    }));
    expect(frame.computeMissing(initial, 'execution').critical).toContain('frameBeamSectionProperties');
    expect(progress(initial).canProceed).toBe(false);
    const stillConflicting = frame.mergeState(initial, normalizeLegacyDraftPatch({ engineeringDraft: {
      sections: { beam: 'HN400X200', sectionProperties: { beam: { ...beam, areaM2: 0.5 } } },
    } }));
    expect(frame.computeMissing(stillConflicting, 'execution').critical).toContain('frameBeamSectionProperties');
    expect(progress(stillConflicting).canProceed).toBe(false);
    const corrected = frame.mergeState(initial, normalizeLegacyDraftPatch({ engineeringDraft: {
      sections: { beam: 'HN400X200', sectionProperties: { beam } },
    } }));
    expect(corrected.draftIssues ?? []).toEqual([]);
    expect(corrected.skillState?.invalidDraftFields ?? []).toEqual([]);
    expect(frame.computeMissing(corrected, 'execution').critical).toEqual([]);
    expect(progress(corrected)).toMatchObject({ criticalMissing: [], canProceed: true, nextAction: 'build_model' });
    expect(frame.buildModel(corrected)).toBeDefined();
    const repeated = frame.mergeState(corrected, normalizeLegacyDraftPatch({ engineeringDraft: { sections: { sectionProperties: { beam } } } }));
    expect(repeated.draftIssues ?? []).toEqual([]);
  });

  test('complete truss topology and loads resolve aggregate blockers; incomplete and contradictory data remain blocked', async () => {
    const { normalizeLegacyDraftPatch, mergeLegacyState, computeLegacyMissing } = await runtime();
    const fields = ['lengthM', 'heightM', 'bayCount', 'loadKN'];
    const initial = mergeLegacyState(undefined, normalizeLegacyDraftPatch({ inferredType: 'truss', lengthM: 6, heightM: 2, bayCount: 2, loadKN: 10,
      draftIssues: [{ field: 'topology', severity: 'invalid', reason: 'Connectivity missing.' }, { field: 'loads', severity: 'ambiguous', reason: 'Load targets unknown.' }],
    }), 'truss', 'truss');
    const partial = mergeLegacyState(initial, normalizeLegacyDraftPatch({ engineeringDraft: { topology: { nodes: topology.nodes }, loads: [{ ...load, location: undefined }] } }), 'truss', 'truss');
    expect(computeLegacyMissing(partial, 'execution', fields).critical).toEqual(expect.arrayContaining(['topology', 'loads']));
    const noSupports = mergeLegacyState(initial, normalizeLegacyDraftPatch({ engineeringDraft: { topology: {
      ...topology, nodes: topology.nodes.map(({ restraints: _restraints, ...node }) => node),
    } } }), 'truss', 'truss');
    expect(computeLegacyMissing(noSupports, 'execution', fields).critical).toContain('topology');
    const contradictory = mergeLegacyState(initial, normalizeLegacyDraftPatch({ engineeringDraft: { topology: {
      ...topology, members: [...topology.members, { id: 'M3', nodes: ['B', 'X'] }],
    }, loads: [{ ...load, target: 'C' }] } }), 'truss', 'truss');
    expect(computeLegacyMissing(contradictory, 'execution', fields).critical).toEqual(expect.arrayContaining(['topology', 'loads']));
    const corrected = mergeLegacyState(initial, normalizeLegacyDraftPatch({ engineeringDraft: { structureType: 'truss', topology, loads: [load] } }), 'truss', 'truss');
    expect(corrected.engineeringDraft.loads).toHaveLength(1);
    expect(corrected.draftIssues ?? []).toEqual([]);
    expect(corrected.skillState?.invalidDraftFields ?? []).toEqual([]);
    expect(computeLegacyMissing(corrected, 'execution', fields).critical).toEqual([]);
  });

  test('unknown footprint and unresolved free-form issue stay visible', async () => {
    const { normalizeLegacyDraftPatch, mergeLegacyState, computeLegacyMissing } = await runtime();
    const initial = mergeLegacyState(undefined, normalizeLegacyDraftPatch({ inferredType: 'truss', draftIssues: [
      { field: 'loads', severity: 'ambiguous', reason: 'Footprint unknown.' },
      { field: 'specialConnection', severity: 'ambiguous', reason: 'Connection stiffness unknown.' },
    ] }), 'truss', 'truss');
    const next = mergeLegacyState(initial, normalizeLegacyDraftPatch({ engineeringDraft: { loads: [{ kind: 'area', magnitude: 10, unit: 'kN/m2', target: 'floor' }] } }), 'truss', 'truss');
    expect(computeLegacyMissing(next, 'execution', []).critical).toEqual(expect.arrayContaining(['loads', 'specialConnection']));
  });
});
