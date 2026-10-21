import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { PatchSchema } from './patch.ts';
import { Service } from './service.ts';

const svc = new Service();
const server = new McpServer({ name: 'rrweb-replay', version: '0.1.0' });

// The SDK's generic tool typing recurses without bound on zod 3.25; the
// schemas are still validated at runtime, so register through a loose type.
type Handler = (args: any) => Promise<unknown>; // eslint-disable-line @typescript-eslint/no-explicit-any
const register = server.registerTool.bind(server) as unknown as (
  name: string,
  config: { description: string; inputSchema: Record<string, unknown> },
  cb: Handler,
) => void;

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const guard = async (fn: () => Promise<string> | string) => {
  try {
    return text(await fn());
  } catch (e) {
    return { ...text(`error: ${(e as Error).message}`), isError: true };
  }
};

register(
  'load_recording',
  {
    description:
      'Open a recording-*.zip and get its steps, one line each. Read this once, then send ONE patch to run. Steps marked · are skipped by default.',
    inputSchema: { zip: z.string().describe('path to the recording-*.zip') },
  },
  ({ zip }) => guard(() => svc.load(zip)),
);

register(
  'run',
  {
    description:
      'Replay the loaded recording in a visible browser, applying the patch. Code replays and compares; you hear back only a one-line summary, or the one step that went wrong (recorded vs actual). ' +
      'patch: {set:{"18.value":"check 2"}, skip:[7,8], range:[from,to], replace:{"12":{type,locator,value}}, insert:[{after,step}]}. ' +
      'Sign-in comes from the browser session. A write that gets no answer is never repeated. reuse: name of a saved clean run.',
    inputSchema: {
      patch: z.any().optional().describe('see description'),
      reuse: z.string().optional().describe('name of a saved run to repeat as-is'),
      save: z.string().optional().describe('name to save this patch under if the run is clean'),
      slow: z.tuple([z.number(), z.number()]).optional().describe('add a random [min,max] ms delay to every API call, to test slow servers'),
      continueOnDiverge: z.boolean().optional(),
    },
  },
  (a) => guard(() => svc.run({ ...a, patch: a.patch === undefined ? undefined : PatchSchema.parse(a.patch) })),
);

register(
  'inspect',
  {
    description:
      'No step: the step list. With step: that step recorded vs what the replay did, and its recorded request list. With step+request: that request body. With live:true: the current page as text (route, messages, usable controls) — use this instead of a screenshot.',
    inputSchema: { step: z.number().int().optional(), request: z.number().int().optional(), live: z.boolean().optional() },
  },
  ({ step, request, live }) => guard(() => (live ? svc.pageState() : svc.inspect({ step, request }))),
);

register(
  'screenshot',
  { description: 'Screenshot of the replay browser. Only when text from inspect(live) is not enough.', inputSchema: {} },
  async () => {
    try {
      const s = await svc.screenshot();
      return typeof s === 'string' ? text(s) : { content: [{ type: 'image' as const, data: s.data, mimeType: s.mimeType }] };
    } catch (e) {
      return { ...text(`error: ${(e as Error).message}`), isError: true };
    }
  },
);

register(
  'close_browser',
  { description: 'Close the replay browser (the saved sign-in stays).', inputSchema: {} },
  () => guard(async () => (await svc.close(), 'closed')),
);

await server.connect(new StdioServerTransport());
