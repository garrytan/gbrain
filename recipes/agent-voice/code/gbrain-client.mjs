/**
 * gbrain-client.mjs — minimal stdio MCP client for gbrain.
 *
 * Spawns `gbrain serve` as a long-lived child process and communicates via
 * JSON-RPC over stdio. The client is intentionally minimal: open the
 * connection once, send `initialize`, then forward tool calls. No retries,
 * no batching, no streaming results (most voice tools return small
 * payloads; large ones can be paginated by the caller).
 *
 * Production hardening this file does NOT do:
 *   - reconnect on child crash (caller restarts; voice sessions are short)
 *   - request timeouts (caller handles via its own AbortSignal)
 *   - concurrent request multiplexing (one in-flight call at a time)
 *
 * That's deliberate: this is reference code optimized for clarity and the
 * voice-agent use case, not a production-grade MCP client. The operator
 * can replace it with a richer implementation (e.g., the
 * @modelcontextprotocol/sdk Client) without changing tools.mjs.
 *
 * Configuration: `$GBRAIN_BIN` (default: `gbrain` on PATH) is the binary to
 * spawn. `$GBRAIN_BRAIN_ID` and `$GBRAIN_SOURCE` route to a specific brain
 * + source if set (see the gbrain docs/architecture/brains-and-sources.md).
 */

import { spawn } from 'node:child_process';

const GBRAIN_BIN = process.env.GBRAIN_BIN || 'gbrain';

let _child;
let _nextId = 1;
const _pending = new Map();
let _initialized = false;
let _buffer = '';

function ensureChild() {
  if (_child && !_child.killed) return _child;

  const args = ['serve'];
  if (process.env.GBRAIN_BRAIN_ID) args.push('--brain', process.env.GBRAIN_BRAIN_ID);
  if (process.env.GBRAIN_SOURCE) args.push('--source', process.env.GBRAIN_SOURCE);

  _child = spawn(GBRAIN_BIN, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, MCP_STDIO: '1' },
  });

  _child.stdout.setEncoding('utf8');
  _child.stdout.on('data', (chunk) => {
    _buffer += chunk;
    // JSON-RPC over stdio: messages separated by newlines.
    let nlIdx;
    while ((nlIdx = _buffer.indexOf('\n')) !== -1) {
      const line = _buffer.slice(0, nlIdx).trim();
      _buffer = _buffer.slice(nlIdx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && _pending.has(msg.id)) {
          const { resolve, reject } = _pending.get(msg.id);
          _pending.delete(msg.id);
          if (msg.error) {
            reject(new Error(msg.error.message || 'gbrain MCP error'));
          } else {
            resolve(msg.result);
          }
        }
        // notifications/log etc. — ignore for the v0 voice use case.
      } catch (err) {
        // Malformed line; ignore. gbrain prints structured JSON-RPC only,
        // but a renegade stderr-bleed could surface here.
      }
    }
  });

  _child.stderr.setEncoding('utf8');
  _child.stderr.on('data', (chunk) => {
    // Surface gbrain stderr to our stderr for debugging. Don't crash on it.
    process.stderr.write(`[gbrain] ${chunk}`);
  });

  _child.on('exit', (code, signal) => {
    const reason = signal ? `signal ${signal}` : `code ${code}`;
    for (const [, p] of _pending) {
      p.reject(new Error(`gbrain child exited (${reason}) with ${_pending.size} pending`));
    }
    _pending.clear();
    _initialized = false;
    _child = null;
  });

  return _child;
}

function rpc(method, params) {
  const id = _nextId++;
  const child = ensureChild();
  return new Promise((resolve, reject) => {
    _pending.set(id, { resolve, reject });
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    try {
      child.stdin.write(msg);
    } catch (err) {
      _pending.delete(id);
      reject(err);
    }
  });
}

async function initIfNeeded() {
  if (_initialized) return;
  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'agent-voice', version: '0.1.0' },
  });
  _initialized = true;
}

/**
 * Call a single gbrain operation by name with params. Returns the operation
 * result (whatever shape gbrain returns; usually a JSON-serializable object).
 *
 * @throws {Error} on transport failure or operation error.
 */
export async function callGbrainOp(opName, params) {
  await initIfNeeded();
  // gbrain exposes operations as MCP "tools." The standard call is
  // tools/call with {name, arguments}.
  const result = await rpc('tools/call', { name: opName, arguments: params || {} });
  // gbrain returns {content: [{type:'text', text:'...JSON...'}]}; parse if needed.
  if (result?.content?.[0]?.type === 'text') {
    const text = result.content[0].text;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return result;
}

/**
 * Test hook: stub the underlying RPC. Tests use this instead of spawning a
 * real gbrain child. Pass `null` to restore the real spawn-and-rpc path.
 */
export function __setRpcForTests(fn) {
  if (fn === null) {
    _testRpc = null;
    return;
  }
  _testRpc = fn;
}

let _testRpc = null;

// Re-export rpc through the test hook for callGbrainOp.
const _origRpc = rpc;
async function dispatchRpc(method, params) {
  if (_testRpc) return _testRpc(method, params);
  return _origRpc(method, params);
}

// Override the helper used by callGbrainOp.
export async function _testableCallGbrainOp(opName, params) {
  if (_testRpc) {
    return _testRpc('tools/call', { name: opName, arguments: params || {} });
  }
  return callGbrainOp(opName, params);
}

/**
 * Shutdown helper. Tests call this between cases; production never has to.
 */
export function shutdown() {
  if (_child) {
    _child.kill();
    _child = null;
  }
  _pending.clear();
  _initialized = false;
  _buffer = '';
}
