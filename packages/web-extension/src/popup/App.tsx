import { useState, useEffect } from 'react';
import Browser from 'webextension-polyfill';
import {
  Badge,
  Box,
  Button,
  Flex,
  IconButton,
  Input,
  Link,
  Menu,
  MenuButton,
  MenuItemOption,
  MenuList,
  MenuOptionGroup,
  Spacer,
  Stack,
  Text,
} from '@chakra-ui/react';
import { FiSettings, FiList, FiPause, FiPlay, FiChevronDown, FiSidebar } from 'react-icons/fi';
import Channel from '~/utils/channel';
import { LocalDataKey, RecorderStatus, EventName } from '~/types';
import type { AgentStatus, LocalData, OpenNote, Session } from '~/types';
import { DEFAULT_AGENT_CONFIG, type AgentConfig, type PlaybookSummary } from '~/agent/protocol';
import { describeError, fetchHealth, fetchPlaybooks } from '~/agent/backend';
import { describeBackend, type BackendView } from '~/agent/ui';

import { CircleButton } from '~/components/CircleButton';
import { Timer } from './Timer';
const RECORD_BUTTON_SIZE = 3;

const channel = new Channel();

/** The side panel is a Chrome feature; the Firefox build has no live agent UI. */
const hasSidePanel = () => typeof chrome !== 'undefined' && !!chrome.sidePanel;

