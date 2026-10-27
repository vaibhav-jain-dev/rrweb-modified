import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Browser from 'webextension-polyfill';
import {
  Alert,
  AlertIcon,
  Badge,
  Box,
  Button,
  Code,
  Collapse,
  Flex,
  HStack,
  Input,
  Spinner,
  Tab,
  TabList,
  Tabs,
  Text,
  VStack,
} from '@chakra-ui/react';
import { LocalDataKey, RecorderStatus } from '~/types';
import type { AgentStatus, LocalData } from '~/types';
import {
  DEFAULT_AGENT_CONFIG,
  type AgentConfig,
  type Check,
  type Evidence,
  type LaneLedger,
  type Ledger,
  type RequestDetail,
  type SseEvent,
} from '~/agent/protocol';
import { fetchRequest, postAsk, streamUrl } from '~/agent/backend';
import {
  STATUS_TEXT,
  STATUS_TONE,
  formatElapsed,
  laneBadge,
  orderChecks,
  stepIcon,
} from '~/agent/ui';

type Conn = 'idle' | 'live' | 'reconnecting' | 'ended';

const TONE_SCHEME = {
  green: 'green',
  red: 'red',
  orange: 'orange',
  gray: 'gray',
  blue: 'blue',
} as const;

export function App() {
  const [config, setConfig] = useState<AgentConfig>(DEFAULT_AGENT_CONFIG);
  const [status, setStatus] = useState<RecorderStatus>(RecorderStatus.IDLE);
  const [agentStatus, setAgentStatus] = useState<AgentStatus | undefined>();
  const [ledger, setLedger] = useState<Ledger | undefined>();
  const [conn, setConn] = useState<Conn>('idle');
  const [lane, setLane] = useState(0);

  // ---- what the extension is doing ----------------------------------------
  useEffect(() => {
    const apply = (all: Partial<LocalData>) => {
      const cfg = all[LocalDataKey.agentConfig];
      if (cfg) setConfig({ ...DEFAULT_AGENT_CONFIG, ...cfg });
      const rec = all[LocalDataKey.recorderStatus];
      if (rec) setStatus(rec.status);
      if (LocalDataKey.agentStatus in all)
        setAgentStatus(all[LocalDataKey.agentStatus]);
    };
    void Browser.storage.local
      .get([
        LocalDataKey.agentConfig,
        LocalDataKey.recorderStatus,
        LocalDataKey.agentStatus,
      ])
      .then((all) => apply(all as Partial<LocalData>));
    const onChange = (
      changes: Record<string, Browser.Storage.StorageChange>,
    ) => {
      const next: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(changes)) next[k] = v.newValue;
      apply(next as Partial<LocalData>);
    };
    Browser.storage.local.onChanged.addListener(onChange);
    return () => Browser.storage.local.onChanged.removeListener(onChange);
  }, []);

  // ---- the live stream ------------------------------------------------------
  // Follow the session the agent client reported, not the recorder's own id:
  // the recorder drops its id at Stop, but the final ledger arrives just after.
  const followId = agentStatus?.sessionId;
  const lastSession = useRef<string | undefined>();
  const [ended, setEnded] = useState(false);

  useEffect(() => {
    if (followId !== lastSession.current) {
      // A new recording: forget the previous one.
      lastSession.current = followId;
      setLedger(undefined);
      setLane(0);
      setEnded(false);
      setConn('idle');
    }
  }, [followId]);

  useEffect(() => {
    if (!followId || ended) return;
    let es: EventSource | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    let failures = 0;
    const open = () => {
      es = new EventSource(streamUrl(config, followId));
      es.onopen = () => {
        failures = 0;
        setConn('live');
      };
      es.onerror = () => {
        // A browser EventSource gives up for good on a 404 (the backend has
        // not created the session yet), so reconnect by hand - but not
        // forever: an old session the backend has dropped will never appear.
        es?.close();
        if (disposed) return;
        if (++failures > 20) {
          setConn('idle');
          return;
        }
        setConn('reconnecting');
        timer = setTimeout(open, 1500);
      };
      es.onmessage = (m) => {
        let ev: SseEvent;
        try {
          ev = JSON.parse(m.data as string) as SseEvent;
        } catch {
          return;
        }
        if (ev.type === 'ledger') setLedger(ev.ledger);
        else if (ev.type === 'end') {
          setConn('ended');
          setEnded(true);
          es?.close();
        }
      };
    };
    open();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      es?.close();
    };
  }, [followId, ended, config]);

  const lanes = ledger?.lanes ?? [];
  const active: LaneLedger | undefined =
    lanes[Math.min(lane, Math.max(0, lanes.length - 1))];

  return (
    <Flex direction="column" h="100vh" fontSize="sm">
      <Header
        ledger={ledger}
        conn={conn}
        agentStatus={agentStatus}
        recording={status !== RecorderStatus.IDLE}
      />
      <Box flex="1" overflowY="auto" px="3" pb="3">
        {config.playbooks.length === 0 && !ledger && <Empty />}
        {config.playbooks.length > 0 &&
          !ledger &&
          status === RecorderStatus.IDLE && (
            <Text color="gray.600" mt="4">
              Ready. Press Start in the popup; the agent will check each write
              against the database as you work.
            </Text>
          )}
        {config.playbooks.length > 0 &&
          !ledger &&
          status !== RecorderStatus.IDLE && (
            <HStack mt="4" color="gray.600">
              <Spinner size="sm" />
              <Text>Connecting to the agent backend…</Text>
            </HStack>
          )}
        {agentStatus?.message && agentStatus.state !== 'finished' && (
          <Alert
            status={agentStatus.state === 'lost' ? 'warning' : 'info'}
            mt="3"
            fontSize="xs"
            borderRadius="md"
          >
            <AlertIcon />
            {agentStatus.message}
          </Alert>
        )}
        {lanes.length > 1 && (
          <Tabs
            index={lane}
            onChange={setLane}
            size="sm"
            mt="2"
            variant="enclosed"
          >
            <TabList>
              {lanes.map((l) => {
                const b = laneBadge(l);
                return (
                  <Tab key={l.playbookId}>
                    {l.title}
                    <Badge ml="2" colorScheme={TONE_SCHEME[b.tone]}>
                      {b.text}
                    </Badge>
                  </Tab>
                );
              })}
            </TabList>
          </Tabs>
        )}
        {active && (
          <LanePanel
            lane={active}
            config={config}
            sessionId={ledger!.sessionId}
            ended={conn === 'ended'}
          />
        )}
      </Box>
    </Flex>
  );
}

