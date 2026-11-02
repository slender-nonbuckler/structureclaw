import { describe, expect, test } from '@jest/globals';
import { handler } from '../../../../../dist/agent-skills/structure-type/portal-frame/handler.js';

describe('portal-frame handler', () => {
  test('detects portal-frame requests deterministically', () => {
    const match = handler.detectStructuralType({
      message: '门式刚架，跨度18m，高度6m',
      locale: 'zh',
    });

    expect(match?.skillId).toBe('portal-frame');
    expect(match?.mappedType).toBe('portal-frame');
  });

  test('keeps portal-frame load-position guidance deterministic', () => {
    const [question] = handler.buildQuestions(
      ['loadPosition'],
      ['loadPosition'],
      { inferredType: 'portal-frame', updatedAt: 0 },
      'zh',
    );

    expect(question.suggestedValue).toBe('full-span');
    expect(question.question).toContain('full-span');
  });

  test('builds double-span portal frame geometry from engineeringDraft', () => {
    const patch = handler.extractDraft({
      message: '',
      llmDraftPatch: {
        engineeringDraft: {
          structureType: 'portal-frame',
          geometry: { spanLengthsM: [18, 18], heightM: 9 },
          loads: [
            { kind: 'line', magnitude: 6, unit: 'kN/m', direction: 'gravity', target: 'roof' },
            { kind: 'point', magnitude: 49, unit: 'kN', direction: 'gravity', target: 'middle column top', location: { nodeRole: 'middle-column-top' } },
            { kind: 'point', magnitude: 4.9, unit: 'kN', direction: 'globalX', target: 'middle column top', location: { nodeRole: 'middle-column-top' } },
          ],
        },
      },
    });
    const state = handler.mergeState(undefined, patch);
    const model = handler.buildModel(state);

    expect(handler.computeMissing(state, 'execution').critical).toEqual([]);
    expect(state.skillState).toEqual(expect.objectContaining({
      portalBaySpansM: [18, 18],
      portalBayCount: 2,
      roofLoadKNM: 6,
    }));
    expect(model.nodes).toHaveLength(6);
    expect(model.elements).toHaveLength(5);
    expect(model.metadata.geometry.spanLengthsM).toEqual([18, 18]);
    expect(model.load_cases[0].loads).toEqual(expect.arrayContaining([
      expect.objectContaining({ element: 'R0', wz: -6 }),
      expect.objectContaining({ node: 'T1', fz: -49 }),
      expect.objectContaining({ node: 'T1', fx: 4.9 }),
    ]));
  });

  test('builds a simple mezzanine portal-frame idealization', () => {
    const patch = handler.extractDraft({
      message: '',
      llmDraftPatch: {
        inferredType: 'portal-frame',
        spanLengthM: 18,
        heightM: 7,
        loadKN: 6,
        loadType: 'distributed',
        loadPosition: 'full-span',
        skillState: {
          roofLoadKNM: 6,
          mezzanineHeightM: 3,
          mezzanineLengthM: 6,
          mezzanineLoadKN: 4,
        },
      },
    });
    const state = handler.mergeState(undefined, patch);
    const model = handler.buildModel(state);

    expect(handler.computeMissing(state, 'execution').critical).toEqual([]);
    expect(model.nodes).toHaveLength(6);
    expect(model.elements).toHaveLength(5);
    expect(model.metadata).toEqual(expect.objectContaining({ hasMezzanine: true }));
    expect(model.load_cases[0].loads).toEqual(expect.arrayContaining([
      expect.objectContaining({ element: 'R0', wz: -6 }),
      expect.objectContaining({ element: 'MEZ1', wz: -4 }),
    ]));
  });

  test('maps mezzanine engineeringDraft fields into portal-frame state', () => {
    const patch = handler.extractDraft({
      message: '',
      llmDraftPatch: {
        engineeringDraft: {
          structureType: 'portal-frame',
          geometry: { spanLengthsM: [18], heightM: 7, mezzanineHeightM: '', platform: { heightM: 3, lengthM: 6 } },
          loads: [
            { kind: 'line', magnitude: 4, unit: 'kN/m', direction: 'gravity', target: '夹层梁' },
            { kind: 'line', magnitude: 6, unit: 'kN/m', direction: 'gravity', target: '屋面' },
          ],
        },
      },
    });
    const state = handler.mergeState(undefined, patch);
    const model = handler.buildModel(state);

    expect(handler.computeMissing(state, 'execution').critical).toEqual([]);
    expect(state.loadKN).toBe(6);
    expect(state.skillState).toEqual(expect.objectContaining({
      portalBaySpansM: [18],
      roofLoadKNM: 6,
      mezzanineHeightM: 3,
      mezzanineLengthM: 6,
      mezzanineLoadKN: 4,
    }));
    expect(model.metadata).toEqual(expect.objectContaining({ hasMezzanine: true }));
    expect(model.load_cases[0].loads).toEqual(expect.arrayContaining([
      expect.objectContaining({ element: 'R0', wz: -6 }),
      expect.objectContaining({ element: 'MEZ1', wz: -4 }),
    ]));
  });

  test('does not treat mezzanine point loads as distributed beam loads', () => {
    const patch = handler.extractDraft({
      message: '',
      llmDraftPatch: {
        engineeringDraft: {
          structureType: 'portal-frame',
          geometry: { spanLengthsM: [18], heightM: 7, mezzanineHeightM: 3, mezzanineLengthM: 6 },
          loads: [
            { kind: 'line', magnitude: 6, unit: 'kN/m', direction: 'gravity', target: 'roof' },
            { kind: 'point', magnitude: 12, unit: 'kN', direction: 'gravity', target: 'mezzanine' },
          ],
        },
      },
    });
    const state = handler.mergeState(undefined, patch);
    const model = handler.buildModel(state);

    expect(state.skillState?.mezzanineLoadKN).toBeUndefined();
    expect(model.load_cases[0].loads).toEqual(expect.arrayContaining([
      expect.objectContaining({ element: 'R0', wz: -6 }),
    ]));
    expect(model.load_cases[0].loads).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ element: 'MEZ1' }),
    ]));
  });

  test('does not duplicate ambiguous roof mezzanine line loads', () => {
    const patch = handler.extractDraft({
      message: '',
      llmDraftPatch: {
        engineeringDraft: {
          structureType: 'portal-frame',
          geometry: { spanLengthsM: [18], heightM: 7, mezzanineHeightM: 3, mezzanineLengthM: 6 },
          loads: [
            { kind: 'line', magnitude: 5, unit: 'kN/m', direction: 'gravity', target: '屋面夹层' },
            { kind: 'line', magnitude: 6, unit: 'kN/m', direction: 'gravity', target: '屋面' },
          ],
        },
      },
    });
    const state = handler.mergeState(undefined, patch);
    const model = handler.buildModel(state);

    expect(state.loadKN).toBe(6);
    expect(state.skillState?.roofLoadKNM).toBe(6);
    expect(state.skillState?.mezzanineLoadKN).toBeUndefined();
    expect(model.load_cases[0].loads).toEqual(expect.arrayContaining([
      expect.objectContaining({ element: 'R0', wz: -6 }),
    ]));
    expect(model.load_cases[0].loads).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ element: 'MEZ1' }),
    ]));
  });

  test('uses pinned restraints for pinned portal-frame bases', () => {
    const patch = handler.extractDraft({
      message: '',
      llmDraftPatch: {
        engineeringDraft: {
          structureType: 'portal-frame',
          geometry: { spanLengthsM: [18], heightM: 6 },
          boundary: { frameBaseSupportType: 'pinned' },
          loads: [
            { kind: 'line', magnitude: 6, unit: 'kN/m', direction: 'gravity', target: 'roof' },
          ],
        },
      },
    });
    const state = handler.mergeState(undefined, patch);
    const model = handler.buildModel(state);

    expect(model.nodes.filter((node) => String(node.id).startsWith('B')).map((node) => node.restraints)).toEqual([
      [true, true, true, false, false, false],
      [true, true, true, false, false, false],
    ]);
  });

  test('keeps the specified H700 section from a verbose member description on all five members', () => {
    const patch = handler.extractDraft({
      message: '',
      llmDraftPatch: {
        engineeringDraft: {
          structureType: 'portal-frame',
          geometry: { spanLengthsM: [18, 18], heightM: 9 },
          sections: {
            beam: 'H700x300x12x20',
            column: 'H700x300x12x20',
            member: 'H700x300x12x20; H=700 mm, B=300 mm, tw=12 mm, tf=20 mm, A=0.01992 m2, Iy=0.001675096 m4, Iz=0.00009009504 m4, J=0.00000198016 m4',
          },
          loads: [{ kind: 'line', magnitude: 6, unit: 'kN/m', direction: 'gravity', target: 'roof' }],
        },
      },
    });
    const model = handler.buildModel(handler.mergeState(undefined, patch));
    const section = model.sections[0];
    expect(model.elements).toHaveLength(5);
    expect(model.elements.every((element) => element.section === section.id)).toBe(true);
    expect(section.name).toBe('H700X300X12X20');
    expect(section.shape).toEqual({ kind: 'H', H: 700, B: 300, tw: 12, tf: 20 });
    expect(section.properties.A).toBeCloseTo(0.01992, 8);
    expect(section.properties.Iy).toBeCloseTo(0.001675096, 10);
    expect(section.properties.Iz).toBeCloseTo(0.00009009504, 10);
    expect(section.properties.J).toBeCloseTo(0.00000198016, 12);
  });

  test('rejects conflicting explicit portal-frame section identifiers', () => {
    const state = { inferredType: 'portal-frame', spanLengthM: 18, heightM: 6, loadKN: 6,
      engineeringDraft: { sections: { member: 'H700x300x12x20', beam: 'H600x300x12x20' } }, updatedAt: 0 };
    expect(() => handler.buildModel(state)).toThrow(/conflict|冲突/i);
  });

  test.each(['beam', 'column'])('uses a clean %s identifier when member is omitted', (field) => {
    const state = { inferredType: 'portal-frame', spanLengthM: 18, heightM: 6, loadKN: 6,
      engineeringDraft: { sections: { [field]: 'H700x300x12x20' } }, updatedAt: 0 };
    expect(handler.buildModel(state).sections[0].name).toBe('H700X300X12X20');
  });

  test('rejects unknown explicit portal-frame sections instead of using PF1', () => {
    const state = { inferredType: 'portal-frame', spanLengthM: 18, heightM: 6, loadKN: 6,
      engineeringDraft: { sections: { member: 'UNKNOWN-SECTION' } }, updatedAt: 0 };
    expect(() => handler.buildModel(state)).toThrow(/section|截面/i);
  });

  test.each([
    'H700x300x12x400',
    'H700x300x12x20; A=0.02 m2',
  ])('rejects invalid explicit portal-frame section %s', (member) => {
    const state = { inferredType: 'portal-frame', spanLengthM: 18, heightM: 6, loadKN: 6,
      engineeringDraft: { sections: { member } }, updatedAt: 0 };
    expect(() => handler.buildModel(state)).toThrow(/section|截面/i);
  });

  test('keeps PF1 for a portal frame without an explicit section', () => {
    const state = { inferredType: 'portal-frame', spanLengthM: 18, heightM: 6, loadKN: 6, updatedAt: 0 };
    expect(handler.buildModel(state).sections[0].name).toBe('PF1');
  });
});
