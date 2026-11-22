import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { GrowthIcon } from './growth';
import { useStore } from './ui';

/** A first-run tour on Today: four steps that point at the real screen, instead of explanations that stay on every page. */
const KEY = 'garten-tour-v1';
const done = () => {
  try {
    return localStorage.getItem(KEY) === 'done';
  } catch {
    return true;
  }
};
const STEPS: { at: string[]; title: string; text?: string; stages?: boolean }[] = [
  {
    at: ['#headline'],
    title: 'What needs you',
    text: 'Questions from agents, specs ready to bloom and proposals wait in one stack, one card at a time. Answer, or put a card back with Later.',
  },
  { at: ['.beds'], title: 'Everything grows', stages: true },
  {
    at: ['.agentline'],
    title: 'Your agents',
    text: 'This line shows who is working and what happened last. It opens Agents with the activity and the history.',
  },
  {
    at: ['.toptabs', '.tabbar'],
    title: 'What agents know',
    text: 'Documents start with vision and strategy. The glossary and the guardrails are full definitions, one page each.',
  },
  {
    at: ['.findbox', '.ws-btn'],
    title: 'Find anything',
    text: 'Ctrl K finds specs, words and rules, and starts new ones. N plants a new spec.',
  },
];

const target = (sels: string[]) =>
  sels
    .map((s) => document.querySelector(s) as HTMLElement | null)
    .find((e) => !!e && e.getBoundingClientRect().width > 0 && getComputedStyle(e).display !== 'none') ?? null;

export function Tour() {
  const S = useStore();
  const { pathname } = useLocation();
  const nav = useNavigate();
  const [i, setI] = useState<number | null>(null);
  const [box, setBox] = useState<DOMRect | null>(null);
  const signedIn = !!S.state.me && !!S.team();
  const coach = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const start = () => {
      nav('/');
      setTimeout(() => setI(0), 250);
    };
    window.addEventListener('garten:tour', start);
    return () => window.removeEventListener('garten:tour', start);
  }, [nav]);
  // once, on Today, for people (automated browsers run the tests without it)
  useEffect(() => {
    if (signedIn && pathname === '/' && !done() && !navigator.webdriver) {
      const t = setTimeout(() => setI(0), 900);
      return () => clearTimeout(t);
    }
  }, [signedIn, pathname]);

  const place = useCallback(() => {
    if (i === null) return;
    const el = target(STEPS[i].at);
    if (!el) return setBox(null);
    const r = el.getBoundingClientRect();
    if (r.top < 60 || r.bottom > innerHeight - 40) el.scrollIntoView({ block: 'center' });
    setBox(el.getBoundingClientRect());
  }, [i]);
  useLayoutEffect(() => {
    place();
    if (i === null) return;
    const t = setTimeout(place, 350);
    addEventListener('resize', place);
    document.addEventListener('scroll', place, true);
    return () => {
      clearTimeout(t);
      removeEventListener('resize', place);
      document.removeEventListener('scroll', place, true);
    };
  }, [i, place]);

  const end = useCallback(() => {
    try {
      localStorage.setItem(KEY, 'done');
    } catch {
      /* private mode: the tour comes back next time */
    }
    setI(null);
  }, []);
  useEffect(() => {
    if (i === null) return;
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') end();
      if (e.key === 'ArrowRight' && i < STEPS.length - 1) setI(i + 1);
      if (e.key === 'ArrowLeft' && i > 0) setI(i - 1);
    };
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [i, end]);

  if (i === null || !signedIn) return null;
  const st = STEPS[i],
    last = i === STEPS.length - 1;
  const pad = 8;
  const ch = coach.current?.offsetHeight ?? 240;
  const coachTop = box
    ? box.bottom + pad + 12 + ch < innerHeight - 8
      ? box.bottom + pad + 12
      : Math.max(16, box.top - pad - 12 - ch)
    : 120;
  const coachLeft = box ? Math.min(Math.max(16, box.left), innerWidth - Math.min(340, innerWidth - 32) - 16) : 16;
  return (
    <div className="tour" role="dialog" aria-modal="true" aria-label="Tour">
      <div className="tour-block" onClick={end} />
      {box && (
        <div
          className="tour-spot"
          style={{ left: box.left - pad, top: box.top - pad, width: box.width + pad * 2, height: box.height + pad * 2 }}
        />
      )}
      <div className="tour-coach" ref={coach} style={{ top: coachTop, left: coachLeft }}>
        <div className="tour-body" key={i}>
          <span className="caption">
            {i + 1} of {STEPS.length}
          </span>
          <h2>{st.title}</h2>
          {st.text && <p>{st.text}</p>}
          {st.stages && (
            <div className="tour-stages">
              <div>
                <GrowthIcon stage="seed" size={20} />
                <span>
                  <b>Seed</b> · a draft only you see
                </span>
              </div>
              <div>
                <GrowthIcon stage="sprout" size={20} />
                <span>
                  <b>Sprout</b> · waiting for approval
                </span>
              </div>
              <div>
                <GrowthIcon stage="bloom" size={20} />
                <span>
                  <b>Bloom</b> · agents can read it
                </span>
              </div>
            </div>
          )}
        </div>
        <div className="tour-foot">
          <span className="dots" aria-hidden="true">
            {STEPS.map((_, k) => (
              <i key={k} className={k === i ? 'on' : ''} />
            ))}
          </span>
          {!last && (
            <button type="button" className="btn subtle" onClick={end}>
              Skip
            </button>
          )}
          <button type="button" className="btn primary" autoFocus onClick={() => (last ? end() : setI(i + 1))}>
            {last ? 'Start' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  );
}
