'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { HomeScreen } from '@/components/screens/home';
import { ReportScreen } from '@/components/screens/report';
import { RouteScreen } from '@/components/screens/route';
import { NavigateScreen, type NearReport } from '@/components/screens/navigate';
import { PromptOverlay } from '@/components/screens/prompt';
import { ArriveScreen } from '@/components/screens/arrive';

type Screen = 'home' | 'report' | 'route' | 'navigate' | 'arrive';

export type Coord = { lat: number; lng: number };

export type RouteResponse = {
  id: string;
  polyline: string;
  duration_min: number;
  distance_m: number;
  safety_score: number;
  incidents_avoided: number;
  reasons: string[];
};

export type AppState = {
  screen: Screen;
  origin: Coord | null;
  destination: Coord | null;
  routes: RouteResponse[];
  activeRouteId: string | null;
  mode: 'walking' | 'cycling';
  activePrompt: NearReport | null;
};

export default function Page() {
  const [state, setState] = useState<AppState>({
    screen: 'home',
    origin: null,
    destination: null,
    routes: [],
    activeRouteId: null,
    mode: 'walking',
    activePrompt: null,
  });

  // Counts only when the user actually answers a prompt (yes/no), not on skip.
  // Lifted here so PromptOverlay's onCounted can increment the cap that
  // NavigateScreen reads from inside its poll-loop.
  const promptCountRef = useRef(0);

  // Report IDs filed from this device this session — never re-prompt them.
  // Spec §7: "Skip own reports entirely."
  const ownReportIdsRef = useRef<Set<string>>(new Set());

  const [pos, setPos] = useState<Coord | null>(null);
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) return;
    navigator.geolocation.getCurrentPosition(
      (g) => setPos({ lat: g.coords.latitude, lng: g.coords.longitude }),
      () => {},
      { enableHighAccuracy: true, timeout: 5000 },
    );
  }, []);

  const goto = useCallback((screen: Screen) => {
    setState((s) => ({ ...s, screen }));
  }, []);

  const setRoutes = useCallback((routes: RouteResponse[]) => {
    setState((s) => ({ ...s, routes, activeRouteId: routes[0]?.id ?? null }));
  }, []);

  return (
    <main className="fixed inset-0 overflow-hidden bg-[var(--paper)]">
      {state.screen === 'home' && (
        <HomeScreen
          initialPosition={pos}
          onSearch={(dest) =>
            setState((s) => ({
              ...s,
              origin: pos ?? { lat: 52.3676, lng: 4.9041 },
              destination: dest,
              screen: 'route',
            }))
          }
          onReport={() => goto('report')}
        />
      )}
      {state.screen === 'report' && (
        <ReportScreen
          onDone={() => goto('home')}
          onReported={(id) => ownReportIdsRef.current.add(id)}
        />
      )}
      {state.screen === 'route' && state.origin && state.destination && (
        <RouteScreen
          origin={state.origin}
          destination={state.destination}
          mode={state.mode}
          routes={state.routes}
          setRoutes={setRoutes}
          onStart={(activeRouteId) => setState((s) => ({ ...s, activeRouteId, screen: 'navigate' }))}
          onCancel={() => goto('home')}
        />
      )}
      {state.screen === 'navigate' && state.origin && state.destination && state.activeRouteId && (
        <>
          <NavigateScreen
            origin={state.origin}
            destination={state.destination}
            mode={state.mode}
            routes={state.routes}
            activeRouteId={state.activeRouteId}
            promptCountRef={promptCountRef}
            ownReportIdsRef={ownReportIdsRef}
            onArrive={() => goto('arrive')}
            onCancel={() => goto('home')}
            onPromptOpen={(r) => setState((s) => ({ ...s, activePrompt: r }))}
            onActiveRouteChange={(rs, id) =>
              setState((s) => ({ ...s, routes: rs, activeRouteId: id }))
            }
          />
          {state.activePrompt && state.origin && (
            <PromptOverlay
              report={state.activePrompt}
              position={state.origin}
              onClose={() => setState((s) => ({ ...s, activePrompt: null }))}
              onCounted={() => {
                promptCountRef.current += 1;
              }}
            />
          )}
        </>
      )}
      {state.screen === 'arrive' && state.activeRouteId && (() => {
        const active = state.routes.find((r) => r.id === state.activeRouteId);
        if (!active) return null;
        return <ArriveScreen activeRoute={active} mode={state.mode} onDone={() => goto('home')} />;
      })()}
    </main>
  );
}
