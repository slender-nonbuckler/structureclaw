import { describe, expect, test } from '@jest/globals';
import { buildSystemMessages } from '../../../dist/agent-langgraph/system-prompt.js';
import { createDetectStructureTypeTool } from '../../../dist/agent-langgraph/tools.js';

const state = (locale) => ({
  locale, draftState: null, artifacts: {}, policy: {}, selectedSkillIds: [],
});

function prompt(locale) {
  return String(buildSystemMessages({ state: state(locale), skillManifests: [] })[0].content);
}

function runtimeFor(type) {
  return {
    resolvePluginForType: async (key) => ['truss', 'frame'].includes(key)
      ? { id: key, structureType: key } : null,
    detectStructuralTypeWithLlm: async () => ({
      key: type, mappedType: type, skillId: type,
      supportLevel: 'supported', routingSource: 'llm-suggested',
    }),
  };
}

async function detect(runtime, message, previousState = state('en')) {
  const command = await createDetectStructureTypeTool(runtime).invoke(
    { message, locale: 'en' },
    { toolCall: { id: 'identification-only' }, configurable: { agentState: previousState } },
  );
  return {
    result: JSON.parse(command.update.messages[0].content),
    update: command.update,
  };
}

describe('identification-only structural routing', () => {
  test('English and Chinese prompts require detection for structural identification alone', () => {
    expect(prompt('en')).toContain('For a structural identification-only request');
    expect(prompt('en')).toContain('call detect_structure_type before answering');
    expect(prompt('en')).toContain('Do not require detection for unrelated conversation');
    expect(prompt('zh')).toContain('仅要求识别图像或文字描述中的结构类型');
    expect(prompt('zh')).toContain('先调用 detect_structure_type');
    expect(prompt('zh')).toContain('无关的普通对话不需要结构类型检测');
  });

  test('tool description includes identification-only use', () => {
    expect(createDetectStructureTypeTool(runtimeFor('truss')).description)
      .toContain('identification-only');
  });

  test('a supported image truss identification records the truss key and skill', async () => {
    const { result, update } = await detect(runtimeFor('truss'),
      '[Attachment vision summary: 2D truss with triangulated members.] Identify the structural system.');
    expect(result).toMatchObject({
      key: 'truss', mappedType: 'truss', skillId: 'truss',
      supportLevel: 'supported', routingSource: 'llm-suggested',
    });
    expect(update.structuralTypeKey).toBe('truss');
    expect(update.messages[0].name).toBe('detect_structure_type');
  });

  test('a parameter-only continuation retains the prior truss skill', async () => {
    const first = await detect(runtimeFor('truss'), 'Identify this truss drawing.');
    const runtime = runtimeFor('truss');
    runtime.detectStructuralTypeWithLlm = async () => ({
      key: 'unknown', mappedType: 'unknown', skillId: 'generic',
      supportLevel: 'fallback', routingSource: 'llm-suggested',
    });
    const next = await detect(runtime, 'Add steel E=205000 MPa and LC1 loads.', {
      ...state('en'), structuralTypeKey: first.update.structuralTypeKey,
    });
    expect(next.result).toMatchObject({
      key: 'truss', mappedType: 'truss', skillId: 'truss',
      routingSource: 'current-state', supportLevel: 'supported',
    });
    expect(next.update.structuralTypeKey).toBe('truss');
  });

  test('frame identification persists a frame skill for a load-only continuation', async () => {
    const first = await detect(runtimeFor('frame'), 'Identify the structural system in this frame drawing.');
    expect(first.result).toMatchObject({ key: 'frame', mappedType: 'frame', skillId: 'frame' });
    expect(first.update.structuralTypeKey).toBe('frame');
    const runtime = runtimeFor('frame');
    runtime.detectStructuralTypeWithLlm = async () => ({
      key: 'unknown', mappedType: 'unknown', skillId: 'generic',
      supportLevel: 'fallback', routingSource: 'llm-suggested',
    });
    const next = await detect(runtime, 'Add a floor load to this structure.', {
      ...state('en'), structuralTypeKey: 'frame',
    });
    expect(next.result.skillId).toBe('frame');
    expect(next.result.routingSource).toBe('current-state');
  });

  test('an explicit new frame replaces a prior truss classification', async () => {
    const next = await detect(runtimeFor('frame'), 'Switch to a new two-story steel frame.', {
      ...state('en'), structuralTypeKey: 'truss',
    });
    expect(next.result.skillId).toBe('frame');
    expect(next.update.structuralTypeKey).toBe('frame');
  });
});
