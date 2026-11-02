import { describe, expect, test } from '@jest/globals';
import { AgentSkillLoader } from '../../../dist/agent-runtime/loader.js';
import { buildParamExtractorPrompt } from '../../../dist/agent-langgraph/param-extractor.js';
import { handler as frame } from '../../../dist/agent-skills/structure-type/frame/handler.js';
import { handler as concrete } from '../../../dist/agent-skills/structure-type/concrete-frame/handler.js';

const geometry = { storyHeightsM: [3.6, 3.6], bayWidthsXM: [6, 6], bayWidthsYM: [5, 5] };
const areaLoads = [
  { kind: 'area', magnitude: 10, unit: 'kN/m2', direction: 'gravity', target: 'F1 floor', location: { story: 1 }, caseId: 'D', caseType: 'dead' },
  { kind: 'area', magnitude: 8, unit: 'kN/m2', direction: 'gravity', target: 'F2 floor', location: { story: 2 }, caseId: 'D', caseType: 'dead' },
];
const engineeringDraft = {
  structureType: 'frame', geometry, loads: areaLoads,
  analysis: { type: 'static', loadCombinations: [{ id: 'ULS', factors: { D: 1 } }] },
};

function extract(handler, draft, issue) {
  const patch = handler.extractDraft({
    message: '', locale: 'en', currentState: undefined,
    llmDraftPatch: {
      inferredType: 'frame', frameDimension: '3d',
      engineeringDraft: draft,
      ...(issue && {
        draftIssues: [{ field: issue, severity: 'ambiguous', reason: 'Loaded footprint is unresolved.' }],
        skillState: { invalidDraftFields: [issue] },
      }),
    },
  });
  return handler.mergeState(undefined, patch);
}

describe('full-floor area-load convention', () => {
  test('reproduces the saved complex-frame footprint blocker before guidance', () => {
    const state = extract(frame, engineeringDraft, 'frameAreaLoadFootprint');
    expect(state.draftIssues?.map((issue) => issue.field)).toContain('frameAreaLoadFootprint');
    expect(state.skillState?.invalidDraftFields).toContain('frameAreaLoadFootprint');
    expect(frame.computeMissing(state, 'execution').critical).toEqual(['frameAreaLoadFootprint']);
    expect(frame.buildModel(state)).toBeUndefined();
  });

  test('builds the complete 12 by 10 m, two-story frame without double loading', () => {
    const state = extract(frame, engineeringDraft);
    expect(frame.computeMissing(state, 'execution').critical).toEqual([]);
    expect(state.floorLoads).toEqual([{ story: 1, verticalKN: 1200 }, { story: 2, verticalKN: 960 }]);
    const model = frame.buildModel(state);
    expect(model.nodes).toHaveLength(27);
    expect(model.elements).toHaveLength(42);
    expect(model.stories.map((story) => ({ id: story.id, pressure: story.dead_load }))).toEqual([
      { id: 'F1', pressure: 10 }, { id: 'F2', pressure: 8 },
    ]);
    expect(model.load_cases).toEqual([expect.objectContaining({ id: 'D', type: 'dead', loads: [] })]);
    expect(model.load_combinations).toEqual([{ id: 'ULS', factors: { D: 1 } }]);
    expect(state.engineeringDraft.loads).toMatchObject(areaLoads);
  });

  test('keeps distinct story totals and cases in a concrete-frame draft', () => {
    const draft = {
      ...engineeringDraft,
      material: { family: 'concrete', grade: 'C30' },
      sections: { column: '500X500', beam: '300X600' },
    };
    const state = extract(concrete, draft);
    expect(state.floorLoads).toEqual([{ story: 1, verticalKN: 1200 }, { story: 2, verticalKN: 960 }]);
    expect(concrete.computeMissing(state, 'execution').critical).toEqual([]);
    const model = concrete.buildModel(state);
    expect(model.nodes).toHaveLength(27);
    expect(model.elements).toHaveLength(42);
    expect(model.stories.map((story) => story.dead_load)).toEqual([10, 8]);
    const dead = model.load_cases.find((loadCase) => loadCase.id === 'D');
    expect(dead.loads).toHaveLength(18);
    expect(dead.loads.filter((load) => load.story === 'F1').reduce((sum, load) => sum + load.fz, 0)).toBeCloseTo(-1200);
    expect(dead.loads.filter((load) => load.story === 'F2').reduce((sum, load) => sum + load.fz, 0)).toBeCloseTo(-960);
    expect(model.load_combinations[0].factors.D).toBe(1);
  });

  test('does not assign unlabeled F1/F2 area loads to stories by list order', () => {
    const untargeted = areaLoads.map(({ location, ...load }) => ({ ...load, target: 'annotated floor area' }));
    for (const handler of [frame, concrete]) {
      const state = extract(handler, { ...engineeringDraft, loads: untargeted });
      expect(state.floorLoads ?? []).toEqual([]);
      expect(handler.computeMissing(state, 'execution').critical).toContain('floorLoads');
      expect(handler.buildModel(state)).toBeUndefined();
    }
  });

  test.each([
    ['unknown story', 'engineeringDraft.loads.target'],
    ['unknown perimeter', 'frameAreaLoadFootprint'],
    ['partial region', 'frameAreaLoadFootprint'],
    ['opening or exclusion', 'frameAreaLoadFootprint'],
    ['contradictory limits', 'frameAreaLoadFootprint'],
    ['localized pressure', 'frameAreaLoadFootprint'],
    ['wrong structural level', 'engineeringDraft.loads.target'],
  ])('keeps %s blocking when extraction identifies it as unresolved', (_case, field) => {
    const state = extract(frame, engineeringDraft, field);
    expect(frame.computeMissing(state, 'execution').critical).toContain(field);
    expect(frame.buildModel(state)).toBeUndefined();
  });

  test('frame and concrete-frame extraction prompts include the scoped convention', () => {
    const bundles = new AgentSkillLoader().loadBundles();
    for (const id of ['frame', 'concrete-frame']) {
      const plugin = bundles.find((bundle) => bundle.id === id);
      const prompt = buildParamExtractorPrompt('en', undefined, plugin, 'Build the 3D frame.');
      expect(prompt).toContain('complete floor footprint');
      expect(prompt).toContain('Do not assign F1/F2 to stories solely from their order');
    }
  });
});