function Header({
  ledger,
  conn,
  agentStatus,
  recording,
}: {
  ledger?: Ledger;
  conn: Conn;
  agentStatus?: AgentStatus;
  recording: boolean;
}) {
  const model = ledger?.model ?? agentStatus?.model;
  const connLabel =
    conn === 'live'
      ? 'live'
      : conn === 'reconnecting'
      ? 'reconnecting…'
      : conn === 'ended'
      ? 'finished'
      : recording
      ? 'waiting'
      : 'idle';
  const tone =
    conn === 'live' ? 'green' : conn === 'reconnecting' ? 'orange' : 'gray';
  return (
    <Flex
      align="center"
      px="3"
      py="2"
      borderBottomWidth="1px"
      gap="2"
      wrap="wrap"
    >
      <Text fontWeight="bold">Live agent</Text>
      <Badge colorScheme={tone}>{connLabel}</Badge>
      <Text
        fontSize="xs"
        color="gray.500"
        ml="auto"
        noOfLines={1}
        title={model}
      >
        {model ?? 'no model'}
      </Text>
    </Flex>
  );
}

function Empty() {
  return (
    <VStack align="start" mt="4" spacing="2" color="gray.700">
      <Text fontWeight="semibold">No playbook selected</Text>
      <Text>
        Open the extension popup, pick one or more playbooks under “Live agent”,
        then press Start. This panel shows each check as it happens.
      </Text>
      <Text fontSize="xs" color="gray.500">
        The agent backend must be running: <Code>yarn agent:start</Code>
      </Text>
    </VStack>
  );
}

