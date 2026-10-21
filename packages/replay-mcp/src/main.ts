import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Lease } from './lease.ts';
import { PatchSchema } from './patch.ts';
import { Service } from './service.ts';

const svc = new Service();
const idleMin = Number(process.env.REPLAY_IDLE_MS ?? 15 * 60_000) / 60_000;
const lease = new Lease(idleMin * 60_000, () => svc.close());
lease.touch();

const server = new McpServer(
  { name: 'rrweb-replay', version: '0.1.0' },
  {
    instructions:
      `The replay browser stays open between calls, but is closed after ${idleMin} min with no call from you (the saved sign-in stays). ` +
      'Any tool call renews that; if you will wait on the user for longer, call keepalive at least every ' +
      `${Math.max(1, Math.floor(idleMin) - 2)} min. The user may also click around in the browser themselves: call changes to learn what they did since you last asked (it returns only what is new). ` +
      'If a call says the browser was closed, run again (or watch start) to reopen it. ' +
      'Watching without a recording: watch {action:"start", url?} opens the window for the user; they use it freely. ' +
      'When they say "note this" call note {text}; "note from here" call note {text, from:true} and later note {done:id}. ' +
      'Ask changes (what is new) or changes {note:id} (what happened inside a note) instead of taking screenshots; use screenshot only when the text is not enough, with a selector for just one part.',
  },
);

// The SDK's generic tool typing recurses without bound on zod 3.25; the
// schemas are still validated at runtime, so register through a loose type.
type Handler = (args: any) => Promise<unknown>; // eslint-disable-line @typescript-eslint/no-explicit-any
const register = server.registerTool.bind(server) as unknown as (
  name: string,
  config: { description: string; inputSchema: Record<string, unknown> },
  cb: Handler,
) => void;

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
/** Run a tool call under the lease, tell the bot if the browser was closed meanwhile, and (when asked) how long it has left. */
const guard = async (fn: () => Promise<string> | string, footer = false) => {
  const notice = lease.takeExpiryNotice();
  try {
    const body = await lease.hold(fn);
    const left = footer && svc.state().startsWith('browser open') ? `\n[idle limit: closes in ${Math.ceil(lease.remainingMs() / 60000)} min unless you call something]` : '';
    return text([notice ? `note: ${notice}` : '', body, left].filter(Boolean).join('\n'));
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
  (a) => guard(() => svc.run({ ...a, patch: a.patch === undefined ? undefined : PatchSchema.parse(a.patch) }), true),
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
  'changes',
  {
    description:
      'What the user did in the browser by hand (clicks, typed values, page changes), the calls the page made and how the screen changed, since the last time you asked. Returns only what is new. With note: what happened inside that note instead. Use it when the user says they did something.',
    inputSchema: { note: z.number().int().optional().describe('note id: show what happened inside that note') },
  },
  ({ note }) => guard(() => svc.changes(note), true),
);

register(
  'watch',
  {
    description: 'Start watching: open the browser for the user (optionally at url) and follow what they do, with no recording needed. Sign in by hand if asked; the sign-in is kept. action stop: stop recording their activity.',
    inputSchema: { action: z.enum(['start', 'stop']).optional(), url: z.string().optional() },
  },
  (a) => guard(() => svc.watch(a), true),
);

register(
  'note',
  {
    description: 'The user\'s marker. text: "note this" (a point in time). text + from:true: "note from here" (a span until you call done). done: close span id. No arguments: list the notes.',
    inputSchema: { text: z.string().optional(), from: z.boolean().optional(), done: z.number().int().optional() },
  },
  (a) => guard(() => svc.note(a)),
);

register(
  'keepalive',
  {
    description: `Keep the browser open. It is closed after ${idleMin} min with no call at all, so send this at least every ${Math.max(1, Math.floor(idleMin) - 2)} min while you wait on the user. Any other call also renews it.`,
    inputSchema: {},
  },
  () => guard(() => svc.state(), true),
);

register(
  'screenshot',
  { description: 'Screenshot (small jpeg) of the browser. Only when text from changes / inspect(live) is not enough. selector: just that element, cheaper.', inputSchema: { selector: z.string().optional() } },
  async ({ selector }) => {
    try {
      const s = await lease.hold(() => svc.screenshot(selector));
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
