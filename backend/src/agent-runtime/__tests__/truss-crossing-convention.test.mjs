import { describe, expect, test } from '@jest/globals';
import { AgentSkillLoader } from '../../../dist/agent-runtime/loader.js';
import { buildParamExtractorPrompt } from '../../../dist/agent-langgraph/param-extractor.js';
import { handler } from '../../../dist/agent-skills/structure-type/truss/handler.js';
import { resolveTrussExtractionEvidenceMessage } from '../../../dist/agent-langgraph/tools.js';

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
const crossingVision = {
  structuralType: '2D truss',
  nodes: ['B: x=2 m, z=1.5 m', 'C: x=4 m, z=3 m', 'D: x=6 m, z=1.5 m', 'F: x=4 m, z=0 m', 'X: unmarked crossing, x=4 m, z=1.5 m'],
  members: ['B-X', 'X-D', 'C-X', 'X-F'],
  missingOrUnclear: ['X is an unmarked line intersection; connection of crossing members is not explicitly marked with a joint symbol.'],
};
const visionMessage = (vision) => `[Benchmark vision attachment summaries]\n#1\n${JSON.stringify(vision)}`;

function stateFor(members, withCrossing, issue = false, message = '', existing) {
  const patch = handler.extractDraft({
    message, locale: 'en', currentState: existing,
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
  return handler.mergeState(existing, patch);
}

describe('truss crossing interpretation', () => {
  test('rejects a connected crossing that contradicts an identifiable unresolved vision observation', () => {
    const state = stateFor(connectedMembers, true, false, visionMessage(crossingVision));
    expect(state.draftIssues?.map(({ field }) => field)).toContain('topology');
    expect(state.skillState.invalidDraftFields).toContain('topology');
    expect(handler.computeMissing(state, 'execution').critical).toContain('topology');
    expect(handler.buildModel(state)).toBeUndefined();
  });

  test('also identifies an unresolved crossing when vision lists the two members as continuous', () => {
    const state = stateFor(connectedMembers, true, false, visionMessage({
      ...crossingVision, members: ['B-D', 'C-F'],
    }));
    expect(state.draftIssues?.map(({ field }) => field)).toContain('topology');
    expect(handler.computeMissing(state, 'execution').critical).toContain('topology');
  });

  test('allows a later explicit connection detail to resolve the vision uncertainty', () => {
    const state = stateFor(connectedMembers, true, false,
      `A connection detail explicitly connects X.\n${visionMessage(crossingVision)}`);
    expect(state.draftIssues ?? []).toEqual([]);
    expect(handler.computeMissing(state, 'execution').critical).toEqual([]);
    expect(handler.buildModel(state)?.nodes).toHaveLength(7);
  });

  test('allows a direct user instruction that the crossing must be connected', () => {
    const state = stateFor(connectedMembers, true, false,
      `X must be connected.\n${visionMessage(crossingVision)}`);
    expect(handler.computeMissing(state, 'execution').critical).toEqual([]);
    expect(handler.buildModel(state)?.nodes).toHaveLength(7);
  });

  test('allows an explicit connected crossing recorded in the vision summary', () => {
    const state = stateFor(connectedMembers, true, false, visionMessage({
      ...crossingVision,
      notes: ['A connection detail explicitly joins the members at X without a dot.'],
    }));
    expect(handler.computeMissing(state, 'execution').critical).toEqual([]);
    expect(handler.buildModel(state)?.elements).toHaveLength(12);
  });

  test('keeps continuous members when vision records an unresolved but unconnected crossing', () => {
    const state = stateFor(unconnectedMembers, false, false, visionMessage({
      ...crossingVision,
      members: ['B-D', 'C-F'],
      notes: ['Connected joints elsewhere are marked with dots; X has no dot.'],
    }));
    expect(handler.computeMissing(state, 'execution').critical).toEqual([]);
    expect(handler.buildModel(state)?.elements).toHaveLength(10);
  });

  test('does not treat absence of a connection detail as affirmative evidence', () => {
    const state = stateFor(connectedMembers, true, false, visionMessage({
      ...crossingVision,
      notes: ['No connection detail is shown at X.'],
    }));
    expect(handler.computeMissing(state, 'execution').critical).toContain('topology');
  });

  test('does not infer ambiguity when the crossing lacks a locatable identity', () => {
    const state = stateFor(connectedMembers, true, false, visionMessage({
      ...crossingVision, nodes: crossingVision.nodes.filter((node) => !node.startsWith('X:')),
    }));
    expect(state.draftIssues ?? []).toEqual([]);
  });

  test('does not block a terminating member at an otherwise uncertain crossing', () => {
    const terminating = [...commonMembers, ['B', 'X'], ['X', 'D'], ['C', 'X']];
    const state = stateFor(terminating, true, false, visionMessage(crossingVision));
    expect(state.draftIssues ?? []).toEqual([]);
    expect(handler.buildModel(state)?.elements).toHaveLength(11);
  });

  test('a complete unconnected correction clears the specific topology issue', () => {
    const blocked = stateFor(connectedMembers, true, false, visionMessage(crossingVision));
    const corrected = stateFor(unconnectedMembers, false, false, visionMessage(crossingVision), blocked);
    expect(corrected.draftIssues ?? []).toEqual([]);
    expect(corrected.skillState.invalidDraftFields ?? []).not.toContain('topology');
    expect(handler.computeMissing(corrected, 'execution').critical).toEqual([]);
    expect(handler.buildModel(corrected)?.elements).toHaveLength(10);
  });

  test('repeated contradictory extraction keeps one topology issue', () => {
    const blocked = stateFor(connectedMembers, true, false, visionMessage(crossingVision));
    const repeated = stateFor(connectedMembers, true, false, visionMessage(crossingVision), blocked);
    expect(repeated.draftIssues?.filter(({ field }) => field === 'topology')).toHaveLength(1);
  });

  test('uses checkpointed vision evidence on a parameter-only continuation turn', () => {
    const vision = visionMessage(crossingVision);
    const message = resolveTrussExtractionEvidenceMessage(
      'truss', 'current-state', 'Use steel T1 and analyze LC1.',
      [{ role: 'human', content: vision }, { role: 'human', content: 'Use steel T1 and analyze LC1.' }],
    );
    expect(message).toContain(vision);
    const state = stateFor(connectedMembers, true, false, message);
    expect(handler.computeMissing(state, 'execution').critical).toContain('topology');
    expect(resolveTrussExtractionEvidenceMessage('frame', 'current-state', 'new frame', [{ role: 'human', content: vision }]))
      .toBe('new frame');
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
