// What a break-room moment is ABOUT — derived entirely from live agent status.
//
// This file replaces cafeteriaLines.ts, which also carried ~200 hand-written
// quips and exchanges: a solo one-liner per break spot, character-keyed bits,
// and multi-beat pair exchanges. Those are gone.
//
// WHY THEY ARE GONE. Everything else the floor shows corresponds to something
// real — an avatar sits because its agent is working, a bubble says "using
// Bash" because it is, two agents share a table because their relationship
// state leans that way. The canned dialogue corresponded to nothing: it was
// scripted banter fired on a timer, written in English beside a UI translated
// into the user's language, and it was the only fabricated thing on the floor.
// With `officeChatterEnabled` off — or on, but with no model-written exchange
// ready — the break room is now SILENT. Agents still walk there, sit together,
// carry and wash mugs, and show their real status; they simply do not speak
// unless there is something real to say. See src/main/officeChat.ts.
//
// What survives here is the part that was never invented: a classification of
// the pair's LIVE status, which steers the dialogue director's prompt (and,
// when a chat ends, which relationship event gets recorded).

/** Where an agent is lingering. Still meaningful without line pools: it decides
 *  the animation and the spot the avatar walks to, and it is passed to the
 *  dialogue director as scene context. */
export type BreakSpot = 'coffee' | 'vending' | 'snack' | 'table';

/** What a pair's café moment is about, derived from both agents' live status.
 *  Only blocked/looping status warrants a check-in. `success` can mean a
 *  completed agent turn without a closed ledger task, so it remains generic.
 *  Celebrations require task_done evidence at the floor's completion boundary;
 *  this status classifier never supplies that evidence. */
export type CafeMood = 'breaker-checkin' | 'celebration' | 'generic';

export function cafeMoodFor(speakerStatus?: string, partnerStatus?: string): CafeMood {
  if (
    speakerStatus === 'looping' || partnerStatus === 'looping' ||
    speakerStatus === 'blocked' || partnerStatus === 'blocked'
  ) return 'breaker-checkin';
  return 'generic';
}

/** How long one spoken beat stays on screen, in seconds.
 *
 *  The café used to hold every line for a flat 2.4s, which is a large part of
 *  why exchanges felt mechanical: a three-word jab and a full sentence got
 *  identical airtime, and every conversation ticked like a metronome. Pace it
 *  by reading time instead, with a little jitter so two exchanges never beat in
 *  lockstep. `roll` is the caller's random source (0..1), passed in so this
 *  stays a pure function the floor can be tested against. */
export function beatSeconds(line: string, roll: number): number {
  const chars = typeof line === 'string' ? line.length : 0;
  const read = 0.9 + chars * 0.045;                    // ≈ 13 characters/second
  const jitter = 0.85 + (Number.isFinite(roll) ? Math.min(1, Math.max(0, roll)) : 0.5) * 0.4;
  return Math.min(4.2, Math.max(1.3, read * jitter));
}