export function App() {
  const [status, setStatus] = useState<RecorderStatus>(RecorderStatus.IDLE);
  const [errorMessage, setErrorMessage] = useState('');
  const [startTime, setStartTime] = useState(0);
  const [newSession, setNewSession] = useState<Session | null>(null);
  const [openNotes, setOpenNotes] = useState<OpenNote[]>([]);
  const [noteText, setNoteText] = useState('');
  const [captureMode, setCaptureMode] = useState<'cdp' | 'fallback' | undefined>(undefined);
  const [agentConfig, setAgentConfig] = useState<AgentConfig>(DEFAULT_AGENT_CONFIG);
  const [backend, setBackend] = useState<BackendView>({ kind: 'checking' });
  const [playbooks, setPlaybooks] = useState<PlaybookSummary[]>([]);
  const [agentStatus, setAgentStatus] = useState<AgentStatus | undefined>();
  // Looked up ahead of the click: chrome.sidePanel.open must be called
  // straight from the user's gesture, and windows.getCurrent is async.
  const [windowId, setWindowId] = useState<number | undefined>();

  useEffect(() => {
    const parseStatusData = (data: LocalData[LocalDataKey.recorderStatus]) => {
      const { status, startTimestamp, pausedTimestamp, captureMode } = data;
      setStatus(status);
      setCaptureMode(captureMode);
      if (startTimestamp && pausedTimestamp)
        setStartTime(Date.now() - pausedTimestamp + startTimestamp);
      else if (startTimestamp) setStartTime(startTimestamp);
    };
    void Browser.storage.local.get(LocalDataKey.recorderStatus).then((data) => {
      if (!data || !data[LocalDataKey.recorderStatus]) return;
      parseStatusData((data as LocalData)[LocalDataKey.recorderStatus]);
    });
    void Browser.storage.local.get(LocalDataKey.openNotes).then((data) => {
      setOpenNotes(((data as Partial<LocalData>)[LocalDataKey.openNotes]) ?? []);
    });
    void Browser.storage.local.onChanged.addListener((changes) => {
      if (changes[LocalDataKey.openNotes]) {
        setOpenNotes((changes[LocalDataKey.openNotes].newValue as OpenNote[] | undefined) ?? []);
      }
      if (!changes[LocalDataKey.recorderStatus]) return;
      const data = changes[LocalDataKey.recorderStatus]
        .newValue as LocalData[LocalDataKey.recorderStatus];
      parseStatusData(data);
      if (data.errorMessage) setErrorMessage(data.errorMessage);
    });
    channel.on(EventName.SessionUpdated, (data) => {
      setNewSession((data as { session: Session }).session);
    });
  }, []);

  useEffect(() => {
    if (!hasSidePanel()) return;
    void Browser.windows.getCurrent().then((w) => setWindowId(w.id));
    void Browser.storage.local.get([LocalDataKey.agentConfig, LocalDataKey.agentStatus]).then((all) => {
      const data = all as Partial<LocalData>;
      const cfg = { ...DEFAULT_AGENT_CONFIG, ...(data[LocalDataKey.agentConfig] ?? {}) };
      setAgentConfig(cfg);
      setAgentStatus(data[LocalDataKey.agentStatus]);
      Promise.all([fetchHealth(cfg), fetchPlaybooks(cfg)]).then(
        ([health, list]) => {
          setBackend(describeBackend(health));
          setPlaybooks(list);
          // Forget selections for playbooks that no longer exist.
          const known = new Set(list.map((p) => p.id));
          const kept = cfg.playbooks.filter((id) => known.has(id));
          if (kept.length !== cfg.playbooks.length) saveAgentConfig({ ...cfg, playbooks: kept });
        },
        (e: unknown) => setBackend({ kind: 'offline', reason: describeError(e) }),
      );
    });
    const onChange = (changes: Record<string, Browser.Storage.StorageChange>) => {
      if (changes[LocalDataKey.agentStatus]) setAgentStatus(changes[LocalDataKey.agentStatus].newValue as AgentStatus | undefined);
    };
    Browser.storage.local.onChanged.addListener(onChange);
    return () => Browser.storage.local.onChanged.removeListener(onChange);
  }, []);

  const saveAgentConfig = (next: AgentConfig) => {
    setAgentConfig(next);
    void Browser.storage.local.set({ [LocalDataKey.agentConfig]: next });
  };

  const openPanel = () => {
    if (hasSidePanel() && windowId !== undefined) void chrome.sidePanel.open({ windowId }).catch(() => undefined);
  };

  const addNote = () => {
    if (!noteText.trim()) return;
    void channel.emit(EventName.NoteAdded, { text: noteText });
    setNoteText('');
  };

  return (
    <Flex direction="column" w={300} padding="5%">
      <Flex>
        <Text fontSize="md" fontWeight="bold">
          RRWeb Recorder
        </Text>
        <Spacer />
        <Stack direction="row">
          <IconButton
            onClick={() => {
              void Browser.tabs.create({ url: '/pages/index.html#/' });
            }}
            size="xs"
            icon={<FiList />}
            aria-label={'Session List'}
            title="Session List"
          ></IconButton>
          <IconButton
            onClick={() => {
              void Browser.runtime.openOptionsPage();
            }}
            size="xs"
            icon={<FiSettings />}
            aria-label={'Settings button'}
            title="Settings"
          ></IconButton>
        </Stack>
      </Flex>
      {status !== RecorderStatus.IDLE && startTime && (
        <Timer
          startTime={startTime}
          ticking={status === RecorderStatus.RECORDING}
        />
      )}
      {status === RecorderStatus.RECORDING && captureMode && (
        <Text fontSize="xs" color={captureMode === 'cdp' ? 'green.600' : 'orange.600'} textAlign="center">
          {captureMode === 'cdp'
            ? 'Full capture (network + screenshots via debugger)'
            : 'Fallback capture (debugger unavailable - reduced network fidelity)'}
        </Text>
      )}
      <Flex justify="center" gap="10" mt="5" mb="5">
        {
          <CircleButton
            diameter={RECORD_BUTTON_SIZE}
            title={
              status === RecorderStatus.IDLE
                ? 'Start Recording'
                : 'Stop Recording'
            }
            onClick={() => {
              if (status === RecorderStatus.IDLE) {
                if (agentConfig.playbooks.length > 0) openPanel();
                void channel.emit(EventName.StartButtonClicked, {});
              } else void channel.emit(EventName.StopButtonClicked, {});
            }}
          >
            <Box
              w={`${RECORD_BUTTON_SIZE}rem`}
              h={`${RECORD_BUTTON_SIZE}rem`}
              borderRadius={status === RecorderStatus.IDLE ? 9999 : 6}
              margin="0"
              bgColor="red.500"
            />
          </CircleButton>
        }
        {status !== RecorderStatus.IDLE && (
          <CircleButton
            diameter={RECORD_BUTTON_SIZE}
            title={
              status === RecorderStatus.RECORDING
                ? 'Pause Recording'
                : 'Resume Recording'
            }
            onClick={() => {
              if (status === RecorderStatus.RECORDING) {
                void channel.emit(EventName.PauseButtonClicked, {});
              } else {
                void channel.emit(EventName.ResumeButtonClicked, {});
              }
            }}
          >
            <Box
              w={`${RECORD_BUTTON_SIZE}rem`}
              h={`${RECORD_BUTTON_SIZE}rem`}
              borderRadius={9999}
              margin="0"
              color="gray.600"
            >
              {[RecorderStatus.PAUSED, RecorderStatus.PausedSwitch].includes(
                status,
              ) && (
                <FiPlay
                  style={{
                    paddingLeft: '0.5rem',
                    width: '100%',
                    height: '100%',
                  }}
                />
              )}
              {status === RecorderStatus.RECORDING && (
                <FiPause
                  style={{
                    width: '100%',
                    height: '100%',
                  }}
                />
              )}
            </Box>
          </CircleButton>
        )}
      </Flex>
      {hasSidePanel() && (
        <AgentSection
          idle={status === RecorderStatus.IDLE}
          backend={backend}
          playbooks={playbooks}
          selected={agentConfig.playbooks}
          agentStatus={agentStatus}
          onSelect={(ids) => saveAgentConfig({ ...agentConfig, playbooks: ids })}
          onOpenPanel={openPanel}
        />
      )}
      {status !== RecorderStatus.IDLE && (
        <Box mb="4">
          <Flex gap="2">
            <Input
              size="sm"
              value={noteText}
              placeholder={openNotes.length ? 'Add a sub-note…' : 'What are you doing now?'}
              onChange={(e) => setNoteText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addNote();
              }}
            />
            <Button size="sm" onClick={addNote} isDisabled={!noteText.trim()}>
              Add
            </Button>
          </Flex>
          {openNotes.map((n) => (
            <Flex key={n.id} align="center" gap="2" mt="2" pl={`${n.depth * 0.75}rem`}>
              <Text fontSize="xs" flex="1" noOfLines={2} title={n.text}>
                {n.text}
              </Text>
              <Button
                size="xs"
                onClick={() => void channel.emit(EventName.NoteDone, { id: n.id })}
              >
                Done
              </Button>
            </Flex>
          ))}
        </Box>
      )}
      {newSession && (
        <Text>
          <Text as="b">New Session: </Text>
          <Link
            href={Browser.runtime.getURL(
              `pages/index.html#/session/${newSession.id}`,
            )}
            isExternal
          >
            {newSession.name}
          </Link>
        </Text>
      )}
      {errorMessage !== '' && (
        <Text color="red.500" fontSize="md">
          {errorMessage}
          <br />
          Maybe refresh your current tab.
        </Text>
      )}
    </Flex>
  );
}