function LanePanel({
  lane,
  config,
  sessionId,
  ended,
}: {
  lane: LaneLedger;
  config: AgentConfig;
  sessionId: string;
  ended: boolean;
}) {
  const checks = useMemo(() => orderChecks(lane.checks), [lane.checks]);
  const uncovered = Object.entries(lane.uncovered);
  const headlineScheme =
    lane.gateReadyAt !== undefined
      ? 'green'
      : lane.headline.level === 'bad'
      ? 'red'
      : lane.headline.level === 'ok'
      ? 'green'
      : lane.headline.level === 'checking'
      ? 'blue'
      : 'gray';

  return (
    <VStack align="stretch" spacing="3" mt="3">
      {/* aria-live so a screen reader hears "go ahead" without moving focus */}
      <Box
        role="status"
        aria-live="polite"
        borderWidth="1px"
        borderRadius="md"
        p="3"
        borderColor={`${headlineScheme}.300`}
        bg={`${headlineScheme}.50`}
      >
        <HStack align="start">
          {lane.headline.level === 'checking' && <Spinner size="sm" mt="1" />}
          <Text fontWeight="semibold" fontSize="md">
            {lane.gateReadyAt !== undefined
              ? 'Go ahead — every step is verified'
              : lane.headline.text}
          </Text>
        </HStack>
      </Box>

      {lane.steps && lane.steps.length > 0 && (
        <Box>
          <Text fontSize="xs" textTransform="uppercase" color="gray.500" mb="1">
            Steps
          </Text>
          <VStack align="stretch" spacing="1">
            {lane.steps.map((s, i) => (
              <HStack
                key={i}
                align="start"
                opacity={s.state === 'upcoming' ? 0.6 : 1}
                fontWeight={i === lane.currentStep ? 'semibold' : 'normal'}
              >
                <Text w="4" aria-hidden>
                  {stepIcon(s.state)}
                </Text>
                <Text>
                  {s.say}
                  {s.state === 'blocked' && (
                    <Text as="span" color="red.600">
                      {' '}
                      — a check failed
                    </Text>
                  )}
                </Text>
              </HStack>
            ))}
          </VStack>
        </Box>
      )}

      <Box>
        <Text fontSize="xs" textTransform="uppercase" color="gray.500" mb="1">
          Checks ({lane.checks.length})
        </Text>
        {checks.length === 0 && (
          <Text color="gray.500">
            Nothing yet. Checks appear when the app makes a write the playbook
            knows about.
          </Text>
        )}
        <VStack align="stretch" spacing="2">
          {checks.map((c) => (
            <CheckRow
              key={c.id}
              check={c}
              config={config}
              sessionId={sessionId}
            />
          ))}
        </VStack>
      </Box>

      {(uncovered.length > 0 || lane.anomalies.length > 0) && (
        <Box>
          <Text fontSize="xs" textTransform="uppercase" color="gray.500" mb="1">
            Not verified
          </Text>
          <VStack align="stretch" spacing="1">
            {uncovered.map(([endpoint, n]) => (
              <Text key={endpoint} color="orange.700">
                {endpoint} ×{n} — wrote data, no rule checks it
              </Text>
            ))}
            {lane.anomalies
              .filter((a) => a.kind !== 'uncovered_write')
              .slice(-6)
              .map((a, i) => (
                <Text key={i} color="orange.700">
                  {a.text}
                </Text>
              ))}
          </VStack>
        </Box>
      )}

      {lane.observations.length > 0 && (
        <Box>
          <Text fontSize="xs" textTransform="uppercase" color="gray.500" mb="1">
            Noticed (model — unverified)
          </Text>
          <VStack align="stretch" spacing="1">
            {lane.observations.slice(-5).map((o, i) => (
              <Text key={i} color="gray.700">
                {o.text}
              </Text>
            ))}
          </VStack>
        </Box>
      )}

      {!ended && (
        <AskBox
          config={config}
          sessionId={sessionId}
          playbookId={lane.playbookId === 'asks' ? undefined : lane.playbookId}
        />
      )}
    </VStack>
  );
}

