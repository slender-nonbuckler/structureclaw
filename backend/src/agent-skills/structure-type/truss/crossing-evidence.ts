import type { DraftExtraction, EngineeringDraftTopology } from '../../../agent-runtime/types.js';

interface VisionSummary {
  nodes?: string[];
  members?: string[];
  missingOrUnclear?: string[];
  notes?: string[];
}

interface Point { x: number; z: number }

const VISION_MARKERS = ['[Benchmark vision attachment summaries]', '[Attachment vision summary:', '[附件视觉摘要:'];

function visionSummaries(message: string): VisionSummary[] {
  if (!VISION_MARKERS.some((marker) => message.includes(marker))) return [];
  return message.split(/\r?\n/).flatMap((line) => {
    if (!line.trimStart().startsWith('{')) return [];
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value)) return [value as VisionSummary];
    } catch {
      // Other message lines are not structured vision evidence.
    }
    return [];
  });
}

function nodePoints(nodes: string[]): Map<string, Point> {
  const points = new Map<string, Point>();
  for (const node of nodes) {
    const id = /^([\w]+):/.exec(node)?.[1];
    const x = /\bx\s*=\s*(-?\d+(?:\.\d+)?)/i.exec(node)?.[1];
    const z = /\bz\s*=\s*(-?\d+(?:\.\d+)?)/i.exec(node)?.[1];
    if (id && x && z) points.set(id, { x: Number(x), z: Number(z) });
  }
  return points;
}

function onOppositeRays(point: Point, a: Point, b: Point): boolean {
  const ax = a.x - point.x;
  const az = a.z - point.z;
  const bx = b.x - point.x;
  const bz = b.z - point.z;
  const scale = Math.hypot(ax, az) * Math.hypot(bx, bz);
  return scale > 0 && Math.abs(ax * bz - az * bx) <= scale * 1e-8 && ax * bx + az * bz < 0;
}

function crossingArms(topology: EngineeringDraftTopology, id: string, point: Point): string[] | undefined {
  const node = topology.nodes?.find((candidate) => candidate.id === id);
  if (!node || Math.abs(node.x - point.x) > 1e-6 || Math.abs(node.z - point.z) > 1e-6) return undefined;
  const arms = topology.members?.filter((member) => member.nodes.includes(id))
    .map((member) => member.nodes.find((end) => end !== id) ?? '') ?? [];
  if (arms.length !== 4 || new Set(arms).size !== 4) return undefined;
  const positions = arms.map((arm) => topology.nodes?.find((candidate) => candidate.id === arm));
  if (positions.some((position) => !position)) return undefined;
  const pairs: number[][] = [];
  for (let a = 0; a < 4; a++) {
    for (let b = a + 1; b < 4; b++) {
      if (onOppositeRays(point, positions[a]!, positions[b]!)) pairs.push([a, b]);
    }
  }
  return pairs.length === 2 && new Set(pairs.flat()).size === 4 ? arms : undefined;
}

function visionIdentifiesArms(summary: VisionSummary, id: string, arms: string[], point: Point): boolean {
  if (!Array.isArray(summary.members)) return false;
  const members = summary.members.map((member) => /^([\w]+)-([\w]+)$/.exec(member.trim()))
    .filter((member): member is RegExpExecArray => member !== null)
    .map((member) => [member[1], member[2]]);
  const splitArms = members.filter(([a, b]) => a === id || b === id)
    .map(([a, b]) => a === id ? b : a);
  if (arms.every((arm) => splitArms.includes(arm))) return true;
  const continuous = members.filter(([a, b]) => arms.includes(a) && arms.includes(b));
  if (continuous.length !== 2) return false;
  const points = nodePoints(summary.nodes ?? []);
  return continuous.every(([a, b]) => points.has(a) && points.has(b)
    && onOppositeRays(point, points.get(a)!, points.get(b)!))
    && new Set(continuous.flat()).size === 4;
}

export function unresolvedConnectedCrossing(patch: DraftExtraction, message: string): string | undefined {
  const topology = patch.engineeringDraft?.topology;
  if (!topology?.nodes?.length || !topology.members?.length) return undefined;
  for (const summary of visionSummaries(message)) {
    if (!Array.isArray(summary.missingOrUnclear) || !Array.isArray(summary.nodes)) continue;
    const points = nodePoints(summary.nodes);
    for (const observation of summary.missingOrUnclear) {
      const id = /^([\w]+)\b/.exec(observation)?.[1];
      if (!id || !points.has(id)
        || !/(crossing|intersection)/i.test(observation)
        || !/(unmarked|ambiguous|unclear|uncertain|not explicitly marked|no (?:explicit )?joint marker)/i.test(observation)) continue;
      const arms = crossingArms(topology, id, points.get(id)!);
      if (!arms || !visionIdentifiesArms(summary, id, arms, points.get(id)!)) continue;
      const resolution = [
        ...(summary.notes ?? []),
        message.slice(0, Math.min(...VISION_MARKERS.map((marker) => {
          const index = message.indexOf(marker);
          return index < 0 ? message.length : index;
        }))),
        message.split('[User task]').slice(1).join('[User task]'),
      ].join(' ');
      const explicitConnection = resolution.split(/[.!?]/).some((statement) => (
        new RegExp(`\\b${id}\\b`, 'i').test(statement)
        && !/(no (?:explicit )?connection detail|not connected|no (?:explicit )?joint marker)/i.test(statement)
        && /(explicitly connects?|explicitly connected|(?:is|should be|must be) connected|connection detail (?:explicitly )?(?:joins|connects)|joint (?:dot|marker) (?:marks|at)|marked with a joint dot)/i.test(statement)
      ));
      if (explicitConnection) continue;
      return id;
    }
  }
  return undefined;
}
