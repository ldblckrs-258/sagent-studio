/**
 * A short two-note chime for a newly pending approval. Synthesized with the
 * Web Audio API so there is no binary asset to ship, and deduped per approval id
 * so a re-render, a thread switch, or a remount never replays the same request.
 *
 * Browsers start an AudioContext suspended until a user gesture. The context is
 * unlocked lazily on the first pointer/key input, which is always the case here
 * because an approval only appears after the user has sent a turn.
 */

type AudioContextCtor = typeof AudioContext;

let context: AudioContext | null = null;
let unlockInstalled = false;
const playedIds = new Set<string>();
const MAX_REMEMBERED = 200;

function resolveCtor(): AudioContextCtor | null {
  if (typeof window === "undefined") return null;
  const globalWindow = window as typeof window & {
    webkitAudioContext?: AudioContextCtor;
  };
  return globalWindow.AudioContext ?? globalWindow.webkitAudioContext ?? null;
}

function getContext(): AudioContext | null {
  const Ctor = resolveCtor();
  if (!Ctor) return null;
  if (!context) context = new Ctor();
  return context;
}

function unlock(): void {
  const ctx = context;
  if (ctx && ctx.state === "suspended") void ctx.resume();
}

/** Install one-time gesture listeners that resume a suspended context. */
export function installApprovalSoundUnlock(): void {
  if (unlockInstalled || typeof window === "undefined") return;
  unlockInstalled = true;
  getContext();
  const handler = () => {
    unlock();
    window.removeEventListener("pointerdown", handler);
    window.removeEventListener("keydown", handler);
  };
  window.addEventListener("pointerdown", handler);
  window.addEventListener("keydown", handler);
}

function playNote(ctx: AudioContext, frequency: number, start: number, peak: number): void {
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.32);
  oscillator.connect(gain);
  gain.connect(ctx.destination);
  oscillator.start(start);
  oscillator.stop(start + 0.34);
}

/** Play the chime for `approvalId` once. Safe to call on every render. */
export function playApprovalChime(approvalId: string): void {
  if (!approvalId || playedIds.has(approvalId)) return;
  if (playedIds.size >= MAX_REMEMBERED) playedIds.clear();
  playedIds.add(approvalId);

  const ctx = getContext();
  if (!ctx) return;
  unlock();
  const now = ctx.currentTime + 0.02;
  playNote(ctx, 783.99, now, 0.09);
  playNote(ctx, 1046.5, now + 0.13, 0.08);
}
