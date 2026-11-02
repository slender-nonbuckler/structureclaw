import type { DraftState, EngineeringDraftLoad } from './types.js';

export interface ModelFidelityDiscrepancy {
  code: string;
  draftField: string;
  modelPath: string;
  expected: unknown;
  actual: unknown;
  rule: string;
  severity: 'error';
  deterministicCorrectionPossible: boolean;
}

export interface ModelFidelityResult {
  status: 'pass' | 'mismatch' | 'inconclusive';
  checkedFields: string[];
  unsupportedFields: string[];
  discrepancies: ModelFidelityDiscrepancy[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function entries(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record).filter((item): item is Record<string, unknown> => !!item) : [];
}

function sameNumber(left: unknown, right: unknown): boolean {
  return typeof left === 'number' && typeof right === 'number'
    && Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= 1e-9;
}

function multiset(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function sameMultiset(left: string[], right: string[]): boolean {
  const a = multiset(left);
  const b = multiset(right);
  return a.size === b.size && [...a].every(([key, count]) => b.get(key) === count);
}

function loadKey(load: EngineeringDraftLoad): string | undefined {
  if ((load.kind !== 'nodal' && load.kind !== 'point') || load.unit !== 'kN' || !load.caseId) return undefined;
  const node = load.location?.nodeId ?? load.target;
  if (!node || (load.location?.nodeId && load.target && load.target !== node)) return undefined;
  const component = load.direction === 'globalX' ? 'fx' : load.direction === 'globalY' ? 'fy'
    : load.direction === 'gravity' || load.direction === 'globalZ' ? 'fz' : undefined;
  if (!component) return undefined;
  return JSON.stringify([load.caseId, node, component, component === 'fz' ? -load.magnitude : load.magnitude]);
}

function modelLoadKeys(model: Record<string, unknown>): string[] {
  return entries(model.load_cases).flatMap((loadCase) => entries(loadCase.loads).flatMap((load) => {
    const components = ['fx', 'fy', 'fz'].filter((key) => typeof load[key] === 'number');
    return components.map((component) => JSON.stringify([loadCase.id, load.node, component, load[component]]));
  }));
}

export function compareModelToDraft(state: DraftState, model: Record<string, unknown>): ModelFidelityResult {
  const draft = state.engineeringDraft;
  const checkedFields: string[] = [];
  const unsupportedFields: string[] = [];
  const discrepancies: ModelFidelityDiscrepancy[] = [];
  const blocked = (field: string) => (state.draftIssues ?? []).some((issue) => issue.field === field || issue.field?.startsWith(`${field}.`))
    || (Array.isArray(state.skillState?.invalidDraftFields) && state.skillState.invalidDraftFields.some((issue) => issue === field || issue.startsWith(`${field}.`)));
  const mismatch = (code: string, draftField: string, modelPath: string, expected: unknown, actual: unknown, rule: string) => {
    discrepancies.push({ code, draftField, modelPath, expected, actual, rule, severity: 'error', deterministicCorrectionPossible: true });
  };
  if (!draft) return { status: 'inconclusive', checkedFields, unsupportedFields: ['engineeringDraft'], discrepancies };
  if (draft.material) unsupportedFields.push('engineeringDraft.material');
  if (draft.sections) {
    unsupportedFields.push(draft.sections.sectionProperties
      ? 'engineeringDraft.sections.sectionProperties' : 'engineeringDraft.sections');
  }
  if (draft.analysis?.includeSelfWeight !== undefined) unsupportedFields.push('engineeringDraft.analysis.includeSelfWeight');

  const truss = state.inferredType === 'truss';
  const topology = draft.topology;
  if (topology && !blocked('topology') && !blocked('engineeringDraft.topology')) {
    if (!truss) {
      unsupportedFields.push('engineeringDraft.topology');
    } else {
      const modelNodes = entries(model.nodes);
      if (topology.nodes?.length) {
        checkedFields.push('engineeringDraft.topology.nodes');
        const expectedIds = topology.nodes.map((node) => node.id);
        const actualIds = modelNodes.map((node) => String(node.id));
        if (!sameMultiset(expectedIds, actualIds)) mismatch('NODE_IDENTITY_MISMATCH', 'engineeringDraft.topology.nodes', 'model.nodes', expectedIds, actualIds, 'identity-multiset');
        for (const node of topology.nodes) {
          const actual = modelNodes.find((item) => item.id === node.id);
          if (!actual) continue;
          if (!sameNumber(node.x, actual.x) || !sameNumber(node.y, actual.y) || !sameNumber(node.z, actual.z)) {
            mismatch('NODE_COORDINATE_MISMATCH', `engineeringDraft.topology.nodes.${node.id}`, `model.nodes.${node.id}`, [node.x, node.y, node.z], [actual.x, actual.y, actual.z], 'coordinate-m-1e-9');
          }
          if (node.restraints) {
            checkedFields.push(`engineeringDraft.topology.nodes.${node.id}.restraints`);
            const expected = [...node.restraints];
            if (expected[0] || expected[2]) expected[1] = true; // Existing 2D truss builder convention.
            const actualRestraints = actual.restraints;
            if (!Array.isArray(actualRestraints) || expected.some((value, index) => actualRestraints[index] !== value)) {
              mismatch('SUPPORT_RESTRAINT_MISMATCH', `engineeringDraft.topology.nodes.${node.id}.restraints`, `model.nodes.${node.id}.restraints`, expected, actualRestraints, 'truss-2d-restraints');
            }
          }
        }
      }
      if (topology.members?.length) {
        checkedFields.push('engineeringDraft.topology.members');
        const key = (nodes: unknown, type: unknown) => Array.isArray(nodes) && nodes.length === 2
          ? JSON.stringify([String(type), ...nodes.map(String).sort()]) : 'invalid';
        const expected = topology.members.map((member) => key(member.nodes, 'truss'));
        const actual = entries(model.elements).map((element) => key(element.nodes, element.type));
        if (!sameMultiset(expected, actual)) mismatch('MEMBER_CONNECTIVITY_MISMATCH', 'engineeringDraft.topology.members', 'model.elements', expected, actual, 'typed-unordered-endpoint-multiset');
      }
    }
  } else if (topology) unsupportedFields.push('engineeringDraft.topology');

  if (draft.loads?.length && !blocked('loads') && !blocked('engineeringDraft.loads')) {
    const expected = draft.loads.map(loadKey);
    if (!truss || expected.some((item) => item === undefined)) {
      unsupportedFields.push('engineeringDraft.loads');
    } else {
      checkedFields.push('engineeringDraft.loads', 'engineeringDraft.loads.caseId');
      const actual = modelLoadKeys(model);
      if (!sameMultiset(expected as string[], actual)) mismatch('NODAL_LOAD_MISMATCH', 'engineeringDraft.loads', 'model.load_cases[*].loads', expected, actual, 'signed-nodal-load-multiset');
      const expectedCases = [...new Set(draft.loads.map((load) => load.caseId))].sort();
      const actualCases = entries(model.load_cases).map((loadCase) => String(loadCase.id)).sort();
      if (!sameMultiset(expectedCases as string[], actualCases)) mismatch('LOAD_CASE_MISMATCH', 'engineeringDraft.loads[*].caseId', 'model.load_cases[*].id', expectedCases, actualCases, 'case-identity-multiset');
    }
  } else if (draft.loads?.length) unsupportedFields.push('engineeringDraft.loads');

  const combinations = draft.analysis?.loadCombinations;
  if (combinations?.length && !blocked('analysis.loadCombinations')) {
    checkedFields.push('engineeringDraft.analysis.loadCombinations');
    const combinationKey = (id: unknown, factors: unknown) => JSON.stringify([id, Object.entries(record(factors) ?? {}).sort(([a], [b]) => a.localeCompare(b))]);
    const expected = combinations.map((item) => combinationKey(item.id, item.factors));
    const actual = entries(model.load_combinations).map((item) => combinationKey(item.id, item.factors));
    if (!sameMultiset(expected, actual)) mismatch('LOAD_COMBINATION_MISMATCH', 'engineeringDraft.analysis.loadCombinations', 'model.load_combinations', expected, actual, 'case-factor-multiset');
  }
  return {
    status: discrepancies.length ? 'mismatch' : unsupportedFields.length || !checkedFields.length ? 'inconclusive' : 'pass',
    checkedFields: [...new Set(checkedFields)], unsupportedFields: [...new Set(unsupportedFields)], discrepancies,
  };
}
