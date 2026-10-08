import { useState, useEffect } from 'react';
import Browser from 'webextension-polyfill';
import {
  Box,
  Button,
  Flex,
  IconButton,
  Input,
  Link,
  Spacer,
  Stack,
  Text,
} from '@chakra-ui/react';
import { FiSettings, FiList, FiPause, FiPlay } from 'react-icons/fi';
import Channel from '~/utils/channel';
import { LocalDataKey, RecorderStatus, EventName } from '~/types';
import type { LocalData, OpenNote, Session } from '~/types';

import { CircleButton } from '~/components/CircleButton';
import { Timer } from './Timer';
const RECORD_BUTTON_SIZE = 3;

const channel = new Channel();

export function App() {
  const [status, setStatus] = useState<RecorderStatus>(RecorderStatus.IDLE);
  const [errorMessage, setErrorMessage] = useState('');
  const [startTime, setStartTime] = useState(0);
  const [newSession, setNewSession] = useState<Session | null>(null);
  const [openNotes, setOpenNotes] = useState<OpenNote[]>([]);
  const [noteText, setNoteText] = useState('');
  const [captureMode, setCaptureMode] = useState<'cdp' | 'fallback' | undefined>(undefined);

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
              if (status === RecorderStatus.IDLE)
                void channel.emit(EventName.StartButtonClicked, {});
              else void channel.emit(EventName.StopButtonClicked, {});
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
