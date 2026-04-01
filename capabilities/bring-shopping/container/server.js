const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

const GRPC_PORT = 50051;
const MCP_TIMEOUT_MS = 20000;
const DISCOVERY_TOOL_NAME = 'list_tools';

const READ_ONLY_TOOLS = new Set([
  'loadLists',
  'getDefaultList',
  'getItems',
  'getItemsDetails',
  'getAllUsersFromList',
  'getUserSettings',
  'loadTranslations',
  'loadCatalog',
  'getPendingInvitations',
]);

const protoPath = path.join(__dirname, 'capability.proto');
const packageDefinition = protoLoader.loadSync(protoPath, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const proto = grpc.loadPackageDefinition(packageDefinition).selu.capability.v1;

function logInfo(msg) {
  process.stderr.write(`${new Date().toISOString()} [INFO] ${msg}\n`);
}

function safeJsonParse(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch (_e) {
    return fallback;
  }
}

function normalizePolicy(toolName) {
  return READ_ONLY_TOOLS.has(toolName) ? 'allow' : 'ask';
}

function normalizeDiscoveryPayload(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('tools/list result must be an object');
  }
  const tools = raw.tools;
  if (!Array.isArray(tools)) {
    throw new Error("tools/list result must contain 'tools' array");
  }

  const normalized = [];
  for (const item of tools) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (!name) {
      continue;
    }

    const description =
      typeof item.description === 'string' && item.description.trim().length > 0
        ? item.description
        : `Invoke bring-mcp tool '${name}'.`;

    const inputSchema =
      item.inputSchema && typeof item.inputSchema === 'object'
        ? item.inputSchema
        : { type: 'object', properties: {}, required: [] };

    normalized.push({
      name,
      description,
      input_schema: inputSchema,
      recommended_policy: normalizePolicy(name),
    });
  }

  return normalized;
}

class McpBridge {
  constructor(mail, password) {
    this.mail = mail;
    this.password = password;
    this.proc = null;
    this.nextId = 1;
    this.messageQueue = [];
    this.waiters = [];
    this.readline = null;
  }

  async start() {
    const env = { ...process.env, MAIL: this.mail, PW: this.password };
    this.proc = spawn('bring-mcp', [], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stderr.on('data', (chunk) => {
      const line = chunk.toString('utf8').trim();
      if (line) {
        logInfo(`bring-mcp: ${line}`);
      }
    });

    this.proc.on('exit', (code, signal) => {
      const reason = `bring-mcp exited (code=${code} signal=${signal})`;
      for (const waiter of this.waiters.splice(0)) {
        waiter.reject(new Error(reason));
      }
    });

    this.readline = readline.createInterface({ input: this.proc.stdout });
    this.readline.on('line', (line) => {
      const parsed = safeJsonParse(line, null);
      if (parsed && typeof parsed === 'object') {
        this._dispatchMessage(parsed);
      }
    });

    await this._initialize();
  }

  async close() {
    if (!this.proc) {
      return;
    }

    const proc = this.proc;
    this.proc = null;

    if (this.readline) {
      this.readline.close();
      this.readline = null;
    }

    if (!proc.killed) {
      proc.kill('SIGTERM');
    }

    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (!proc.killed) {
          proc.kill('SIGKILL');
        }
        resolve();
      }, 2000);

      proc.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  async callTool(toolName, args) {
    const res = await this._sendRequest('tools/call', {
      name: toolName,
      arguments: args,
    });
    if (res.error) {
      throw new Error(JSON.stringify(res.error));
    }
    return res.result;
  }

  async listTools() {
    const res = await this._sendRequest('tools/list', {});
    if (res.error) {
      throw new Error(JSON.stringify(res.error));
    }
    return res.result;
  }

