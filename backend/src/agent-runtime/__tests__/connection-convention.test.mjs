import { describe, expect, test } from '@jest/globals';
import { AgentSkillLoader } from '../../../dist/agent-runtime/loader.js';
import { buildParamExtractorPrompt } from '../../../dist/agent-langgraph/param-extractor.js';
import { handler as frame } from '../../../dist/agent-skills/structure-type/frame/handler.js';
import { handler as portal } from '../../../dist/agent-skills/structure-type/portal-frame/handler.js';

const cases = [
  {
    name: 'single-span portal construction',
    handler: portal,
    issueField: 'topology.members.endReleases',
    input: {
      inferredType: 'portal-frame',
      engineeringDraft: {
        structureType: 'portal-frame',
        geometry: { spanLengthsM: [18], heightM: 7 },
        sections: { beam: 'H600x250x10x16', column: 'H600x250x10x16' },
        boundary: { frameBaseSupportType: 'fixed' },
        loads: [{ kind: 'line', magnitude: 6, unit: 'kN/m', direction: 'gravity', target: 'roof', caseId: 'LC1' }],
      },
    },
    nodes: 4,
    members: 3,
  },
  {
    name: 'two-span portal construction',
    handler: portal,
    issueField: 'topology.memberReleases',
    input: {
      inferredType: 'portal-frame',
      engineeringDraft: {
        structureType: 'portal-frame',
        geometry: { spanLengthsM: [18, 18], heightM: 9 },
        sections: { beam: 'H700x300x12x20', column: 'H700x300x12x20' },
        boundary: { frameBaseSupportType: 'fixed' },
        loads: [
          { kind: 'line', magnitude: 6, unit: 'kN/m', direction: 'gravity', target: 'roof', caseId: 'LC1' },
        ],
      },
    },
    nodes: 6,
    members: 5,
  },
  {
    name: 'two-story two-bay frame mechanics',
    handler: frame,
    issueField: 'memberEndReleases',
    input: {
      inferredType: 'frame',
      frameDimension: '2d',
      storyCount: 2,
      bayCount: 2,
      storyHeightsM: [3.6, 3.6],
      bayWidthsM: [5.4, 6],
      floorLoads: [{ story: 1, verticalKN: 100 }, { story: 2, verticalKN: 100 }],
      frameBaseSupportType: 'fixed',
      frameColumnSection: 'HW350X350',
      frameBeamSection: 'HN500X200',
    },
    nodes: 9,
    members: 10,
  },
];

function stateFor(scenario, issue) {
  const llmDraftPatch = {
    ...scenario.input,
    ...(issue ? {
      draftIssues: [{ field: scenario.issueField, severity: 'ambiguous', reason: issue }],
      skillState: { invalidDraftFields: [scenario.issueField] },
    } : {}),
  };
  const patch = scenario.handler.extractDraft({
    message: '', locale: 'en', currentState: undefined, llmDraftPatch,
  });
  return scenario.handler.mergeState(undefined, patch);
}

describe('frame and portal connection convention', () => {
  test.each(cases)('reproduces saved release blocker: $name', (scenario) => {
    const state = stateFor(scenario, 'No joint end-release label is shown.');
    const missing = scenario.handler.computeMissing(state, 'execution');
    expect(state.draftIssues?.map((issue) => issue.field)).toContain(scenario.issueField);
    expect(state.skillState?.invalidDraftFields).toContain(scenario.issueField);
    expect(missing.critical).toEqual([scenario.issueField]);
    expect(missing.critical.length === 0).toBe(false); // buildDraftProgress.canProceed
    expect(scenario.handler.buildModel(state)).toBeUndefined();
  });

  test.each(cases)('builds conventional continuous model without an invented blocker: $name', (scenario) => {
    const state = stateFor(scenario);
    const missing = scenario.handler.computeMissing(state, 'execution');
    expect(state.draftIssues).toBeUndefined();
    expect(state.skillState?.invalidDraftFields ?? []).toEqual([]);
    expect(missing.critical).toEqual([]);
    expect(missing.critical.length === 0).toBe(true); // buildDraftProgress.canProceed
    const model = scenario.handler.buildModel(state);
    expect(model.nodes).toHaveLength(scenario.nodes);
    expect(model.elements).toHaveLength(scenario.members);
    expect(model.elements.every((element) => element.releases === undefined)).toBe(true);
  });

  test('explicit hinge or contradictory connection evidence remains blocking', () => {
    for (const scenario of [cases[0], cases[2]]) {
      for (const reason of ['Explicit hinge at a beam end.', 'Drawing and specification conflict about a joint release.']) {
        const state = stateFor(scenario, reason);
        expect(scenario.handler.computeMissing(state, 'execution').critical).toContain(scenario.issueField);
        expect(scenario.handler.buildModel(state)).toBeUndefined();
      }
    }
  });

  test('generic frame without connection evidence remains blocked when flagged', () => {
    const state = stateFor(cases[2], 'Connection behavior is genuinely unresolved.');
    expect(frame.computeMissing(state, 'execution').critical).toContain('memberEndReleases');
  });

  test('column-base pin and fixed restraint remain distinct from beam-column continuity', () => {
    for (const scenario of [cases[0], cases[2]]) {
      const fixed = scenario.handler.buildModel(stateFor(scenario));
      const pinnedInput = {
        ...scenario.input,
        frameBaseSupportType: 'pinned',
        engineeringDraft: scenario.input.engineeringDraft && {
          ...scenario.input.engineeringDraft,
          boundary: { frameBaseSupportType: 'pinned' },
        },
      };
      const pinned = scenario.handler.buildModel(stateFor({ ...scenario, input: pinnedInput }));
      expect(fixed.nodes[0].restraints).not.toEqual(pinned.nodes[0].restraints);
      expect(fixed.elements.map((element) => element.nodes)).toEqual(pinned.elements.map((element) => element.nodes));
    }
  });

  test('both skill draft guides reach the actual extraction prompt', () => {
    const bundles = new AgentSkillLoader().loadBundles();
    for (const skillId of ['frame', 'portal-frame']) {
      const plugin = bundles.find((bundle) => bundle.id === skillId);
      expect(plugin?.markdownByStage.draft).toContain('beam-column');
      const prompt = buildParamExtractorPrompt('en', undefined, plugin, 'Build this frame.');
      expect(prompt).toContain('moment-continuous beam-column');
    }
  });

  test('frame and portal reports disclose the modeled joint convention in both locales', () => {
    for (const handler of [frame, portal]) {
      for (const locale of ['en', 'zh']) {
        const report = handler.buildReportNarrative({
          message: 'Frame analysis', analysisType: 'static', analysisSuccess: true,
          codeCheckText: '', summary: '', keyMetrics: {}, clauseTraceability: [],
          controllingCases: {}, visualizationHints: {}, locale,
        });
        expect(report).toContain(locale === 'en' ? 'beam-column joints are moment-continuous' : '梁柱节点按弯矩连续处理');
        expect(report).toContain(locale === 'en' ? 'column-base restraints' : '柱脚约束');
      }
    }
  });
});
