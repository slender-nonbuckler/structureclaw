import { describe, expect, test } from '@jest/globals';

const nodal = (nodeId, magnitude = 15, extra = {}) => ({
  kind: 'nodal', magnitude, unit: 'kN', direction: 'gravity',
  target: nodeId, location: { nodeId, nodeRole: 'bottom' }, caseId: 'LC1', ...extra,
});

async function runtime() {
  const draft = await import('../../../dist/agent-runtime/engineering-draft.js');
  const { mergeDraftState } = await import('../../../dist/agent-runtime/fallback.js');
  return { ...draft, mergeDraftState };
}

describe('truss load identity', () => {
  test.each([[5, 15], [4, 10]])('retains %i distinct bottom-node loads of %i kN through normalization and merge', async (count, magnitude) => {
    const { normalizeEngineeringDraft, mergeDraftState } = await runtime();
    const loads = Array.from({ length: count }, (_, index) => nodal(`B${index + 1}`, magnitude));
    const patch = { engineeringDraft: normalizeEngineeringDraft({ structureType: 'truss', loads }) };
    const state = mergeDraftState(undefined, patch);
    expect(state.engineeringDraft.loads.map((load) => load.location.nodeId)).toEqual(loads.map((load) => load.location.nodeId));
    expect(state.engineeringDraft.loads).toHaveLength(count);
    const { handler } = await import('../../../dist/agent-skills/structure-type/truss/handler.js');
    const model = handler.buildModel({ ...state, inferredType: 'truss', lengthM: (count + 1) * 3, heightM: 3, bayCount: count + 1, loadKN: magnitude });
    expect(model.load_cases[0].loads.map((load) => [load.node, load.fz])).toEqual(
      loads.map((load) => [load.location.nodeId, -magnitude]),
    );
  });

  test('repeated full extraction is idempotent and partial updates keep unrelated nodes', async () => {
    const { normalizeEngineeringDraft, mergeDraftState } = await runtime();
    const patch = { engineeringDraft: normalizeEngineeringDraft({ structureType: 'truss', loads: [nodal('B1'), nodal('B2')] }) };
    const first = mergeDraftState(undefined, patch);
    const repeated = mergeDraftState(first, patch);
    expect(repeated.engineeringDraft.loads).toHaveLength(2);
    const partial = mergeDraftState(repeated, { engineeringDraft: normalizeEngineeringDraft({ loads: [nodal('B2', 20)] }) });
    expect(partial.engineeringDraft.loads.map((load) => [load.location.nodeId, load.magnitude])).toEqual([['B1', 15], ['B2', 20]]);
  });

  test('named node targets survive a generic bottom role and reach the intended model nodes', async () => {
    const { handler } = await import('../../../dist/agent-skills/structure-type/truss/handler.js');
    const patch = handler.extractDraft({ message: '', llmDraftPatch: {
      inferredType: 'truss',
      engineeringDraft: { structureType: 'truss', loads: [nodal('B1', 10, { target: 'node B1', location: { nodeRole: 'bottom' } }), nodal('B2', 10, { target: 'node B2', location: { nodeRole: 'bottom' } })] },
      lengthM: 9, heightM: 2, bayCount: 3, loadKN: 10,
    } });
    const state = handler.mergeState(undefined, patch);
    expect(state.engineeringDraft.loads).toHaveLength(2);
    expect(handler.buildModel(state).load_cases[0].loads.map((load) => load.node)).toEqual(['B1', 'B2']);
  });

  test('explicit non-B/T node targets remain distinct', async () => {
    const { normalizeEngineeringDraft, mergeEngineeringDraft } = await runtime();
    const patch = normalizeEngineeringDraft({ structureType: 'truss', loads: [
      nodal('N1', 10, { location: { nodeRole: 'bottom' } }),
      nodal('N2', 10, { location: { nodeRole: 'bottom' } }),
    ] });
    expect(mergeEngineeringDraft(undefined, patch).loads.map((load) => load.target)).toEqual(['N1', 'N2']);
  });

  test('separate load IDs at one node survive', async () => {
    const { normalizeEngineeringDraft, mergeDraftState } = await runtime();
    const patch = { engineeringDraft: normalizeEngineeringDraft({ structureType: 'truss', loads: [nodal('B1', 15, { id: 'P1' }), nodal('B1', 15, { id: 'P2' })] }) };
    const state = mergeDraftState(undefined, patch);
    expect(state.engineeringDraft.loads.map((load) => load.id)).toEqual(['P1', 'P2']);
    expect(mergeDraftState(state, patch).engineeringDraft.loads.map((load) => load.id)).toEqual(['P1', 'P2']);
  });

  test('conflicting explicit node identities surface an issue', async () => {
    const { normalizeLegacyDraftPatch } = await import('../../../dist/agent-runtime/legacy.js');
    const patch = normalizeLegacyDraftPatch({ engineeringDraft: { structureType: 'truss', loads: [nodal('B1', 15, { target: 'B2' })] } });
    expect(patch.draftIssues).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'engineeringDraft.loads', severity: 'conflict' })]));
    expect(patch.engineeringDraft?.loads ?? []).toHaveLength(0);
  });

  test('ambiguous repeated same-node loads surface an issue', async () => {
    const { normalizeLegacyDraftPatch } = await import('../../../dist/agent-runtime/legacy.js');
    const patch = normalizeLegacyDraftPatch({ engineeringDraft: { structureType: 'truss', loads: [nodal('B1'), nodal('B1')] } });
    expect(patch.draftIssues).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'engineeringDraft.loads', severity: 'ambiguous' })]));
  });
});
