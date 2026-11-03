#!/usr/bin/env node
//
// Does GHL's MCP server accept the OAuth access token our install holds?
//
//   npm run probe:mcp -- <location_id>
//
// The MCP doc (marketplace.gohighlevel.com/docs/2021-04-15/other/mcp) shows
// a browser sign-in for desktop clients and says nothing about machine
// auth. Before building a client on it, this sends the two JSON-RPC calls
// every MCP client starts with — initialize, then tools/list — to the
// Claude endpoint with our install's bearer token, and prints what comes
// back. A tools list means we are in; a 401 means the endpoint wants its
// own consent flow and we stop there.

import 'dotenv/config';
import { pool } from '../db.js';
import { getActiveInstall, ghlRequest } from '../services/ghlClient.js';

const MCP_URL = 'https://services.leadconnectorhq.com/mcp/anthropic/v2';

// Streamable HTTP answers either as JSON or as an SSE stream; take the
// JSON-RPC result from whichever arrives.
function parseBody(data) {
  if (data && typeof data === 'object') return data;
  const text = String(data || '');
  const events = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
  for (const e of events.reverse()) { try { return JSON.parse(e); } catch { /* next */ } }
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 500) }; }
}

async function rpc(install, locationId, body, sessionId) {
  const resp = await ghlRequest(install, {
    method: 'POST',
    url: MCP_URL,
    data: body,
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      locationId,
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {})
    },
    responseType: 'text',
    transformResponse: [(d) => d],
    scopeOptional: true,
    timeout: 20000
  });
  return { status: resp.status, session: resp.headers?.['mcp-session-id'] || null, body: parseBody(resp.data) };
}

async function main() {
  const [locationId] = process.argv.slice(2);
  if (!locationId) { console.log('usage: npm run probe:mcp -- <location_id>'); return; }
  const install = await getActiveInstall(locationId);
  if (!install) { console.log(`${locationId}: no active install`); return; }

  try {
    const init = await rpc(install, locationId, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'pipelinepulse-probe', version: '0.1' } }
    });
    console.log('initialize →', init.status, JSON.stringify(init.body).slice(0, 600));
    const list = await rpc(install, locationId, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, init.session);
    const tools = list.body?.result?.tools || [];
    console.log('tools/list →', list.status, tools.length ? tools.map((t) => t.name).join(', ') : JSON.stringify(list.body).slice(0, 600));
    if (tools.some((t) => t.name === 'search_operations')) {
      const s = await rpc(install, locationId, {
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'search_operations', arguments: { query: 'calendar events for a contact' } }
      }, init.session);
      console.log('search_operations →', s.status, JSON.stringify(s.body).slice(0, 1200));
    }
  } catch (err) {
    const status = err.response?.status;
    const body = err.response?.data;
    console.log('FAILED', status || err.message, typeof body === 'string' ? body.slice(0, 600) : JSON.stringify(body || {}).slice(0, 600));
    if (status === 401 || status === 403) {
      console.log('→ The MCP endpoint did not accept the install\'s OAuth token. It wants its own consent flow.');
    }
  }
}

main()
  .then(() => pool.end())
  .catch((err) => { console.error(err?.message || err); pool.end(); process.exit(1); });
