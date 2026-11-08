import { describe, expect, test } from '@jest/globals';
import { AgentSkillLoader } from '../../../../../dist/agent-runtime/loader.js';
import { buildParamExtractorPrompt } from '../../../../../dist/agent-langgraph/param-extractor.js';
import { handler } from '../../../../../dist/agent-skills/structure-type/beam/handler.js';

const load = (target = 'beam', magnitude = 20, caseId = 'LC1') => ({
  kind: 'line', magnitude, unit: 'kN/m', direction: 'gravity', target, caseId,
});

function draft(loads, { interpretation, issue, nodes = [0, 3, 6], members } = {}) {
  const topology = {
    nodes: nodes.map((x, index) => ({
      id: `N${index + 1}`, x, y: 0, z: 0,
      ...(index === 0 ? { restraints: [true, true, true, false, false, false] } : {}),
      ...(index === nodes.length - 1 ? { restraints: [false, true, true, false, false, false] } : {}),
    })),
    members: (members ?? nodes.slice(1).map((_, index) => [`N${index + 1}`, `N${index + 2}`]))
      .map((ends, index) => ({ id: `M${index + 1}`, nodes: ends })),
  };
  const patch = handler.extractDraft({
    message: 'A simply supported beam with LC1 downward UDL.', locale: 'en',
    llmDraftPatch: {
      inferredType: 'beam', lengthM: 6, supportType: 'simply-supported', loadKN: loads[0].magnitude,
      engineeringDraft: {
        structureType: 'beam', geometry: { lengthM: 6, spanLengthsM: nodes.slice(1).map((x, index) => x - nodes[index]) }, topology,
        boundary: { supportType: 'simply-supported', supportPositionsM: [0, 6] },
        loads, analysis: { type: 'static', loadCombinations: [{ id: 'ULS', factors: { LC1: 1 } }] },
      },
      ...(interpretation ? { skillState: { beamLoadInterpretation: interpretation } } : {}),
      ...(issue ? {
        draftIssues: [{ field: 'engineeringDraft.loads[0].location', severity: 'ambiguous', reason: issue }],
        skillState: { ...(interpretation ? { beamLoadInterpretation: interpretation } : {}), invalidDraftFields: ['engineeringDraft.loads[0].location'] },
      } : {}),
    },
  });
  return handler.mergeState(undefined, patch);
}

describe('diagrammatic beam UDL convention', () => {
  test('bilingual skill guidance reaches parameter extraction and requires positive span evidence', () => {
    const plugin = new AgentSkillLoader().loadBundles().find((bundle) => bundle.id === 'beam');
    for (const locale of ['en', 'zh']) {
      const prompt = buildParamExtractorPrompt(locale, undefined, plugin, 'Interpret this beam drawing.');
      expect(prompt).toContain('beamLoadInterpretation');
      expect(prompt).toContain('diagrammatic-full-span');
      expect(prompt).toContain('partial');
    }
  });

  test('minor diagrammatic end gaps can produce two loaded elements and a disclosed assumption', () => {
    const state = draft([load()], { interpretation: 'diagrammatic-full-span' });
    expect(handler.computeMissing(state, 'execution').critical).toEqual([]);
    const model = handler.buildModel(state);
    expect(model.nodes.map(({ x }) => x)).toEqual([0, 3, 6]);
    expect(model.elements).toHaveLength(2);
    expect(model.load_cases[0].loads).toEqual([
      { type: 'distributed', element: '1', wz: -20, wy: 0, reference_frame: 'global' },
      { type: 'distributed', element: '2', wz: -20, wy: 0, reference_frame: 'global' },
    ]);
    expect(model.load_combinations).toEqual([{ id: 'ULS', factors: { LC1: 1 } }]);
    expect(model.metadata.beamLoadInterpretation).toEqual({ caseId: 'LC1', pressureKNM: 20, loadedLengthM: 6, basis: 'diagrammatic-full-span' });
    const report = handler.buildReportNarrative({
      message: 'Analyze the beam and report midspan deflection.', analysisType: 'static',
      analysisSuccess: true, codeCheckText: 'Not run', summary: 'Analysis succeeded.',
      keyMetrics: {}, clauseTraceability: [], controllingCases: {}, visualizationHints: {},
      normalizedModel: model,
      analysis: { data: { displacements: { '2': { ux: 0, uy: 0, uz: -0.002, rx: 0, ry: 0, rz: 0 } }, meta: { units: { displacement: 'm' } } } },
      locale: 'en',
    });
    expect(report).toContain('diagrammatic full-span');
    expect(report).toContain('20 kN/m');
    expect(report).toContain('6 m');
    expect(report).toContain('Midspan vertical deflection');
    expect(report).toContain('uz=-0.002 m');
    const reportZh = handler.buildReportNarrative({
      message: '分析并报告跨中挠度。', analysisType: 'static', analysisSuccess: true,
      codeCheckText: '未运行', summary: '分析完成。', keyMetrics: {}, clauseTraceability: [],
      controllingCases: {}, visualizationHints: {}, normalizedModel: model,
      analysis: { data: { displacements: { '2': { uz: -0.002 } }, meta: { units: { displacement: 'm' } } } },
      locale: 'zh',
    });
    expect(reportZh).toContain('图示全跨均布荷载约定');
    expect(reportZh).toContain('跨中竖向挠度');
  });

  test('exact support-to-support UDL loads both members without an inferred assumption', () => {
    const model = handler.buildModel(draft([load()]));
    expect(model.load_cases[0].loads).toHaveLength(2);
    expect(model.metadata.beamLoadInterpretation).toBeUndefined();
  });

  test('dimensioned partial load applies only to its specified member', () => {
    const model = handler.buildModel(draft([{ ...load('M1'), location: { spanIndex: 1 } }]));
    expect(model.load_cases[0].loads).toEqual([
      { type: 'distributed', element: '1', wz: -20, wy: 0, reference_frame: 'global' },
    ]);
  });

  test('clearly partial central load applies only to the central member', () => {
    const model = handler.buildModel(draft([load('M2')], { nodes: [0, 2, 4, 6] }));
    expect(model.load_cases[0].loads.map(({ element }) => element)).toEqual(['2', '3']);
  });

  test('multiple adjacent loads keep distinct extents and magnitudes', () => {
    const model = handler.buildModel(draft([load('M1', 20), load('M2', 12)]));
    expect(model.load_cases[0].loads.map(({ element, wz }) => [element, wz])).toEqual([['1', -20], ['2', -12]]);
    expect(model.metadata.beamLoadInterpretation).toBeUndefined();
  });

  test.each([
    'Written specification says the load begins 1 m from the left support.',
    'The load bar covers only the central region, with unclear endpoints.',
    'The load extent is unresolved.',
  ])('preserves a location blocker when %s', (issue) => {
    const state = draft([load()], { interpretation: 'diagrammatic-full-span', issue });
    expect(state.draftIssues?.map(({ field }) => field)).toContain('engineeringDraft.loads[0].location');
    expect(state.skillState.invalidDraftFields).toContain('engineeringDraft.loads[0].location');
    expect(handler.computeMissing(state, 'execution').critical).toContain('engineeringDraft.loads[0].location');
    expect(handler.buildModel(state)).toBeUndefined();
  });
});
