import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Volume2, VolumeX } from 'lucide-react';
import VintageCar from './VintageCar';
import { playFile, playJingle } from './jingle';
import { usePrefs } from '../Prefs';
import { useBranding, APP_NAME } from '../Branding';
import { appApi } from '../../api/app';

const MIN_MS = 1500;

const STAGES = {
  opening: 'Opening database…',
  checking: 'Checking data…',
  backup: 'Creating backup…',
  migrating: 'Preparing data…',
  ready: 'Ready',
};

/**
 * Startup-only loader. Stays until the DB is ready (`ready`) and at least MIN_MS has passed.
 * Click / any key skips the minimum time (never the DB work). Sound is best-effort only.
 */
export default function Loader({ ready, onDone }) {
  const { prefs } = usePrefs();
  const branding = useBranding();
  const [stage, setStage] = useState('opening');
  const [minElapsed, setMinElapsed] = useState(false);
  const [skipped, setSkipped] = useState(false);
  const [muted, setMuted] = useState(!prefs.startupSound);
  const sound = useRef(null);
  const started = useRef(false);

  // Stage text from the main process.
  useEffect(() => {
    appApi
      .startupProgress()
      .then(setStage)
      .catch(() => {});
    return window.api.onStartupProgress(setStage);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setMinElapsed(true), MIN_MS);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (ready && (minElapsed || skipped)) onDone();
  }, [ready, minElapsed, skipped, onDone]);

  // Click or any key skips the waiting time.
  useEffect(() => {
    const skip = () => setSkipped(true);
    window.addEventListener('keydown', skip);
    return () => window.removeEventListener('keydown', skip);
  }, []);

  // Sound: once branding (custom sound file?) is known.
  useEffect(() => {
    if (!branding.loaded || started.current || !prefs.startupSound) return;
    started.current = true;
    sound.current = branding.soundUrl
      ? playFile(branding.soundUrl, prefs.soundVolume)
      : playJingle(prefs.soundVolume);
  }, [branding.loaded, branding.soundUrl, prefs.startupSound, prefs.soundVolume]);

  // A custom file may be longer than the loader; fade it out when the loader goes.
  useEffect(() => () => branding.soundUrl && sound.current?.stop(), [branding.soundUrl]);

  function toggleMute(e) {
    e.stopPropagation();
    if (!muted) sound.current?.stop();
    setMuted(true);
  }

  const shownStage = ready ? 'ready' : stage;

  return (
    <motion.div
      className="fixed inset-0 z-100 flex cursor-pointer flex-col items-center justify-center overflow-hidden bg-bg"
      style={{
        backgroundImage:
          'radial-gradient(ellipse at 50% 35%, var(--primary-soft), transparent 65%)',
      }}
      initial={{ opacity: 1 }}
      exit={{ opacity: 0, scale: 1.02, transition: { duration: 0.35, ease: 'easeOut' } }}
      onClick={() => setSkipped(true)}
    >
      <motion.div
        className="mb-6 flex items-center gap-3"
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.25, duration: 0.5 }}
      >
        <img
          src={branding.logoUrl}
          alt=""
          className="h-14 w-14 rounded-2xl object-contain shadow-lg"
        />
        <span className="text-3xl font-extrabold tracking-tight">{APP_NAME}</span>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, x: -60 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.6, ease: 'easeOut' }}
      >
        <VintageCar />
      </motion.div>

      <motion.p
        key={shownStage}
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        className="mt-6 h-5 text-sm font-medium text-muted"
      >
        {STAGES[shownStage] || STAGES.opening}
      </motion.p>
      <p className="mt-2 text-xs text-muted/70">Click or press any key to skip</p>

      {prefs.startupSound && (
        <button
          type="button"
          onClick={toggleMute}
          title={muted ? 'Sound off' : 'Mute'}
          className="absolute right-6 bottom-6 flex h-10 w-10 items-center justify-center rounded-full border border-border bg-surface text-muted shadow-sm hover:text-fg"
        >
          {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
        </button>
      )}
    </motion.div>
  );
}
