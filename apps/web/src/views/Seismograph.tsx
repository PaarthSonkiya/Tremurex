/* The seismograph motif. Two pieces, both pure inline SVG (no external assets,
 * per the §7 privacy invariant):
 *   - BrandMark: an epicenter — a point with rings radiating out, the shape of
 *     a tremor being detected.
 *   - TraceLine: a calm scrolling seismograph trace with a live recording head.
 * One waveform segment is 120 units wide; three copies tiled end-to-end scroll
 * left by exactly one segment, so the loop is seamless. */

/** One 120-wide segment: a near-flat baseline with small ticks and one spike. */
const SEGMENT =
  'M0 15 H10 L13 11 L16 15 H26 L29 18 L32 15 H44 L48 6 L52 23 L55 15 ' +
  'H66 L70 13 L73 17 L76 15 H88 L92 12 L95 15 H106 L110 14 L113 16 L116 15 H120';

export function TraceLine() {
  return (
    <div className="trace-line" aria-hidden="true">
      <svg viewBox="0 0 240 30" preserveAspectRatio="none">
        <g className="scan">
          {[0, 120, 240].map((x) => (
            <path
              key={x}
              d={SEGMENT}
              transform={`translate(${String(x)} 0)`}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.25}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </g>
      </svg>
      <span className="head" />
    </div>
  );
}

export function BrandMark() {
  return (
    <svg className="mark" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <circle cx="16" cy="16" r="2.6" fill="var(--ink)" />
      <circle cx="16" cy="16" r="7" stroke="var(--ink)" strokeOpacity="0.55" strokeWidth="1.4" />
      <circle cx="16" cy="16" r="12" stroke="var(--ink)" strokeOpacity="0.22" strokeWidth="1.4" />
    </svg>
  );
}
