/** Plain fetch helpers for the agent backend, used by the popup and the side panel. */
import type {
  AgentConfig,
  AskResponse,
  HealthResponse,
  PlaybookSummary,
  RequestDetail,
} from './protocol';

const TIMEOUT_MS = 2500;

function headers(
  config: AgentConfig,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    ...(config.token ? { 'x-agent-token': config.token } : {}),
    ...extra,
  };
}

async function getJson<T>(config: AgentConfig, path: string): Promise<T> {
  const res = await fetch(new URL(path, config.backendUrl), {
    headers: headers(config),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok)
    throw new Error(
      res.status === 401
        ? 'The backend rejected the token'
        : `The backend answered ${res.status}`,
    );
  return (await res.json()) as T;
}

export const fetchHealth = (c: AgentConfig) =>
  getJson<HealthResponse>(c, '/health');
export const fetchPlaybooks = (c: AgentConfig) =>
  getJson<PlaybookSummary[]>(c, '/playbooks');
export const fetchRequest = (
  c: AgentConfig,
  sessionId: string,
  requestId: string,
) =>
  getJson<RequestDetail>(
    c,
    `/sessions/${encodeURIComponent(sessionId)}/requests/${encodeURIComponent(
      requestId,
    )}`,
  );

export async function postAsk(
  c: AgentConfig,
  sessionId: string,
  text: string,
  playbookId?: string,
): Promise<AskResponse> {
  try {
    const res = await fetch(
      new URL(`/sessions/${encodeURIComponent(sessionId)}/ask`, c.backendUrl),
      {
        method: 'POST',
        headers: headers(c, { 'content-type': 'application/json' }),
        // The model may take a few seconds to answer; this is not the health timeout.
        signal: AbortSignal.timeout(60_000),
        body: JSON.stringify({ text, playbookId }),
      },
    );
    return (await res.json()) as AskResponse;
  } catch (e) {
    return {
      ok: false,
      message:
        e instanceof Error ? e.message : 'The backend could not be reached',
    };
  }
}

/** EventSource cannot set headers, so the token travels in the query string. */
export function streamUrl(c: AgentConfig, sessionId: string): string {
  const u = new URL(
    `/sessions/${encodeURIComponent(sessionId)}/stream`,
    c.backendUrl,
  );
  if (c.token) u.searchParams.set('token', c.token);
  return u.toString();
}

export function describeError(e: unknown): string {
  if (
    e instanceof DOMException &&
    (e.name === 'TimeoutError' || e.name === 'AbortError')
  )
    return 'The backend did not answer';
  if (e instanceof TypeError) return 'The backend is not running';
  return e instanceof Error ? e.message : 'The backend could not be reached';
}
