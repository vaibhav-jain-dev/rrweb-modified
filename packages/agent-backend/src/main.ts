import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_DEFAULT_PORT } from '../../web-extension/src/agent/protocol.ts';
import { loadConfig } from './config/load.ts';
import { readEnvFile } from './config/env.ts';
import { OllamaClient } from './model/ollama.ts';
import type { ModelClient } from './model/types.ts';
import { createAgentServer, VERSION } from './server.ts';
import { ToolRegistry } from './tools/registry.ts';

const here = dirname(fileURLToPath(import.meta.url));

/** The backend's own .env (model, port, overrides) sits in the config directory. */
function loadOwnEnv(dir: string): void {
  const file = resolve(dir, '.env');
  if (!existsSync(file)) return;
  for (const [k, v] of Object.entries(readEnvFile(file)))
    if (process.env[k] === undefined) process.env[k] = v;
}

export function resolveConfigDir(): string {
  return resolve(
    process.env.AGENT_CONFIG_DIR ?? resolve(here, '../config/lms'),
  );
}

export function buildModel(): ModelClient | null {
  const name = process.env.AGENT_MODEL ?? 'qwen2.5-coder:3b';
  if (name === 'none') return null;
  return new OllamaClient({
    host: process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434',
    model: name,
  });
}

async function main(): Promise<void> {
  const dir = resolveConfigDir();
  loadOwnEnv(dir);
  const config = loadConfig(dir);
  const registry = new ToolRegistry(config);
  const model = buildModel();
  const port = Number(process.env.AGENT_PORT ?? AGENT_DEFAULT_PORT);
  const host = process.env.AGENT_HOST ?? '127.0.0.1';
  if (host !== '127.0.0.1' && !process.env.AGENT_TOKEN) {
    console.warn(
      '! AGENT_HOST is not loopback and AGENT_TOKEN is unset: anything on the network can read your recordings. Set AGENT_TOKEN.',
    );
  }

  const agent = createAgentServer({
    config,
    registry,
    model,
    token: process.env.AGENT_TOKEN,
    host,
    port,
  });
  const addr = await agent.listen();

  console.log(
    `agent-backend ${VERSION} listening on http://${addr.host}:${addr.port}`,
  );
  console.log(`mcp: http://${addr.host}:${addr.port}/mcp`);
  console.log(`config: ${dir}`);
  console.log(
    `model: ${model?.name ?? 'none (rules only)'}   playbooks: ${
      config.playbooks.map((p) => p.id).join(', ') || '(none)'
    }`,
  );
  for (const w of config.warnings) console.warn(`! ${w}`);
  for (const [tool, why] of registry.invalid)
    console.warn(`! tool ${tool} disabled: ${why}`);
  const health = await registry.health();
  for (const [name, h] of Object.entries(health)) {
    console.log(
      `source ${name} (${h.type}): ${
        h.ready ? 'ready' : `NOT READY - ${h.error ?? 'unknown'}`
      }`,
    );
  }

  const stop = () => {
    void agent.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

// Only run when executed directly, not when imported by the CLI or tests.
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
