import React from 'react';
import { graphLitDiskPath } from './graphBodyGeometry';

interface Props {
  kind: 'sun' | 'earth';
  id: string;
  x: number;
  y: number;
  radius?: number;
  phase: { cosine: number; angle: number; fraction: number } | null;
}

/** Hand-drawn symbolic artwork; no Earth attitude or geographic measurement implied. */
export default function GraphBodyIcon({ kind, id, x, y, radius = 12, phase }: Props) {
  const title = kind === 'sun' ? 'Güneş · simgesel disk' : `Dünya · simgesel kıtalar${phase ? ` · geometrik aydınlık oranı %${Math.round(phase.fraction * 100)}` : ' · evre verisi yok'}`;
  return <g transform={`translate(${x} ${y})`} role="img" aria-label={title}>
    <title>{title}</title>
    <defs>
      <radialGradient id={`${id}-surface`} cx="34%" cy="28%" r="78%"><stop stopColor={kind === 'sun' ? '#fff7cf' : '#7de1ee'} /><stop offset=".52" stopColor={kind === 'sun' ? '#ffd36a' : '#338ab7'} /><stop offset="1" stopColor={kind === 'sun' ? '#e68a33' : '#173a65'} /></radialGradient>
      <clipPath id={`${id}-disk`}><circle r={radius} /></clipPath>
      <clipPath id={`${id}-light`}><path d={graphLitDiskPath(phase?.cosine ?? 1)} transform={`rotate(${phase?.angle ?? 0}) scale(${radius})`} /></clipPath>
    </defs>
    {kind === 'sun' ? <>
      <circle r={radius * 1.4} fill="#f5c75e" opacity=".08" />
      {Array.from({ length: 12 }, (_, i) => <path key={i} d={`M0 ${-radius * 1.25}v${-radius * .26}`} transform={`rotate(${i * 30})`} stroke="#e6b85c" strokeWidth="1.1" strokeLinecap="round" />)}
      <circle r={radius} fill={`url(#${id}-surface)`} />
      <path d={`M${-radius * .5} ${-radius * .35}q${radius * .45} ${-radius * .3} ${radius * .9} 0`} fill="none" stroke="#fff6d8" strokeWidth="1.1" opacity=".7" />
    </> : <>
      <circle r={radius + 1.3} fill="#79d5ed" opacity=".25" />
      <circle r={radius} fill="#142637" />
      <g clipPath={`url(#${id}-light)`}>
        <circle r={radius} fill={`url(#${id}-surface)`} />
        <g clipPath={`url(#${id}-disk)`} transform={`scale(${radius / 12})`}>
          <path d="M-11-6-7-10-3-8-4-4-1-1-3 2-6 1-7-2-10-2ZM-3 2 1 4 0 8-3 11-4 6ZM4-9 10-6 12-2 8 0 6-2 3-1 1-4ZM4 1 8 2 7 7 4 6 2 3Z" fill="#9cceab" />
          <path d="M-12-4Q-5-8 1-5T13-3M-8 5Q-2 2 4 5T12 6" fill="none" stroke="#e9f6f6" strokeWidth="1.5" opacity=".7" />
        </g>
      </g>
      <circle r={radius} fill="none" stroke="#a6e5ee" strokeWidth=".6" opacity=".65" />
    </>}
  </g>;
}
