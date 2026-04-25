'use client';

import { useEffect, useRef, useState } from 'react';
import { getVoice } from '@/lib/voice';
import { PushToTalkButton } from '@/components/ui/push-to-talk-button';

type State = 'idle' | 'recording' | 'submitting' | 'done' | 'error';

export function ReportScreen({
  onDone,
  onReported,
}: {
  onDone: () => void;
  /** Called with the new report's id once the server accepts it. */
  onReported?: (id: string) => void;
}) {
  const [state, setState] = useState<State>('idle');
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);
  const posRef = useRef<{ lat: number; lng: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const v = await getVoice();
      if (!cancelled) await v.speak('Tell me what\'s happening.');
    })();
    return () => { cancelled = true; };
  }, []);

  const onStart = async () => {
    setError(null);
    setTranscript('');
    setState('recording');
    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        (g) => { posRef.current = { lat: g.coords.latitude, lng: g.coords.longitude }; },
        () => { setError('need_location'); setState('error'); },
        { enableHighAccuracy: true, timeout: 5000 },
      );
    } else {
      setError('need_location');
      setState('error');
      return;
    }
    const v = await getVoice();
    const text = await v.listen({ timeoutMs: 12_000 });
    setTranscript(text);
  };

  const onRelease = async () => {
    if (state !== 'recording') return;
    if (!transcript.trim()) {
      setError('didnt_catch'); setState('error');
      const v = await getVoice();
      await v.speak("Didn't catch that — try again.");
      return;
    }
    if (!posRef.current) {
      setError('need_location'); setState('error'); return;
    }
    setState('submitting');
    const r = await fetch('/api/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transcript,
        lat: posRef.current.lat,
        lng: posRef.current.lng,
      }),
    });
    if (!r.ok) {
      setError('submit_failed'); setState('error');
      const v = await getVoice();
      await v.speak('Could not submit. Try again.');
      return;
    }
    try {
      const data = await r.json();
      if (data?.id && typeof data.id === 'string') onReported?.(data.id);
    } catch {
      /* response not JSON; non-fatal — own-report skip just won't apply for this one */
    }
    setState('done');
    const v = await getVoice();
    await v.speak('Reported. Stay safe.');
    setTimeout(onDone, 1200);
  };

  const onCancel = async () => {
    setState('idle');
    setTranscript('');
    const v = await getVoice();
    v.speak('Cancelled.');
  };

  return (
    <div className="absolute inset-0 bg-[var(--paper)] flex flex-col">
      <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
        <div className={`mb-8 w-24 h-24 rounded-full flex items-center justify-center
          ${state === 'recording' ? 'bg-[var(--accent)] animate-pulse' : 'bg-[var(--primary-3)]'}`}>
          <span className="text-4xl">🎤</span>
        </div>
        <h1 className="display text-2xl text-[var(--ink)] mb-3">
          {state === 'idle' && 'Tell me what\'s happening'}
          {state === 'recording' && 'Listening…'}
          {state === 'submitting' && 'Sending…'}
          {state === 'done' && 'Reported'}
          {state === 'error' && 'Try again'}
        </h1>
        {transcript && (
          <p className="text-[var(--ink-3)] text-base max-w-md">&ldquo;{transcript}&rdquo;</p>
        )}
        {error === 'need_location' && (
          <p className="text-[var(--sev-acute)] mt-4">Need location to report.</p>
        )}
      </div>

      <div className="p-4 pb-8 space-y-3">
        <PushToTalkButton
          onStart={onStart} onRelease={onRelease} onCancel={onCancel}
          disabled={state === 'submitting' || state === 'done'}
        >
          <div className="flex items-center gap-3">
            <span className="text-xl">●</span>
            <div className="display">
              {state === 'recording' ? 'Release to send' : 'Hold to speak — anonymous'}
            </div>
          </div>
        </PushToTalkButton>
        <button
          onClick={onDone}
          className="w-full rounded-2xl px-5 py-3 text-[var(--ink-3)] bg-transparent">
          Cancel
        </button>
      </div>
    </div>
  );
}
