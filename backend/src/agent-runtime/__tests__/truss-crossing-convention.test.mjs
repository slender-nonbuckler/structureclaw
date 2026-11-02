import { describe, expect, test } from '@jest/globals';
import { AgentSkillLoader } from '../../../dist/agent-runtime/loader.js';
import { buildParamExtractorPrompt } from '../../../dist/agent-langgraph/param-extractor.js';
import { handler } from '../../../dist/agent-skills/structure-type/truss/handler.js';

const nodes = [
  { id: 'A', x: 0, y: 0, z: 0, restraints: [true, true, true, false, false, false] },
  { id: 'B', x: 2, y: 0, z: 1.5 },
  { id: 'C', x: 4, y: 0, z: 3 },
  { id: 'D', x: 6, y: 0, z: 1.5 },
  { id: 'E', x: 8, y: 0, z: 0, restraints: [false, true, true, false, false, false] },
  { id: 'F', x: 4, y: 0, z: 0 },
];
const commonMembers = [
  ['A', 'B'], ['B', 'C'], ['C', 'D'], ['D', 'E'],
  ['A', 'F'], ['F', 'E'], ['B', 'F'], ['F', 'D'],
];
const unconnectedMembers = [...commonMembers, ['B', 'D'], ['C', 'F']];
const connectedMembers = [...commonMembers, ['B', 'X'], ['X', 'D'], ['C', 'X'], ['X', 'F']];
const conflictingVisionSummary = 'X is the visible intersection of continuous members B-D and C-F; no explicit joint marker is shown. The members list splits both at X. Connectivity is ambiguous.';
const unconnectedVisionSummary = 'Connected joints elsewhere have dots. Continuous members B-D and C-F cross at X without a dot or terminating end.';

function stateFor(members, withCrossing, issue = false, message = '') {
  const patch = handler.extractDraft({
    message, locale: 'en', currentState: undefined,
    llmDraftPatch: {
      inferredType: 'truss', lengthM: 8, heightM: 3, bayCount: 2, loadKN: 20,
      engineeringDraft: {
        structureType: 'truss',
        topology: {
          nodes: withCrossing ? [...nodes, { id: 'X', x: 4, y: 0, z: 1.5 }] : nodes,
          members: members.map((endpoints, index) => ({ id: `M${index + 1}`, nodes: endpoints })),
        },
        loads: [{ kind: 'nodal', magnitude: 20, unit: 'kN', direction: 'gravity', caseId: 'LC1', location: { nodeId: 'C' } }],
      },
      ...(issue && {
        draftIssues: [{ field: 'topology', severity: 'ambiguous', reason: 'Crossing connectivity conflicts with drawing evidence.' }],
        skillState: { invalidDraftFields: ['topology'] },
      }),
    },
  });
  return handler.mergeState(undefined, patch);
}

describe('truss crossing interpretation', () => {
  test('reproduces acceptance of an ambiguous crossing when extraction wrongly supplies a connected node', () => {
    const state = stateFor(connectedMembers, true, false, conflictingVisionSummary);
    expect(state.draftIssues ?? []).toEqual([]);
    expect(handler.computeMissing(state, 'execution').critical).toEqual([]);
    const model = handler.buildModel(state);
    expect(model.nodes).toHaveLength(7);
    expect(model.elements).toHaveLength(12);
  });

  test('preserves continuous members at an unmarked crossing when extraction supplies that topology', () => {
    const model = handler.buildModel(stateFor(unconnectedMembers, false, false, unconnectedVisionSummary));
    expect(model.nodes).toHaveLength(6);
    expect(model.elements).toHaveLength(10);
    expect(model.elements.map((member) => member.nodes)).toEqual(expect.arrayContaining([['B', 'D'], ['C', 'F']]));
  });

  test.each([
    'A joint dot marks X as connected.',
    'The connection detail explicitly joins the members at X even though no dot is drawn.',
  ])('preserves a connected crossing when %s', (message) => {
    const model = handler.buildModel(stateFor(connectedMembers, true, false, message));
    expect(model.nodes).toHaveLength(7);
    expect(model.elements).toHaveLength(12);
    expect(model.elements.map((member) => member.nodes)).toEqual(expect.arrayContaining([['B', 'X'], ['X', 'D']]));
  });

  test('preserves a member that terminates at a connection', () => {
    const terminatingMembers = [...commonMembers, ['B', 'X'], ['X', 'D'], ['C', 'X']];
    const model = handler.buildModel(stateFor(terminatingMembers, true, false, 'The vertical member from C terminates and connects at X.'));
    expect(model.nodes).toHaveLength(7);
    expect(model.elements).toHaveLength(11);
    expect(model.elements.map((member) => member.nodes)).toContainEqual(['C', 'X']);
    expect(model.elements.map((member) => member.nodes)).not.toContainEqual(['X', 'F']);
  });

  test('contradictory crossing evidence stays blocking when extraction reports a topology issue', () => {
    const state = stateFor(connectedMembers, true, true);
    expect(state.draftIssues.map(({ field }) => field)).toContain('topology');
    expect(state.skillState.invalidDraftFields).toContain('topology');
    expect(handler.computeMissing(state, 'execution').critical).toContain('topology');
    expect(handler.buildModel(state)).toBeUndefined();
  });

  test('Turn 2 extraction prompt includes bilingual crossing guidance', () => {
    const plugin = new AgentSkillLoader().loadBundles().find((bundle) => bundle.id === 'truss');
    const prompt = buildParamExtractorPrompt('en', undefined, plugin, conflictingVisionSummary);
    expect(prompt).toContain('A geometric crossing is not automatically a structural joint');
    expect(prompt).toContain('连续杆件');
    expect(prompt).toContain('joint dots or symbols');
    expect(prompt).toContain('terminates there');
    expect(prompt).toContain('explicit connection detail');
    expect(prompt).toContain('connected crossing without a dot');
    expect(prompt).toContain('skillState.invalidDraftFields');
  });
});
