import { awaitsApproval } from './lib';
import type { Item } from './store/types';

/** Every spec, term, rule and document grows: a private draft (seed), waiting for approval (sprout), live for agents (bloom). */
export type Stage = 'seed' | 'sprout' | 'bloom';
export const STAGE_NAME: Record<Stage, string> = { seed: 'Seed', sprout: 'Sprout', bloom: 'Bloom' };
export const STAGE_TIP: Record<Stage, string> = {
  seed: 'Draft, only you see it',
  sprout: 'Waiting for approval',
  bloom: 'Agents can read it',
};

/** The stage of an item: released and unchanged is in bloom; a titled draft or unreleased edits wait for approval. */
export function stageOf(S: { hasUnreleased: (i: Item) => boolean }, i: Item): Stage {
  if (i.status === 'approved' && !S.hasUnreleased(i)) return 'bloom';
  if (i.approve || awaitsApproval(S, i)) return 'sprout';
  return 'seed';
}

/** The growth icon: seed always; stem and leaves from sprout; the flower at bloom. A class change grows it in place. */
export function GrowthIcon({ stage, size = 18, title }: { stage: Stage; size?: number; title?: string }) {
  return (
    <svg
      className={`g ${stage}`}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <ellipse cx="10" cy="16.2" rx="3" ry="1.6" fill="currentColor" fillOpacity=".25" />
      <path className="stem" d="M10 15.5V5" />
      <path className="lf" d="M10 11.5c-.2-2.4-1.8-3.8-4.5-3.8.1 2.5 1.8 3.8 4.5 3.8z" fill="currentColor" fillOpacity=".25" />
      <path className="lf" d="M10 9.8c.2-2.2 1.7-3.4 4.2-3.4-.1 2.3-1.7 3.4-4.2 3.4z" fill="currentColor" fillOpacity=".25" />
      <circle className="fl" cx="10" cy="4" r="2.2" fill="currentColor" />
    </svg>
  );
}