function AgentSection(props: {
  idle: boolean;
  backend: BackendView;
  playbooks: PlaybookSummary[];
  selected: string[];
  agentStatus?: AgentStatus;
  onSelect: (ids: string[]) => void;
  onOpenPanel: () => void;
}) {
  const { idle, backend, playbooks, selected, agentStatus } = props;

  if (!idle) {
    if (!agentStatus) return null;
    const label =
      agentStatus.state === 'connected' ? 'Agent connected' : agentStatus.state === 'connecting' ? 'Agent connecting…' : agentStatus.state === 'finished' ? 'Agent finished' : 'Agent connection lost';
    return (
      <Flex align="center" gap="2" mb="3">
        <Badge colorScheme={agentStatus.state === 'connected' ? 'green' : agentStatus.state === 'lost' ? 'orange' : 'gray'}>{label}</Badge>
        <Spacer />
        <Button size="xs" leftIcon={<FiSidebar />} onClick={props.onOpenPanel}>
          Live panel
        </Button>
      </Flex>
    );
  }

  if (backend.kind === 'checking') return null;
  if (backend.kind === 'offline') {
    return (
      <Text fontSize="xs" color="gray.500" mb="3" title={backend.reason}>
        Live agent off: backend not running (<code>yarn agent:start</code>)
      </Text>
    );
  }
  return (
    <Box mb="3">
      <Flex align="center" gap="2">
        <Menu closeOnSelect={false}>
          <MenuButton as={Button} size="sm" rightIcon={<FiChevronDown />} flex="1" textAlign="left" aria-label="Live agent playbooks">
            Live agent: {selected.length === 0 ? 'off' : `${selected.length} playbook${selected.length === 1 ? '' : 's'}`}
          </MenuButton>
          <MenuList minW="260px">
            {playbooks.length === 0 ? (
              <Text px="3" py="2" fontSize="sm">
                No playbooks found in the backend's config folder.
              </Text>
            ) : (
              <MenuOptionGroup
                type="checkbox"
                value={selected}
                onChange={(v) => props.onSelect(Array.isArray(v) ? v : [v])}
                title="Run while recording"
              >
                {playbooks.map((p) => (
                  <MenuItemOption key={p.id} value={p.id}>
                    <Box>
                      <Text fontSize="sm">{p.title}</Text>
                      <Text fontSize="xs" color="gray.500">
                        {p.rules} rule{p.rules === 1 ? '' : 's'}
                        {p.steps ? ` · ${p.steps} guided steps` : ''}
                      </Text>
                    </Box>
                  </MenuItemOption>
                ))}
              </MenuOptionGroup>
            )}
          </MenuList>
        </Menu>
      </Flex>
      <Text fontSize="xs" color="gray.500" mt="1">
        {backend.model}
        {backend.hardware && (
          <Text as="span" color={`${backend.hardwareTone}.600`}>
            {' '}
            · {backend.hardware}
          </Text>
        )}
        {backend.unreadySources.length > 0 && (
          <Text as="span" color="orange.600">
            {' '}
            · cannot reach {backend.unreadySources.join(', ')}
          </Text>
        )}
      </Text>
    </Box>
  );
}
