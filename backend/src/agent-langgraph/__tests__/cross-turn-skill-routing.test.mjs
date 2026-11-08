import { describe, expect, test } from '@jest/globals';
import { AgentSkillLoader } from '../../../dist/agent-runtime/loader.js';

const plugins = Object.fromEntries(['truss', 'frame', 'generic'].map((id) => [id, {
  id,
  structureType: id === 'generic' ? 'unknown' : id,
  markdownByStage: { draft: `${id} draft guidance` },
}]));

function runtimeFor(routerMatch) {
  return {
    resolvePluginForType: async (key) => plugins[key] ?? null,
    detectStructuralTypeWithLlm: async () => routerMatch,
  };
}

async function detect(runtime, state, message) {
  const { createDetectStructureTypeTool } = await import('../../../dist/agent-langgraph/tools.js');
  const command = await createDetectStructureTypeTool(runtime).invoke(
    { message, locale: 'en' },
    { toolCall: { id: 'cross-turn-detect' }, configurable: { agentState: state } },
  );
  return {
    response: JSON.parse(command.update.messages[0].content),
    update: command.update,
  };
}

describe('cross-turn structural skill routing', () => {
  test('keeps a detected truss for a parameter-only next turn and selects truss draft guidance', async () => {
    const truss = new AgentSkillLoader().loadBundles().find((bundle) => bundle.id === 'truss');
    const runtime = runtimeFor({
      key: 'unknown', mappedType: 'unknown', skillId: 'generic',
      supportLevel: 'fallback', routingSource: 'llm-suggested',
    });
    runtime.resolvePluginForType = async (key) => key === 'truss' ? truss : plugins[key] ?? null;
    const message = 'Use the engineering specification for this drawing: steel E=205000 MPa, section T1, LC1 loads; run static analysis.';
    const { response, update } = await detect(runtime, {
      structuralTypeKey: 'truss', draftState: null, locale: 'en',
      lastUserMessage: message,
    }, message);

    expect(response.skillId).toBe('truss');
    expect(update.structuralTypeKey).toBe('truss');
    const { resolveDetectedStructuralTypeMatch } = await import('../../../dist/agent-langgraph/tools.js');
    const selected = await resolveDetectedStructuralTypeMatch(runtime, update.structuralTypeKey, undefined, message);
    expect(selected.skillId).toBe('truss');
    const { buildParamExtractorPrompt } = await import('../../../dist/agent-langgraph/param-extractor.js');
    expect(buildParamExtractorPrompt('en', undefined, truss, message))
      .toContain('A geometric crossing is not automatically a structural joint');
  });

  test('keeps a frame for a load-only next turn', async () => {
    const runtime = runtimeFor({
      key: 'unknown', mappedType: 'unknown', skillId: 'generic',
      supportLevel: 'fallback', routingSource: 'llm-suggested',
    });
    const { response } = await detect(runtime, {
      structuralTypeKey: 'frame', draftState: null, locale: 'en',
    }, 'Add LC2 with a 12 kN floor load to the existing structure.');
    expect(response.skillId).toBe('frame');
  });

  test('does not reuse a truss classification for an explicit frame switch', async () => {
    const { resolveDetectedStructuralTypeMatch } = await import('../../../dist/agent-langgraph/tools.js');
    await expect(resolveDetectedStructuralTypeMatch(
      runtimeFor(null), 'truss', undefined, 'Switch to a two-story steel frame.',
    )).resolves.toBeNull();
  });

  test('uses the latest explicit detection ahead of an older draft skill', async () => {
    const { persistedStructuralTypeKey, resolveDetectedStructuralTypeMatch } = await import('../../../dist/agent-langgraph/tools.js');
    const state = {
      structuralTypeKey: 'frame',
      draftState: { inferredType: 'truss', skillId: 'truss', updatedAt: 1 },
    };
    const key = persistedStructuralTypeKey(state);
    expect(key).toBe('frame');
    await expect(resolveDetectedStructuralTypeMatch(
      runtimeFor(null), key, undefined, 'Switch to a two-story frame.',
    )).resolves.toMatchObject({ skillId: 'frame' });
  });

  test('selects a new frame task instead of the prior truss', async () => {
    const runtime = runtimeFor({
      key: 'frame', mappedType: 'frame', skillId: 'frame',
      supportLevel: 'supported', routingSource: 'llm-suggested',
    });
    const { response, update } = await detect(runtime, {
      structuralTypeKey: 'truss', draftState: null, locale: 'en',
    }, 'For a new structure, analyze a two-story steel frame.');
    expect(response.skillId).toBe('frame');
    expect(update.structuralTypeKey).toBe('frame');
  });

  test('does not force the old skill onto an unrelated new task with unknown type', async () => {
    const runtime = runtimeFor({
      key: 'unknown', mappedType: 'unknown', skillId: 'generic',
      supportLevel: 'fallback', routingSource: 'llm-suggested',
    });
    const { response } = await detect(runtime, {
      structuralTypeKey: 'truss', draftState: null, locale: 'en',
    }, 'Start a separate new structural project with different geometry.');
    expect(response.skillId).toBe('generic');
  });

  test('does not carry a truss classification into an unsupported bridge request', async () => {
    const runtime = runtimeFor({
      key: 'unknown', mappedType: 'unknown', skillId: 'generic',
      supportLevel: 'fallback', routingSource: 'llm-suggested',
    });
    const { response } = await detect(runtime, {
      structuralTypeKey: 'truss', draftState: null, locale: 'en',
    }, 'Analyze a bridge with new geometry.');
    expect(response.skillId).toBe('generic');
  });

  test('recovers a valid draft skill when the persisted type key is stale', async () => {
    const runtime = runtimeFor({
      key: 'unknown', mappedType: 'unknown', skillId: 'generic',
      supportLevel: 'fallback', routingSource: 'llm-suggested',
    });
    const { response, update } = await detect(runtime, {
      structuralTypeKey: 'unknown',
      draftState: { inferredType: 'frame', skillId: 'frame', updatedAt: 1 },
      locale: 'en',
    }, 'Add a 12 kN load to LC1.');
    expect(response.skillId).toBe('frame');
    expect(update.structuralTypeKey).toBe('frame');
  });

  test('keeps single-turn generic routing when no earlier classification exists', async () => {
    const runtime = runtimeFor({
      key: 'unknown', mappedType: 'unknown', skillId: 'generic',
      supportLevel: 'fallback', routingSource: 'llm-suggested',
    });
    const { response } = await detect(runtime, {
      structuralTypeKey: null, draftState: null, locale: 'en',
    }, 'Analyze a new structural problem.');
    expect(response.skillId).toBe('generic');
  });
});