  async _initialize() {
    const init = await this._sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'selu-bring-shopping-wrapper',
        version: '1.0.0',
      },
    });
    if (init.error) {
      throw new Error(`MCP initialize failed: ${JSON.stringify(init.error)}`);
    }
    this._sendNotification('notifications/initialized', {});
  }

  _sendNotification(method, params) {
    this._writeMessage({ jsonrpc: '2.0', method, params });
  }

  async _sendRequest(method, params) {
    const id = this.nextId++;
    this._writeMessage({ jsonrpc: '2.0', id, method, params });

    const msg = await this._waitForMessage(
      (m) => Object.prototype.hasOwnProperty.call(m, 'id') && m.id === id,
      MCP_TIMEOUT_MS,
    );
    return msg;
  }

  _writeMessage(message) {
    if (!this.proc || !this.proc.stdin) {
      throw new Error('MCP process is not running');
    }
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  _waitForMessage(predicate, timeoutMs) {
    for (let i = 0; i < this.messageQueue.length; i += 1) {
      if (predicate(this.messageQueue[i])) {
        const hit = this.messageQueue[i];
        this.messageQueue.splice(i, 1);
        return Promise.resolve(hit);
      }
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.reject !== reject);
        reject(new Error('Timeout waiting for MCP response'));
      }, timeoutMs);

      this.waiters.push({
        predicate,
        resolve: (msg) => {
          clearTimeout(timeout);
          resolve(msg);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });
    });
  }

  _dispatchMessage(msg) {
    for (let i = 0; i < this.waiters.length; i += 1) {
      const waiter = this.waiters[i];
      if (waiter.predicate(msg)) {
        this.waiters.splice(i, 1);
        waiter.resolve(msg);
        return;
      }
    }
    this.messageQueue.push(msg);
  }
}

function decodeJsonBytes(bytes, fallback) {
  if (!bytes || bytes.length === 0) {
    return fallback;
  }
  const text = Buffer.isBuffer(bytes)
    ? bytes.toString('utf8')
    : Buffer.from(bytes).toString('utf8');
  return safeJsonParse(text, fallback);
}

async function handleInvoke(request) {
  const tool = request.tool_name;
  logInfo(`Invoke tool=${tool}`);

  const args = decodeJsonBytes(request.args_json, {});
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { error: 'args_json must be a JSON object', result_json: Buffer.alloc(0) };
  }

  const config = decodeJsonBytes(request.config_json, {});
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { error: 'config_json must be a JSON object', result_json: Buffer.alloc(0) };
  }

  if (tool === DISCOVERY_TOOL_NAME) {
    const mail = String(config.MAIL || 'discovery@example.com');
    const pw = String(config.PW || 'discovery');

    const bridge = new McpBridge(mail, pw);
    await bridge.start();
    try {
      const raw = await bridge.listTools();
      const normalized = normalizeDiscoveryPayload(raw);
      return {
        error: '',
        result_json: Buffer.from(JSON.stringify(normalized), 'utf8'),
      };
    } finally {
      await bridge.close();
    }
  }

  const mail = config.MAIL;
  const pw = config.PW;
  if (!mail || !pw) {
    return {
      error: 'Missing required credentials: MAIL and PW',
      result_json: Buffer.alloc(0),
    };
  }

  const bridge = new McpBridge(String(mail), String(pw));
  await bridge.start();
  try {
    const result = await bridge.callTool(tool, args);
    return {
      error: '',
      result_json: Buffer.from(JSON.stringify(result), 'utf8'),
    };
  } finally {
    await bridge.close();
  }
}

const serviceImpl = {
  Healthcheck(call, callback) {
    const hasBinary = (() => {
      const pathEnv = process.env.PATH || '';
      const dirs = pathEnv.split(':');
      for (const dir of dirs) {
        const candidate = path.join(dir, 'bring-mcp');
        if (fs.existsSync(candidate)) {
          return true;
        }
      }
      return false;
    })();

    if (!hasBinary) {
      callback(null, { ready: false, message: 'bring-mcp binary not found' });
      return;
    }

    callback(null, { ready: true, message: 'bring-shopping ready' });
  },

  async Invoke(call, callback) {
    try {
      const resp = await handleInvoke(call.request);
      callback(null, resp);
    } catch (err) {
      callback(null, {
        error: err instanceof Error ? err.message : String(err),
        result_json: Buffer.alloc(0),
      });
    }
  },

  StreamInvoke(call) {
    handleInvoke(call.request)
      .then((resp) => {
        if (resp.error) {
          call.write({ error: resp.error, done: true, data: Buffer.alloc(0) });
        } else {
          call.write({ error: '', done: true, data: resp.result_json });
        }
        call.end();
      })
      .catch((err) => {
        call.write({
          error: err instanceof Error ? err.message : String(err),
          done: true,
          data: Buffer.alloc(0),
        });
        call.end();
      });
  },
};

function serve() {
  const server = new grpc.Server();
  server.addService(proto.Capability.service, serviceImpl);
  server.bindAsync(
    `0.0.0.0:${GRPC_PORT}`,
    grpc.ServerCredentials.createInsecure(),
    (err) => {
      if (err) {
        throw err;
      }
      server.start();
      logInfo(`Bring shopping capability listening on port ${GRPC_PORT}`);
    },
  );

  const shutdown = () => {
    logInfo('Shutting down...');
    server.tryShutdown(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

serve();
