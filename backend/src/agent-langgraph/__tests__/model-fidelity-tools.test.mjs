import { describe, expect, test } from '@jest/globals';

const draftState = {
  inferredType: 'truss', engineeringDraft: {
    topology: { nodes: [{ id: 'A', x: 0, y: 0, z: 0 }, { id: 'B', x: 2, y: 0, z: 1 }], members: [{ id: 'M1', nodes: ['A', 'B'] }] },
  },
};
const model = {
  nodes: [{ id: 'A', x: 0, y: 0, z: 0 }, { id: 'B', x: 2, y: 0, z: 1 }],
  elements: [{ id: 'M1', type: 'truss', nodes: ['A', 'A'] }],
  load_cases: [{ id: 'LC1', loads: [] }], load_combinations: [{ id: 'ULS', factors: { LC1: 1 } }],
};

describe('model fidelity at tool boundaries', () => {
  test('build_model exposes a diagnostic and still stores the model', async () => {
    const { createBuildModelTool } = await import('../../../dist/agent-langgraph/tools.js');
    let builds = 0;
    const tool = createBuildModelTool({ async buildModel() { builds += 1; return model; } });
    const command = await tool.invoke({}, { toolCall: { id: 'build-fidelity' }, configurable: { skillScope: ['truss'], agentState: { draftState, locale: 'en' } } });
    const result = JSON.parse(command.update.messages[0].content);
    expect(result).toMatchObject({ success: true, fidelity: { status: 'mismatch' } });
    expect(result.fidelity.discrepancies[0].code).toBe('MEMBER_CONNECTIVITY_MISMATCH');
    expect(command.update.model).toEqual(model);
    expect(builds).toBe(1);
  });

  test('run_analysis recomputes the verdict and executes once despite mismatch', async () => {
    const { createRunAnalysisTool } = await import('../../../dist/agent-langgraph/tools.js');
    let analyses = 0;
    const tool = createRunAnalysisTool({ async executeAnalysisSkill() { analyses += 1; return { skillId: 'opensees-static', result: { success: true, analysisMode: 'static' } }; } });
    const command = await tool.invoke({ analysisType: 'static' }, {
      toolCall: { id: 'analysis-fidelity' },
      configurable: { skillScope: ['truss', 'opensees-static'], agentState: { draftState, model, locale: 'en', lastUserMessage: '' }, engineClient: {} },
    });
    const result = JSON.parse(command.update.messages[0].content);
    expect(result).toMatchObject({ success: true, fidelity: { status: 'mismatch' } });
    expect(analyses).toBe(1);
  });
});
