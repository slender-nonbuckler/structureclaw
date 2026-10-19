// Read-only protocol check. Does not start a thread or inference turn.
import { CodexAppServerProcess } from '../dist/services/codex-app-server.js';

const server = CodexAppServerProcess.start(process.argv.slice(2));
try {
  await server.request('initialize', {
    clientInfo: { name: 'structureclaw_probe', title: 'StructureClaw Probe', version: '0.1.0' },
  });
  server.notify('initialized', {});
  const account = await server.request('account/read', { refreshToken: false });
  const mcp = await server.request('mcpServerStatus/list', { detail: 'toolsAndAuthOnly' });
  console.log(JSON.stringify({
    authType: account.account?.type ?? null,
    mcpServerCount: Array.isArray(mcp.data) ? mcp.data.length : null,
    mcpServers: Array.isArray(mcp.data)
      ? mcp.data.map(({ name, runtimeStatus, tools }) => ({ name, runtimeStatus, toolCount: Object.keys(tools ?? {}).length }))
      : null,
  }));
} finally {
  await server.close();
}
