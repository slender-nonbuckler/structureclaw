import { describe, expect, jest, test } from '@jest/globals';

const llmPatch = {
  inferredType: 'truss', lengthM: 8, heightM: 3, bayCount: 2, loadKN: 10,
  engineeringDraft: {
    structureType: 'truss',
    topology: {
      nodes: [
        { id: 'A', x: 0, y: 0, z: 1, restraints: [true, true, true, false, false, false] },
        { id: 'B', x: 8, y: 0, z: 1 },
        { id: 'C', x: 4, y: 0, z: 3 },
        { id: 'D', x: 4, y: 0, z: 0, restraints: [false, true, true, false, false, false] },
        { id: 'X', x: 4, y: 0, z: 1 },
      ],
      members: [['A', 'X'], ['X', 'B'], ['C', 'X'], ['X', 'D']]
        .map((nodes, index) => ({ id: `M${index + 1}`, nodes })),
    },
    loads: [{ kind: 'nodal', magnitude: 10, unit: 'kN', direction: 'gravity', caseId: 'LC1', location: { nodeId: 'C' } }],
  },
};
const invokeParamExtractor = jest.fn(async () => llmPatch);
jest.unstable_mockModule('../../../dist/agent-langgraph/param-extractor.js', () => ({ invokeParamExtractor }));

const { AgentSkillRuntime } = await import('../../../dist/agent-runtime/index.js');
const { createExtractDraftParamsTool } = await import('../../../dist/agent-langgraph/tools.js');

describe('truss crossing evidence at extraction tool boundary', () => {
  test('checkpointed vision uncertainty blocks a confident connected topology without another LLM call', async () => {
    invokeParamExtractor.mockClear();
    const vision = `[Benchmark vision attachment summaries]\n#1\n${JSON.stringify({
      structuralType: '2D truss',
      nodes: ['A: x=0 m, z=1 m', 'B: x=8 m, z=1 m', 'C: x=4 m, z=3 m', 'D: x=4 m, z=0 m', 'X: unmarked crossing, x=4 m, z=1 m'],
      members: ['A-X', 'X-B', 'C-X', 'X-D'],
      missingOrUnclear: ['X is an unmarked line intersection; crossing connectivity is not explicitly marked with a joint symbol.'],
    })}`;
    const message = 'Use steel section T1 and analyze LC1.';
    const result = await createExtractDraftParamsTool(new AgentSkillRuntime()).invoke(
      { message, locale: 'en' },
      { toolCall: { id: 'crossing-evidence' }, configurable: {
        skillScope: ['truss'],
        agentState: {
          structuralTypeKey: 'truss', draftState: null, locale: 'en', lastUserMessage: message,
          messages: [{ role: 'human', content: vision }, { role: 'human', content: message }],
        },
      } },
    );
    const response = JSON.parse(result.update.messages[0].content);
    expect(response.skillId).toBe('truss');
    expect(response.nextState.draftIssues.map(({ field }) => field)).toContain('topology');
    expect(response.nextState.skillState.invalidDraftFields).toContain('topology');
    expect(response.criticalMissing).toContain('topology');
    expect(response.canProceed).toBe(false);
    expect(response.nextAction).toBe('ask_user_clarification');
    expect(invokeParamExtractor).toHaveBeenCalledTimes(1);
  });
});
