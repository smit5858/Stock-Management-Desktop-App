// Original illustration of a rounded 1960s–70s style Indian sedan (no real badges or logos).
// Animation is pure CSS (classes in index.css), so it keeps running smoothly while React works.

const HILL_STEP = 80; // must equal the scroll-x keyframe distance for a seamless loop

function Hills() {
  const humps = Array.from({ length: 8 }, (_, i) => {
    const x = i * HILL_STEP;
    return `M${x} 150 Q${x + 40} ${i % 2 ? 112 : 124} ${x + 80} 150 Z`;
  });
  return (
    <g className="loader-hills" opacity="0.5">
      {humps.map((d) => (
        <path key={d} d={d} fill="var(--surface-3)" />
      ))}
    </g>
  );
}

function Wheel({ cx }) {
  return (
    <g className="loader-wheel">
      <circle cx={cx} cy="160" r="22" fill="#111827" />
      <circle cx={cx} cy="160" r="15" fill="none" stroke="#f8fafc" strokeWidth="5" />
      <circle cx={cx} cy="160" r="10" fill="url(#chrome)" />
      {[0, 45, 90, 135].map((a) => (
        <line
          key={a}
          x1={cx - 9}
          y1="160"
          x2={cx + 9}
          y2="160"
          stroke="#64748b"
          strokeWidth="1.6"
          transform={`rotate(${a} ${cx} 160)`}
        />
      ))}
      <circle cx={cx} cy="160" r="3" fill="#475569" />
    </g>
  );
}

export default function VintageCar() {
  return (
    <svg
      viewBox="0 0 420 220"
      className="w-[min(560px,80vw)]"
      role="img"
      aria-label="Classic car driving"
    >
      <defs>
        <linearGradient id="chrome" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f8fafc" />
          <stop offset="0.5" stopColor="#cbd5e1" />
          <stop offset="1" stopColor="#94a3b8" />
        </linearGradient>
        <linearGradient id="paint" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#be123c" />
          <stop offset="1" stopColor="#881337" />
        </linearGradient>
        <linearGradient id="glass" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#e0f2fe" />
          <stop offset="1" stopColor="#7dd3fc" />
        </linearGradient>
        <clipPath id="scene">
          <rect width="420" height="220" rx="16" />
        </clipPath>
      </defs>

      <g clipPath="url(#scene)">
        <Hills />

        {/* road with scrolling centre line */}
        <rect y="176" width="420" height="44" fill="#1f2937" />
        <g className="loader-road">
          {Array.from({ length: 7 }, (_, i) => (
            <rect
              key={i}
              x={i * 80}
              y="196"
              width="40"
              height="4"
              rx="2"
              fill="#facc15"
              opacity="0.8"
            />
          ))}
        </g>

        {/* headlight beam */}
        <polygon points="364,124 420,108 420,152 364,134" fill="#fde68a" opacity="0.22" />

        {/* exhaust puffs */}
        <g>
          {[0, 1, 2].map((i) => (
            <circle key={i} className="loader-puff" cx="52" cy="152" r="6" fill="#cbd5e1" />
          ))}
        </g>

        <ellipse cx="214" cy="180" rx="152" ry="5" fill="#000" opacity="0.25" />

        <g className="loader-body">
          {/* body */}
          <path
            d="M64 158 L64 140 Q64 128 78 126 L122 122 Q142 92 178 88 L262 88 Q300 90 320 120 L350 124 Q364 127 364 142 L364 158 Z"
            fill="url(#paint)"
          />
          {/* cream roof */}
          <path
            d="M150 99 Q162 90 180 89 L260 89 Q284 90 298 102 Z"
            fill="#fef3c7"
            opacity="0.95"
          />
          {/* windows */}
          <path d="M138 120 Q152 100 179 98 L214 98 L214 120 Z" fill="url(#glass)" />
          <path d="M222 98 L258 98 Q286 100 302 120 L222 120 Z" fill="url(#glass)" />
          {/* chrome trim */}
          <line x1="68" y1="131" x2="360" y2="131" stroke="url(#chrome)" strokeWidth="3" />
          <line
            x1="76"
            y1="151"
            x2="354"
            y2="151"
            stroke="#e2e8f0"
            strokeWidth="1.5"
            opacity="0.7"
          />
          {/* doors and handles */}
          <line x1="218" y1="121" x2="218" y2="152" stroke="#4c0519" strokeWidth="1.2" />
          <line x1="164" y1="122" x2="164" y2="152" stroke="#4c0519" strokeWidth="1.2" />
          <rect x="196" y="136" width="12" height="3" rx="1.5" fill="url(#chrome)" />
          <rect x="232" y="136" width="12" height="3" rx="1.5" fill="url(#chrome)" />
          {/* grille, lights */}
          <rect x="352" y="134" width="10" height="14" rx="2" fill="url(#chrome)" />
          <circle cx="357" cy="127" r="7" fill="#fef9c3" stroke="url(#chrome)" strokeWidth="2.5" />
          <rect x="63" y="127" width="6" height="9" rx="2" fill="#ef4444" />
          {/* bumpers */}
          <rect x="354" y="148" width="18" height="8" rx="4" fill="url(#chrome)" />
          <rect x="50" y="148" width="18" height="8" rx="4" fill="url(#chrome)" />
          {/* wheel arches */}
          <path d="M90 158 A28 28 0 0 1 146 158 Z" fill="#0f172a" />
          <path d="M280 158 A28 28 0 0 1 336 158 Z" fill="#0f172a" />
        </g>

        <Wheel cx={118} />
        <Wheel cx={308} />
      </g>
    </svg>
  );
}
