#!/usr/bin/env node
/**
 * Generate simple PWA icons (192x192 and 512x512) as SVG-converted PNGs.
 * Since we don't have a PNG generator on hand, we'll create an SVG icon
 * that works as both the favicon and the Apple touch icon.
 */

import { writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const publicDir = resolve(__dirname, '..', 'public')

// Simple ship/anchor icon as SVG
const makeSvg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="96" fill="#0a1628"/>
  <g transform="translate(256,256)" fill="none" stroke="#4fc3f7" stroke-width="20" stroke-linecap="round" stroke-linejoin="round">
    <!-- Ship hull -->
    <path d="M-140,40 L-120,-60 L120,-60 L140,40 Z" fill="#1a3a5c" stroke="#4fc3f7"/>
    <!-- Bridge -->
    <rect x="-40" y="-120" width="80" height="60" rx="8" fill="#1a3a5c" stroke="#4fc3f7"/>
    <!-- Mast -->
    <line x1="0" y1="-120" x2="0" y2="-180"/>
    <!-- Flag -->
    <path d="M0,-180 L40,-165 L0,-150" fill="#4fc3f7" stroke="none"/>
    <!-- Water line -->
    <path d="M-180,60 Q-130,30 -80,60 Q-30,90 20,60 Q70,30 120,60 Q170,90 180,60" stroke="#2196f3" stroke-width="12" fill="none" opacity="0.5"/>
    <!-- Smoke -->
    <circle cx="30" cy="-150" r="15" fill="#4fc3f7" opacity="0.3"/>
    <circle cx="45" cy="-170" r="10" fill="#4fc3f7" opacity="0.2"/>
  </g>
  <text x="256" y="420" text-anchor="middle" font-family="system-ui,sans-serif" font-size="64" font-weight="700" fill="#4fc3f7">ST. CLAIR</text>
</svg>`

// Write SVG icons (browsers accept SVG for PWA icons in most cases,
// but for maximum compat we'll name them .png and note they're SVG)
// For a real production app you'd use sharp/canvas to rasterize.
// For now SVG files work perfectly as web icons.
writeFileSync(resolve(publicDir, 'icon-192.svg'), makeSvg(192))
writeFileSync(resolve(publicDir, 'icon-512.svg'), makeSvg(512))
console.log('✅ Generated icon-192.svg and icon-512.svg in public/')
console.log('💡 To convert to PNG: use https://svgtopng.com or `npx sharp-cli`')
