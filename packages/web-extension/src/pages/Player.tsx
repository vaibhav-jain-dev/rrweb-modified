/// <reference types="chrome"/>
import { useRef, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import Replayer from 'rrweb-player';
import {
  Box,
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  Center,
} from '@chakra-ui/react';
import { getEvents, getSession } from '~/utils/storage';
import { agentMarkerTags, withAgentMarkers } from '~/agent/markers';

export default function Player() {
  const playerElRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<Replayer | null>(null);
  const { sessionId } = useParams();
  const [sessionName, setSessionName] = useState('');

  useEffect(() => {
    if (!sessionId) return;
    const session = getSession(sessionId).catch((err) => {
      console.error(err);
      return undefined;
    });
    void session.then((s) => s && setSessionName(s.name));
    Promise.all([getEvents(sessionId), session])
      .then(([events, s]) => {
        const markers = s?.agentMarkers ?? [];
        if (!playerElRef.current) return;
        if (playerRef.current) return;

        const manifest = chrome.runtime.getManifest();
        const rrwebPlayerVersion = manifest.version_name || manifest.version;
        const linkEl = document.createElement('link');
        linkEl.href = `https://cdn.jsdelivr.net/npm/rrweb-player@${rrwebPlayerVersion}/dist/style.min.css`;
        linkEl.rel = 'stylesheet';
        document.head.appendChild(linkEl);
        playerRef.current = new Replayer({
          target: playerElRef.current as HTMLElement,
          props: {
            events: withAgentMarkers(events, markers),
            tags: agentMarkerTags(markers),
            autoPlay: true,
          },
        });
      })
      .catch((err) => {
        console.error(err);
      });
    return () => {
      // eslint-disable-next-line
      playerRef.current?.pause();
      // eslint-disable-next-line
      playerRef.current?.$destroy();
    };
  }, [sessionId]);

  return (
    <>
      <Breadcrumb mb={5} fontSize="md">
        <BreadcrumbItem>
          <BreadcrumbLink href="#">Sessions</BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbItem>
          <BreadcrumbLink>{sessionName}</BreadcrumbLink>
        </BreadcrumbItem>
      </Breadcrumb>
      <Center>
        <Box ref={playerElRef}></Box>
      </Center>
    </>
  );
}
