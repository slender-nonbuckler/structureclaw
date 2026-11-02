import { describe, expect, test } from '@jest/globals';

const column = {
  name: 'HW300X300', HMM: 300, BMM: 300, twMM: 10, tfMM: 15,
  areaM2: 0.01192, IyM4: 0.000204, IzM4: 6.75e-5, JM4: 4.23e-6,
  shearModulusMPa: 79000,
};

async function helpers() {
  const draft = await import('../../../dist/agent-runtime/engineering-draft.js');
  const legacy = await import('../../../dist/agent-runtime/legacy.js');
  const fallback = await import('../../../dist/agent-runtime/fallback.js');
  return { ...draft, ...legacy, ...fallback };
}

describe('engineering property preservation', () => {
  test('retains the saved frame correction with typed section and material properties', async () => {
    const { normalizeEngineeringDraft } = await helpers();
    const normalized = normalizeEngineeringDraft({
      structureType: 'frame',
      material: { family: 'steel', elasticModulusMPa: 205000, poissonRatio: 0.3, densityKgM3: 7850 },
      sections: { column: 'HW300X300', beam: 'HN400X200', sectionProperties: { column, beam: { name: 'HN400X200', areaM2: 0.00842, IyM4: 0.000237 } } },
      analysis: { includeSelfWeight: false },
    });
    expect(normalized.material).toMatchObject({ elasticModulusMPa: 205000, poissonRatio: 0.3, densityKgM3: 7850 });
    expect(normalized.sections.sectionProperties.column).toEqual(column);
    expect(normalized.sections.sectionProperties.beam).toMatchObject({ areaM2: 0.00842, IyM4: 0.000237 });
    expect(normalized.analysis.includeSelfWeight).toBe(false);
  });

  test('normalizes saved columnProperties and beamProperties aliases without losing precision', async () => {
    const { normalizeEngineeringDraft } = await helpers();
    const normalized = normalizeEngineeringDraft({
      material: { family: 'steel', grade: 'Q345', elasticModulusMPa: 206000, poissonRatio: 0.3, densityKgM3: 7850, fyMPa: 345 },
      sections: { column: 'HW350X350', beam: 'HN500X200',
        columnProperties: { HMM: 350, BMM: 350, twMM: 12, tfMM: 19, areaM2: 0.01739, IyM4: 0.000403, IzM4: 0.000136, JM4: 8.63e-6, GMPa: 79000 },
        beamProperties: { areaM2: 0.01143, IyM4: 0.000502, IzM4: 2.14e-5, JM4: 1.24e-6 },
      },
      analysis: { includeSelfWeight: true },
    });
    expect(normalized.material).toMatchObject({ elasticModulusMPa: 206000, densityKgM3: 7850, fyMPa: 345 });
    expect(normalized.sections.sectionProperties.column).toMatchObject({ areaM2: 0.01739, JM4: 8.63e-6, shearModulusMPa: 79000 });
    expect(normalized.sections.sectionProperties.beam).toMatchObject({ areaM2: 0.01143, IzM4: 2.14e-5 });
    expect(normalized.analysis.includeSelfWeight).toBe(true);
  });

  test('retains concrete compressive strength and zero Poisson ratio as explicit values', async () => {
    const { normalizeEngineeringDraft } = await helpers();
    const normalized = normalizeEngineeringDraft({
      material: { family: 'concrete', fcMPa: 30, poissonRatio: 0 },
    });
    expect(normalized.material).toMatchObject({ fcMPa: 30, poissonRatio: 0 });
  });

  test('keeps numeric properties through the legacy projection and state serialization path', async () => {
    const { normalizeLegacyDraftPatch, projectEngineeringDraftToLegacyPatch } = await helpers();
    const { handler } = await import('../../../dist/agent-skills/structure-type/frame/handler.js');
    const patch = normalizeLegacyDraftPatch({ inferredType: 'frame', engineeringDraft: {
      material: { family: 'steel', elasticModulusMPa: 205000, densityKgM3: 7850 },
      sections: { column: 'HW300X300', sectionProperties: { column } },
      analysis: { includeSelfWeight: false },
    } });
    const projected = projectEngineeringDraftToLegacyPatch(patch, 'frame');
    const state = handler.mergeState(undefined, projected);
    const restored = JSON.parse(JSON.stringify(state));
    expect(restored.engineeringDraft.material.elasticModulusMPa).toBe(205000);
    expect(restored.engineeringDraft.sections.sectionProperties.column).toEqual(column);
    expect(restored.engineeringDraft.analysis.includeSelfWeight).toBe(false);
    expect(restored.frameColumnSection).toBe('HW300X300');
  });

  test('merges nested partial corrections without losing unrelated values or explicit false', async () => {
    const { normalizeEngineeringDraft, mergeDraftState } = await helpers();
    const first = mergeDraftState(undefined, { engineeringDraft: normalizeEngineeringDraft({
      material: { family: 'steel', elasticModulusMPa: 205000, poissonRatio: 0, densityKgM3: 7850 },
      sections: { column: 'HW300X300', sectionProperties: { column, beam: { areaM2: 0.00842 } } },
      analysis: { includeSelfWeight: false },
    }) });
    const second = mergeDraftState(first, { engineeringDraft: normalizeEngineeringDraft({
      material: { elasticModulusMPa: 206000 },
      sections: { sectionProperties: { column: { areaM2: 0.012 } } },
      analysis: { type: 'static' },
    }) });
    const repeated = mergeDraftState(second, { engineeringDraft: normalizeEngineeringDraft({
      material: { elasticModulusMPa: 206000 }, sections: { sectionProperties: { column: { areaM2: 0.012 } } },
    }) });
    expect(repeated.engineeringDraft.material).toMatchObject({ elasticModulusMPa: 206000, poissonRatio: 0, densityKgM3: 7850 });
    expect(repeated.engineeringDraft.sections.sectionProperties.column).toMatchObject({ ...column, areaM2: 0.012 });
    expect(repeated.engineeringDraft.sections.sectionProperties.beam.areaM2).toBe(0.00842);
    expect(repeated.engineeringDraft.analysis).toMatchObject({ includeSelfWeight: false, type: 'static' });
    expect(normalizeEngineeringDraft(JSON.parse(JSON.stringify(repeated.engineeringDraft))).sections.sectionProperties.column).toMatchObject({ ...column, areaM2: 0.012 });
  });

  test('reports conflicting aliases and section identity rather than selecting silently', async () => {
    const { normalizeLegacyDraftPatch } = await helpers();
    const patch = normalizeLegacyDraftPatch({ engineeringDraft: { sections: {
      column: 'HW300X300',
      sectionProperties: { column: { name: 'HW300X300', areaM2: 0.01192, shearModulusMPa: 79000 } },
      columnProperties: { name: 'HW350X350', areaM2: 0.01739, GMPa: 81000 },
    } } });
    expect(patch.draftIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'engineeringDraft.sections.sectionProperties.column', severity: 'conflict' }),
    ]));
    expect(patch.skillState.invalidDraftFields).toContain('engineeringDraft.sections.sectionProperties.column');
  });

  test('reports invalid physical values while keeping valid explicit zero and false', async () => {
    const { normalizeLegacyDraftPatch } = await helpers();
    const patch = normalizeLegacyDraftPatch({ engineeringDraft: {
      material: { elasticModulusMPa: -1, poissonRatio: 0, densityKgM3: 0 },
      sections: { sectionProperties: { column: { areaM2: 0, IyM4: 'Infinity' } } },
      analysis: { includeSelfWeight: 'false' },
    } });
    expect(patch.draftIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'engineeringDraft.material.elasticModulusMPa', severity: 'invalid' }),
      expect.objectContaining({ field: 'engineeringDraft.material.densityKgM3', severity: 'invalid' }),
      expect.objectContaining({ field: 'engineeringDraft.sections.sectionProperties.column.areaM2', severity: 'invalid' }),
      expect.objectContaining({ field: 'engineeringDraft.sections.sectionProperties.column.IyM4', severity: 'invalid' }),
    ]));
    expect(patch.engineeringDraft.material.poissonRatio).toBe(0);
    expect(patch.draftIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'engineeringDraft.analysis.includeSelfWeight', severity: 'invalid' }),
    ]));
    expect(patch.engineeringDraft.analysis.includeSelfWeight).toBeUndefined();
    expect(patch.engineeringDraft.sections.sectionProperties?.column?.areaM2).toBeUndefined();
  });
});