function CheckRow({
  check,
  config,
  sessionId,
}: {
  check: Check;
  config: AgentConfig;
  sessionId: string;
}) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<RequestDetail | string | undefined>();
  const tone = STATUS_TONE[check.status];
  const elapsed =
    check.tResolved !== undefined && check.tObserved !== undefined
      ? formatElapsed(check.tResolved - check.tObserved)
      : undefined;

  const loadRequest = useCallback(async () => {
    if (!check.requestId) return;
    try {
      setDetail(await fetchRequest(config, sessionId, check.requestId));
    } catch {
      setDetail('That request is no longer held by the backend.');
    }
  }, [check.requestId, config, sessionId]);

  return (
    <Box borderWidth="1px" borderRadius="md" p="2">
      <HStack align="start" justify="space-between">
        <Box minW="0">
          <HStack spacing="2" wrap="wrap">
            <Badge colorScheme={TONE_SCHEME[tone]}>
              {STATUS_TEXT[check.status]}
            </Badge>
            {check.origin === 'ask' && <Badge variant="outline">asked</Badge>}
            {elapsed && (
              <Text fontSize="xs" color="gray.500">
                {elapsed}
              </Text>
            )}
          </HStack>
          <Text mt="1" fontWeight="medium">
            {check.claim}
          </Text>
          {check.endpoint && (
            <Text fontSize="xs" color="gray.500">
              {check.endpoint}
            </Text>
          )}
          {check.activity && (
            <HStack mt="1" color="blue.600">
              <Spinner size="xs" />
              <Text fontSize="xs">{check.activity}</Text>
            </HStack>
          )}
          {check.note && !check.activity && <Text mt="1">{check.note}</Text>}
          {check.warnings?.map((w, i) => (
            <Text key={i} fontSize="xs" color="orange.700">
              ⚠ {w}
            </Text>
          ))}
        </Box>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          {open ? 'Hide' : 'Evidence'}
        </Button>
      </HStack>
      <Collapse in={open} animateOpacity>
        <VStack align="stretch" spacing="1" mt="2">
          {check.evidence.map((e, i) => (
            <EvidenceLine key={i} e={e} />
          ))}
          {check.requestId && (
            <Button
              size="xs"
              alignSelf="start"
              onClick={() => void loadRequest()}
            >
              Show the request
            </Button>
          )}
          {typeof detail === 'string' && <Text fontSize="xs">{detail}</Text>}
          {detail && typeof detail !== 'string' && (
            <Code
              display="block"
              whiteSpace="pre-wrap"
              fontSize="xs"
              p="2"
              maxH="40"
              overflowY="auto"
            >
              {JSON.stringify(
                {
                  request: detail.requestBody,
                  response: detail.responseBody,
                  status: detail.status,
                },
                null,
                2,
              )}
            </Code>
          )}
        </VStack>
      </Collapse>
    </Box>
  );
}

function EvidenceLine({ e }: { e: Evidence }) {
  const text = (() => {
    switch (e.kind) {
      case 'request':
        return `request: ${e.url ?? e.endpoint}${
          e.status ? ` → ${e.status}` : ''
        }`;
      case 'tool':
        return `${e.ref}\n  args ${JSON.stringify(
          e.args,
        )}\n  result ${JSON.stringify(e.result)}  (${e.ms} ms, try ${
          e.attempt
        })`;
      case 'assert':
        return `${e.ok ? '✓' : '✕'}${e.soft ? ' (soft)' : ''} ${e.path} ${
          e.op
        } ${JSON.stringify(e.expected)}  — got ${JSON.stringify(e.actual)}`;
      case 'error':
        return `error: ${e.message}`;
      case 'timeout':
        return `gave up after ${formatElapsed(e.withinMs)}`;
    }
  })();
  return (
    <Code
      display="block"
      whiteSpace="pre-wrap"
      fontSize="xs"
      p="1"
      wordBreak="break-all"
    >
      {text}
    </Code>
  );
}

function AskBox({
  config,
  sessionId,
  playbookId,
}: {
  config: AgentConfig;
  sessionId: string;
  playbookId?: string;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<
    { ok: boolean; message: string } | undefined
  >();

  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    setReply(undefined);
    const out = await postAsk(config, sessionId, t, playbookId);
    setBusy(false);
    if (out.ok) {
      setText('');
      setReply({
        ok: true,
        message: 'On it — it will appear in the checks above.',
      });
    } else {
      setReply({ ok: false, message: out.message ?? 'That did not work.' });
    }
  };

  return (
    <Box pt="2" borderTopWidth="1px">
      <Text fontSize="xs" textTransform="uppercase" color="gray.500" mb="1">
        Ask the agent to check something
      </Text>
      <HStack>
        <Input
          size="sm"
          value={text}
          placeholder="e.g. check the order I just placed was received"
          aria-label="Ask the agent to check something"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void send();
          }}
        />
        <Button
          size="sm"
          onClick={() => void send()}
          isLoading={busy}
          isDisabled={!text.trim()}
        >
          Ask
        </Button>
      </HStack>
      {reply && (
        <Text
          mt="1"
          fontSize="xs"
          color={reply.ok ? 'green.700' : 'red.600'}
          role="status"
        >
          {reply.message}
        </Text>
      )}
    </Box>
  );
}
