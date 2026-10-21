/** A tiny app shaped like the one in the recording: login, create, edit, save — with slow APIs. */
import { createServer } from 'node:http';
import type { Server } from 'node:http';

export type MockConfig = { loanDelayMs: number; patchDelayMs: number; patchStatus: number };
export type MockApp = { origin: string; cfg: MockConfig; patches: unknown[]; loans: number; server: Server; close: () => Promise<void> };

const LOAN_ID = '6ad9048365a2e66b7a01251a';

const LOGIN = `<!doctype html><title>Login</title><input name=email placeholder="Email"><input name=password type=password><button id=go>Sign In</button>
<script>go.onclick=async()=>{await fetch('/api/login',{method:'POST'});location='/home'}</script>`;

const HOME = `<!doctype html><title>Home</title><button id=add>Add Loan</button><div id=out></div><div id=toast role=status></div>
<script>
const toast=t=>{document.getElementById('toast').textContent=t};
add.onclick=async()=>{const r=await fetch('/api/loan',{method:'POST'});const j=await r.json();toast('Loan created');
 out.innerHTML='<button id=edit>Edit notes</button>';
 edit.onclick=()=>{out.innerHTML+='<input id=notes placeholder="Notes"><button id=save>Save Application</button>';
  save.onclick=async()=>{const r=await fetch('/api/loan/'+j.id,{method:'PATCH',body:JSON.stringify({notes:document.getElementById('notes').value}),headers:{'content-type':'application/json'}});toast(r.ok?'Saved':'Error')}}}
</script>`;

export async function startMock(cfg: Partial<MockConfig> = {}): Promise<MockApp> {
  const state = { loans: 0 };
  const app = {
    cfg: { loanDelayMs: 300, patchDelayMs: 300, patchStatus: 200, ...cfg },
    patches: [] as unknown[],
    get loans() {
      return state.loans;
    },
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const server = createServer(async (req, res) => {
    const signedIn = (req.headers.cookie ?? '').includes('sid=1');
    const send = (code: number, body: string, type = 'text/html') => {
      res.writeHead(code, { 'content-type': type });
      res.end(body);
    };
    if (req.method === 'GET' && req.url === '/login') return signedIn ? (res.writeHead(302, { location: '/home' }), res.end()) : send(200, LOGIN);
    if (req.method === 'GET' && req.url === '/home') return signedIn ? send(200, HOME) : (res.writeHead(302, { location: '/login' }), res.end());
    if (req.method === 'POST' && req.url === '/api/login') {
      await sleep(200);
      res.writeHead(200, { 'set-cookie': 'sid=1; Path=/; Max-Age=3600', 'content-type': 'application/json' });
      return res.end('{}');
    }
    if (req.method === 'POST' && req.url === '/api/loan') {
      await sleep(app.cfg.loanDelayMs);
      state.loans++;
      return send(201, JSON.stringify({ id: LOAN_ID }), 'application/json');
    }
    if (req.method === 'PATCH' && req.url === `/api/loan/${LOAN_ID}`) {
      let body = '';
      for await (const c of req) body += c;
      await sleep(app.cfg.patchDelayMs);
      app.patches.push(JSON.parse(body));
      return send(app.cfg.patchStatus, '{}', 'application/json');
    }
    send(404, 'not found');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return Object.assign(app, {
    origin: `http://127.0.0.1:${port}`,
    server,
    close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))),
  });
}

export const MOCK_LOAN_ID = LOAN_ID;
