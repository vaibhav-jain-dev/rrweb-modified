import { useEffect, useState } from 'react';
import Browser from 'webextension-polyfill';
import {
  Alert,
  AlertIcon,
  Box,
  Button,
  FormControl,
  FormHelperText,
  FormLabel,
  Heading,
  HStack,
  Input,
  Text,
} from '@chakra-ui/react';
import { LocalDataKey } from '~/types';
import type { LocalData } from '~/types';
import { DEFAULT_AGENT_CONFIG, type AgentConfig } from '~/agent/protocol';
import { describeError, fetchHealth } from '~/agent/backend';

/** Where the live-agent backend is. Playbooks themselves are picked in the popup. */
export default function AgentSettings() {
  const [config, setConfig] = useState<AgentConfig>(DEFAULT_AGENT_CONFIG);
  const [result, setResult] = useState<
    { ok: boolean; text: string } | undefined
  >();
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void Browser.storage.local.get(LocalDataKey.agentConfig).then((all) => {
      const stored = (all as Partial<LocalData>)[LocalDataKey.agentConfig];
      if (stored) setConfig({ ...DEFAULT_AGENT_CONFIG, ...stored });
    });
  }, []);

  const save = async () => {
    await Browser.storage.local.set({
      [LocalDataKey.agentConfig]: {
        ...config,
        token: config.token || undefined,
      },
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const test = async () => {
    setResult(undefined);
    try {
      const h = await fetchHealth(config);
      const down = Object.entries(h.sources).filter(([, s]) => !s.ready);
      setResult({
        ok: down.length === 0,
        text:
          `Connected. Model: ${h.model ?? 'none'}${
            h.gpu === true ? ' (GPU)' : h.gpu === false ? ' (CPU)' : ''
          }. ${h.playbooks} playbook${h.playbooks === 1 ? '' : 's'}.` +
          (down.length
            ? ` Cannot reach: ${down
                .map(([n, s]) => `${n} (${s.error ?? 'unknown'})`)
                .join('; ')}.`
            : ' All data sources reachable.'),
      });
    } catch (e) {
      setResult({ ok: false, text: describeError(e) });
    }
  };

  return (
    <Box mt="10" maxW="xl">
      <Heading size="md" mb="1">
        Live agent
      </Heading>
      <Text color="gray.600" mb="4" fontSize="sm">
        A local backend that checks each write against your database while you
        record. Start it with <code>yarn agent:start</code>, then pick playbooks
        in the popup.
      </Text>
      <FormControl mb="3">
        <FormLabel>Backend address</FormLabel>
        <Input
          value={config.backendUrl}
          onChange={(e) =>
            setConfig({ ...config, backendUrl: e.target.value.trim() })
          }
          placeholder="http://127.0.0.1:47821"
        />
        <FormHelperText>
          Keep it on this machine unless you also set a token.
        </FormHelperText>
      </FormControl>
      <FormControl mb="3">
        <FormLabel>Token (only if the backend sets AGENT_TOKEN)</FormLabel>
        <Input
          type="password"
          autoComplete="off"
          value={config.token ?? ''}
          onChange={(e) => setConfig({ ...config, token: e.target.value })}
        />
      </FormControl>
      <HStack>
        <Button onClick={() => void save()} colorScheme="blue">
          {saved ? 'Saved' : 'Save'}
        </Button>
        <Button onClick={() => void test()} variant="outline">
          Test connection
        </Button>
      </HStack>
      {result && (
        <Alert
          status={result.ok ? 'success' : 'warning'}
          mt="3"
          borderRadius="md"
          fontSize="sm"
        >
          <AlertIcon />
          {result.text}
        </Alert>
      )}
    </Box>
  );
}
