// Original ~3.5 s startup jingle, synthesised with the Web Audio API (no audio files, no
// licensing). Rising arpeggio → little melody → "honk honk" → final chord.

const N = {
  C4: 261.63,
  G4: 392.0,
  'G#4': 415.3,
  E4: 329.63,
  C5: 523.25,
  D5: 587.33,
  E5: 659.25,
  F5: 698.46,
  G5: 783.99,
  A5: 880.0,
};

const BEAT = 0.15; // one eighth note, seconds

// [note(s), start beat, length in beats, wave, level]
const SCORE = [
  [['G4'], 0, 1, 'triangle', 0.32],
  [['C5'], 1, 1, 'triangle', 0.32],
  [['E5'], 2, 1, 'triangle', 0.32],
  [['G5'], 3, 1, 'triangle', 0.34],
  [['A5'], 4, 2, 'triangle', 0.36],
  [['G5'], 6, 1, 'triangle', 0.32],
  [['E5'], 7, 1, 'triangle', 0.32],
  [['F5'], 8, 1, 'triangle', 0.3],
  [['E5'], 9, 1, 'triangle', 0.3],
  [['D5'], 10, 1, 'triangle', 0.3],
  // honk honk (soft square-wave two-tone horn)
  [['E4', 'G#4'], 12, 0.7, 'square', 0.07],
  [['E4', 'G#4'], 13.2, 0.9, 'square', 0.07],
  // final chord
  [['C5', 'E5', 'G5'], 15, 6, 'triangle', 0.22],
  [['C4'], 15, 6, 'sine', 0.3],
];

/**
 * Plays the jingle at `volume` (0..1). Returns { stop } or null if audio is unavailable.
 * Never throws: startup must not depend on sound.
 */
export function playJingle(volume = 0.6) {
  try {
    const ctx = new window.AudioContext();
    ctx.resume().catch(() => {});
    const master = ctx.createGain();
    master.gain.value = Math.max(0, Math.min(1, volume)) * 0.6;
    master.connect(ctx.destination);
    const t0 = ctx.currentTime + 0.05;

    for (const [notes, start, length, type, level] of SCORE) {
      for (const name of notes) {
        const at = t0 + start * BEAT;
        const end = at + length * BEAT;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = type;
        osc.frequency.value = N[name];
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(level, at + 0.015);
        gain.gain.exponentialRampToValueAtTime(
          level * 0.6,
          at + Math.min(0.12, length * BEAT * 0.5),
        );
        gain.gain.exponentialRampToValueAtTime(0.0001, end);
        osc.connect(gain).connect(master);
        osc.start(at);
        osc.stop(end + 0.05);
      }
    }

    const total = (21 * BEAT + 0.3) * 1000;
    const closer = setTimeout(() => ctx.close().catch(() => {}), total);

    return {
      stop() {
        clearTimeout(closer);
        try {
          master.gain.setTargetAtTime(0, ctx.currentTime, 0.04);
          setTimeout(() => ctx.close().catch(() => {}), 250);
        } catch {
          // already closed
        }
      },
    };
  } catch {
    return null;
  }
}

/** Plays a custom sound file (app-data:// URL). Returns { stop } or null. */
export function playFile(url, volume = 0.6) {
  try {
    const audio = new Audio(url);
    audio.volume = Math.max(0, Math.min(1, volume));
    audio.play().catch(() => {});
    return {
      stop() {
        // Short fade so it never cuts off harshly.
        const step = audio.volume / 6;
        const timer = setInterval(() => {
          audio.volume = Math.max(0, audio.volume - step);
          if (audio.volume <= 0.01) {
            clearInterval(timer);
            audio.pause();
          }
        }, 60);
      },
    };
  } catch {
    return null;
  }
}
