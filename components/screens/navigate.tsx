'use client';

import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { Map as MbMap } from 'mapbox-gl';
import { MapView } from '@/components/map/map-view';
import { ReportPins, type Pin } from '@/components/map/report-pins';
import { RouteLine } from '@/components/map/route-line';
import { getVoice } from '@/lib/voice';
import type { Coord, RouteResponse } from '@/app/page';

const POLL_MS = 7_000;
const REROUTE_MIN_MS = 30_000;
const REROUTE_THRESHOLD = 0.6;

export function NavigateScreen({
  origin,
  destination,
  mode,
  routes,
  activeRouteId,
  promptCountRef,
  ownReportIdsRef,
  onArrive,
  onCancel,
  onPromptOpen,
  onActiveRouteChange,
}: {
  origin: Coord;
  destination: Coord;
  mode: 'walking' | 'cycling';
  routes: RouteResponse[];
  activeRouteId: string;
  promptCountRef: MutableRefObject<number>;
  ownReportIdsRef: MutableRefObject<Set<string>>;
  onArrive: () => void;
  onCancel: () => void;
  onPromptOpen: (report: NearReport) => void;
  onActiveRouteChange: (rs: RouteResponse[], activeId: string) => void;
}) {
  const [map, setMap] = useState<MbMap | null>(null);
  const [pos, setPos] = useState<Coord | null>(origin);
  const [pins, setPins] = useState<Pin[]>([]);
  const lastRerouteAt = useRef(0);
  const promptedIds = useRef<Set<string>>(new Set());
  const lastPromptAt = useRef(0);
  // Timestamp when we first entered the 30m arrival radius; 0 means not in radius.
  // Spec §7.5: only fire onArrive after 5 consecutive seconds inside.
  const arrivalDwellSince = useRef(0);

  useEffect(() => {
    promptCountRef.current = 0;
    lastPromptAt.current = 0;
    promptedIds.current.clear();
    arrivalDwellSince.current = 0;
  }, [activeRouteId, promptCountRef]);

  useEffect(() => {
    if (!('geolocation' in navigator)) return;
    // Spec §7: ignore positions whose accuracy >50m or whose delta from
    // the last accepted reading implies >100 m/s (GPS jitter / teleports).
    let lastAccepted: { lat: number; lng: number; t: number } | null = null;
    const id = navigator.geolocation.watchPosition(
      (g) => {
        if (g.coords.accuracy > 50) return;
        const next = { lat: g.coords.latitude, lng: g.coords.longitude };
        const now = Date.now();
        if (lastAccepted) {
          const dist = haversine(lastAccepted, next);
          const dt = (now - lastAccepted.t) / 1000;
          if (dt > 0 && dist / dt > 100) return;
        }
        lastAccepted = { ...next, t: now };
        setPos(next);
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 10_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  useEffect(() => {
    if (!pos) return;
    const tick = async () => {
      const dToDest = haversine(pos, destination);
      if (dToDest < 30) {
        if (arrivalDwellSince.current === 0) {
          arrivalDwellSince.current = Date.now();
        } else if (Date.now() - arrivalDwellSince.current >= 5_000) {
          onArrive();
          return;
        }
      } else {
        arrivalDwellSince.current = 0;
      }

      const sinceLastPrompt = Date.now() - lastPromptAt.current;
      if (promptCountRef.current < 2 && sinceLastPrompt > 60_000) {
        const nearbyResp = await fetch(
          `/api/reports/near?lat=${pos.lat}&lng=${pos.lng}&radius=50`,
        )
          .then((r) => r.json())
          .catch(() => ({ reports: [] }));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const eligible = (nearbyResp.reports ?? []).filter(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (r: any) =>
            !promptedIds.current.has(r.id) && !ownReportIdsRef.current.has(r.id),
        );
        if (eligible.length > 0) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const r = eligible.sort(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (a: any, b: any) =>
              severityWeight(b.severity, b.type) - severityWeight(a.severity, a.type),
          )[0];
          // Mark as prompted so we don't re-fire on the same report next tick.
          // The cap counter is only bumped if the user actually answers
          // (PromptOverlay -> onCounted in app/page.tsx).
          promptedIds.current.add(r.id);
          lastPromptAt.current = Date.now();
          onPromptOpen(r);
        }
      }

      if (Date.now() - lastRerouteAt.current > REROUTE_MIN_MS) {
        lastRerouteAt.current = Date.now();
        const reroute = await fetch('/api/route', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ origin: pos, destination, mode }),
        })
          .then((r) => r.json())
          .catch(() => ({ routes: [] }));
        const newRoutes: RouteResponse[] = reroute.routes ?? [];
        if (newRoutes.length === 0) return;
        const safest = newRoutes[0];
        const current = routes.find((rr) => rr.id === activeRouteId);
        if (
          current &&
          safest.id !== activeRouteId &&
          safest.safety_score < current.safety_score * REROUTE_THRESHOLD
        ) {
          const v = await getVoice();
          await v.speak(`Safer route found. ${safest.reasons[0] ?? ''}. Switching.`);
          onActiveRouteChange(newRoutes, safest.id);
        }
      }
    };
    // Spec §7: pause poll when tab is hidden (iOS Safari kills setInterval
    // anyway, but doing it explicitly prevents stale fetches on resume).
    let intervalId: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (intervalId !== null) return;
      intervalId = setInterval(tick, POLL_MS);
      tick();
    };
    const stop = () => {
      if (intervalId === null) return;
      clearInterval(intervalId);
      intervalId = null;
    };
    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };
    document.addEventListener('visibilitychange', onVisibility);
    if (!document.hidden) start();
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [
    pos,
    destination,
    mode,
    routes,
    activeRouteId,
    promptCountRef,
    ownReportIdsRef,
    onArrive,
    onPromptOpen,
    onActiveRouteChange,
  ]);

  useEffect(() => {
    if (!pos) return;
    fetch(`/api/reports/near?lat=${pos.lat}&lng=${pos.lng}&radius=2000`)
      .then((r) => r.json())
      .then((data) => {
        setPins(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (data.reports ?? []).map((r: any) => ({
            id: r.id,
            lat: Number(r.lat),
            lng: Number(r.lng),
            severity: r.severity,
            type: r.type,
          })),
        );
      })
      .catch(() => {
        /* DB not ready */
      });
  }, [pos]);

  const drawn = routes.map((r, i) => ({
    id: r.id,
    polyline: r.polyline,
    rank: i,
    active: r.id === activeRouteId,
  }));
  const active = routes.find((r) => r.id === activeRouteId);

  return (
    <div className="absolute inset-0">
      <MapView className="absolute inset-0" onReady={setMap} />
      <ReportPins map={map} pins={pins} />
      <RouteLine map={map} routes={drawn} />

      <div
        className="absolute top-3 left-3 right-3 bg-white/95 rounded-2xl px-4 py-3
                      shadow-md flex items-center justify-between backdrop-blur"
      >
        <div>
          <div className="display text-base text-[var(--ink)]">
            {active?.duration_min ?? '—'} min
          </div>
          <div className="text-xs text-[var(--ink-3)]">
            safety score {active?.safety_score.toFixed(2) ?? '—'}
          </div>
        </div>
        <button onClick={onCancel} className="text-[var(--sev-acute)] text-sm">
          End trip
        </button>
      </div>
    </div>
  );
}

export type NearReport = {
  id: string;
  type: 'acute' | 'environmental';
  severity: 'low' | 'medium' | 'high';
  summary: string;
  lat: number;
  lng: number;
  reported_at: string;
};

function severityWeight(severity: string, type: string): number {
  const s = severity === 'high' ? 10 : severity === 'medium' ? 3 : 1;
  const t = type === 'acute' ? 4 : 1;
  return s * t;
}

function haversine(a: Coord, b: Coord): number {
  const R = 6_371_000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const x =
    Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
