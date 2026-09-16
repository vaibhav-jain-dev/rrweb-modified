import { useEffect, useState } from 'react';
import Browser from 'webextension-polyfill';
import {
  Box,
  Button,
  Checkbox,
  Code,
  Heading,
  HStack,
  IconButton,
  Input,
  Stack,
  Text,
} from '@chakra-ui/react';
import { FiTrash2 } from 'react-icons/fi';
import { nanoid } from 'nanoid';
import { SyncDataKey } from '~/types';
import type { NetworkExclusionRule, Settings, SyncData } from '~/types';
import { RECOMMENDED_NETWORK_EXCLUSIONS } from '~/evidence/network-exclusions';

/**
 * Lets the user see and adjust which network traffic gets tiered `noise`
 * (dropped from the "pure backend" view of a recording) at export time -
 * see evidence/classify.ts + evidence/network-exclusions.ts. Recommended
 * rules (Sentry, analytics, CORS preflight, ...) ship enabled; unchecking
 * one keeps that traffic visible in the next export. Custom patterns can
 * also be added, e.g. an internal telemetry host not on the default list.
 */
export default function NetworkExclusions() {
  const [rules, setRules] = useState<NetworkExclusionRule[]>(
    RECOMMENDED_NETWORK_EXCLUSIONS,
  );
  const [newLabel, setNewLabel] = useState('');
  const [newPattern, setNewPattern] = useState('');

  useEffect(() => {
    void Browser.storage.sync.get(SyncDataKey.settings).then((result) => {
      const settings = (result as SyncData | undefined)?.settings;
      if (settings?.networkExclusions?.length) {
        setRules(settings.networkExclusions);
      }
    });
  }, []);

  async function persist(next: NetworkExclusionRule[]) {
    setRules(next);
    const result = (await Browser.storage.sync.get(
      SyncDataKey.settings,
    )) as SyncData | undefined;
    const settings: Settings = { ...result?.settings, networkExclusions: next };
    await Browser.storage.sync.set({ [SyncDataKey.settings]: settings } as SyncData);
  }

  function toggle(id: string) {
    void persist(
      rules.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)),
    );
  }

  function remove(id: string) {
    void persist(rules.filter((r) => r.id !== id));
  }

  function addCustom() {
    if (!newPattern.trim()) return;
    const rule: NetworkExclusionRule = {
      id: nanoid(),
      label: newLabel.trim() || newPattern.trim(),
      pattern: newPattern.trim(),
      enabled: true,
      builtin: false,
    };
    void persist([...rules, rule]);
    setNewLabel('');
    setNewPattern('');
  }

  return (
    <Box maxW="640px">
      <Heading size="md" mb="2">
        Network exclusions
      </Heading>
      <Text color="gray.600" mb="4" fontSize="sm">
        Traffic matching an enabled rule is always tiered as noise in a
        recording&apos;s <Code>network/</Code> evidence - useful for keeping
        the exported package focused on your own backend API instead of
        telemetry, static assets, or CORS preflights. Uncheck a recommended
        rule to keep seeing that traffic; add your own pattern for anything
        not covered below. Patterns match the request host (or full URL) and
        support <Code>*</Code> as a wildcard, comma-separated for multiple
        globs in one rule; <Code>method:OPTIONS</Code> matches by HTTP method
        instead.
      </Text>

      <Stack spacing="2" mb="5">
        {rules.map((rule) => (
          <HStack key={rule.id} justify="space-between">
            <Checkbox
              isChecked={rule.enabled}
              onChange={() => toggle(rule.id)}
            >
              <Text fontWeight="medium" as="span">
                {rule.label}
              </Text>{' '}
              <Code fontSize="xs">{rule.pattern}</Code>
            </Checkbox>
            {!rule.builtin && (
              <IconButton
                aria-label={`Remove ${rule.label}`}
                icon={<FiTrash2 />}
                size="sm"
                variant="ghost"
                onClick={() => remove(rule.id)}
              />
            )}
          </HStack>
        ))}
      </Stack>

      <Heading size="sm" mb="2">
        Add custom pattern
      </Heading>
      <HStack>
        <Input
          placeholder="Label (optional)"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          size="sm"
        />
        <Input
          placeholder="Pattern, e.g. *.internal-telemetry.*"
          value={newPattern}
          onChange={(e) => setNewPattern(e.target.value)}
          size="sm"
        />
        <Button size="sm" onClick={addCustom} isDisabled={!newPattern.trim()}>
          Add
        </Button>
      </HStack>
    </Box>
  );
}
