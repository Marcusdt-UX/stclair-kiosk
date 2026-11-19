#!/usr/bin/env node
/**
 * build-fleet-db.mjs
 * ------------------
 * Turns the raw Boatnerd scrape (scripts/boatnerd-raw.json) into a clean,
 * compact fleet database the kiosk can use to recognise ANY Great Lakes
 * vessel by name — not just the hand-curated ones in ships-db.json.
 *
 *   node scripts/build-fleet-db.mjs
 *
 * Output: src/data/fleet-db.json  (keyed by Boatnerd slug)
 *
 * Boatnerd doesn't publish MMSI numbers, so the kiosk matches on the ship
 * name AIS broadcasts (current name first, then former names). The proxy
 * remembers each MMSI → slug match in vessel-cache.json once it has seen
 * the ship, so the lookup only has to happen once per vessel.
 *
 * Photos: public/ships/<slug>.jpg + public/ships/manifest.json are produced by
 * the photo fetch (Boatnerd media search, run in a browser — see
 * scripts/fetch-ship-photos.js). When a local photo exists the entry points at
 * it and carries the photographer credit; otherwise the old (mostly dead)
 * Boatnerd URL is dropped.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RAW = resolve(__dirname, 'boatnerd-raw.json')
const OUT = resolve(__dirname, '..', 'src', 'data', 'fleet-db.json')
const PHOTO_DIR = resolve(__dirname, '..', 'public', 'ships')

// Fleets we skip: not vessels, or gone from the Lakes
const SKIP_FLEETS = new Set(['Scrapped, Sold Off Lakes or Other Use'])

// Tidy Boatnerd's fleet labels
const FLEET_NAMES = {
  'Vessels - McKeil Marine Ltd': 'McKeil Marine',
  'Tugs & Barges - McKeil Marine Ltd.': 'McKeil Marine',
  'Algoma Cetral Corporation. (Tankers)': 'Algoma Central Corporation',
  'Lower Lakes Transportation Co. Vessels Owned by Grand River Navigation Co.': 'Grand River Navigation (Rand Logistics)',
  'Great Lakes Fleet Inc': 'Great Lakes Fleet (Key Lakes)',
  'Inc.': undefined,
}

/** Normalise a ship name for matching: AIS sends e.g. "RT HON PAUL J MARTIN" */
export function normalise(name = '') {
  return name
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')  // strip accents
    .replace(/[čć]/gi, 'e')                              // Boatnerd mojibake (Carričre → Carriere)
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')                          // "(2)", "(barge)", "(tug)"
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// "Karen Andrie (2)" → "Karen Andrie"; keep descriptive tags like "(barge)"
function displayName(name) {
  return name.replace(/\s*\(\d+\)\s*$/, '').trim()
}

function vesselKind(name) {
  const m = name.match(/\((barge|tug|ferry|articulated tug|storage barge)[^)]*\)/i)
  return m ? m[1].toLowerCase() : undefined
}

function yearBuilt(text = '') {
  // "constructed in 1987", "built in 1952", "launched in 1979" — first hit only
  const m = text.match(/\b(?:built|constructed|launched|completed)\b[^.]{0,60}?\b(18[5-9]\d|19\d\d|20[0-2]\d)\b/i)
  return m ? Number(m[1]) : undefined
}

const raw = JSON.parse(readFileSync(RAW, 'utf8'))
let manifest = {}
try { manifest = JSON.parse(readFileSync(resolve(PHOTO_DIR, 'manifest.json'), 'utf8')) } catch {}
const fleet = {}
let skipped = 0
let localPhotos = 0

for (const [slug, v] of Object.entries(raw)) {
  if (!v.fleet || SKIP_FLEETS.has(v.fleet) || slug.includes('-page-')) { skipped++; continue }

  const name = displayName(v.name || slug)
  const formerNames = (v.previousNames ?? [])
    .map(p => displayName(p.name))
    .filter(n => n && normalise(n) !== normalise(name))

  const localFile = resolve(PHOTO_DIR, `${slug}.jpg`)
  const hasLocal = existsSync(localFile)
  if (hasLocal) localPhotos++

  const fleetName = slug in FLEET_NAMES ? FLEET_NAMES[slug] : (v.fleet in FLEET_NAMES ? FLEET_NAMES[v.fleet] : v.fleet)

  fleet[slug] = {
    name,
    kind: vesselKind(v.name || ''),
    operator: fleetName,
    formerNames: formerNames.length ? formerNames : undefined,
    yearBuilt: yearBuilt(v.descriptionFull || v.summary),
    lengthDetail: v.length,
    beamDetail: v.beam,
    capacity: v.capacity,
    enginePower: v.enginePower,
    note: v.summary,
    // Old scrape URLs died in Boatnerd's site rebuild — only use local copies
    photo: hasLocal ? `/ships/${slug}.jpg` : undefined,
    photoCaption: hasLocal ? manifest[slug]?.caption : undefined,
    photoCredit: hasLocal
      ? (manifest[slug]?.credit ? `${manifest[slug].credit} / Boatnerd.com` : 'Boatnerd.com')
      : undefined,
  }
  for (const k of Object.keys(fleet[slug])) if (fleet[slug][k] === undefined) delete fleet[slug][k]
}

writeFileSync(OUT, JSON.stringify(fleet, null, 2) + '\n', 'utf8')

// Report name collisions (two slugs normalising to the same name)
const seen = new Map()
for (const [slug, f] of Object.entries(fleet)) {
  const k = normalise(f.name)
  if (seen.has(k)) console.warn(`  ⚠ same name: ${seen.get(k)} / ${slug} (${f.name})`)
  else seen.set(k, slug)
}

console.log(`✅ ${Object.keys(fleet).length} vessels → src/data/fleet-db.json (${skipped} skipped, ${localPhotos} with local photos)`)
