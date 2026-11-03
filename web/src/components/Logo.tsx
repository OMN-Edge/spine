import { vertebraPath } from './vertebra';

/** The mark's four vertebral bodies, top to bottom, in its 32-unit box: each 5.8 high and wider than the one above. */
export const MARK_PATHS = [[9.5, 1.4, 13], [8.67, 9.2, 14.66], [7.83, 17, 16.34], [7, 24.8, 18]]
  .map(([x, y, w]) => vertebraPath(x, y, w, 5.8));

/**
 * The mark: four vertebral bodies seen from the front, waisted at the middle and widening
 * slightly downward, with an intervertebral disc between each pair. It draws in
 * `currentColor` (the discs at reduced opacity), so a parent sets its colour with a text-*
 * class. `public/favicon.svg` is the same geometry in a fixed colour, because a favicon has
 * no parent to inherit from; `Logo.test.ts` fails if the two differ.
 */
export function LogoMark({ className = 'h-6 w-6' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true" focusable="false">
      <g fill="currentColor">
        {MARK_PATHS.map(d => <path key={d} d={d} />)}
      </g>
      <g fill="currentColor" opacity={0.4}>
        <rect x={9.45} y={7.6} width={13.1} height={1.2} rx={0.60} />
        <rect x={8.7} y={15.4} width={14.6} height={1.2} rx={0.60} />
        <rect x={7.95} y={23.2} width={16.1} height={1.2} rx={0.60} />
      </g>
    </svg>
  );
}

/** The mark and the name, for the navigation bar. */
export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <LogoMark className="h-7 w-7 text-brand-600" />
      <span className="font-semibold text-gray-900 text-lg tracking-tight">Spine</span>
    </span>
  );
}
