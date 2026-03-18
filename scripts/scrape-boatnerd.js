#!/usr/bin/env node
/**
 * scrape-boatnerd.js
 * ------------------
 * Scrapes boatnerd.com/gallery for vessel photos, ship particulars,
 * and fleet info, then merges the data into ships-db.json by matching
 * vessel names (case-insensitive, ignoring trailing numbers like "(2)").
 *
 * Usage:
 *   node scripts/scrape-boatnerd.js          # scrape + merge
 *   node scripts/scrape-boatnerd.js --dry    # preview without writing
 *
 * Output:
 *   - scripts/boatnerd-raw.json   (full scraped data, keyed by slug)
 *   - src/data/ships-db.json      (updated in-place unless --dry)
 */

import * as cheerio from 'cheerio'
import { readFileSync, writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DRY_RUN = process.argv.includes('--dry')
const GALLERY_URL = 'https://www.boatnerd.com/gallery/'
const DELAY_MS = 600 // polite delay between requests
const MAX_CONCURRENT = 3

// ── Helpers ──────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function fetchPage(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'StClairKiosk/1.0 (vessel-research; non-commercial museum kiosk)',
          'Accept': 'text/html',
        },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.text()
    } catch (err) {
      if (i === retries) throw err
      console.warn(`  ⚠ retry ${i + 1} for ${url}: ${err.message}`)
      await sleep(1000 * (i + 1))
    }
  }
}

// Normalise vessel names for fuzzy matching
function normalise(name) {
  return name
    .toLowerCase()
    .replace(/\s*\(\d+\)\s*$/, '')   // strip trailing "(2)" etc
    .replace(/[^a-z0-9 ]/g, '')      // strip punctuation
    .replace(/\s+/g, ' ')
    .trim()
}

// ── Step 1: Scrape gallery index ─────────────────────────────────────

async function scrapeGalleryIndex() {
  console.log('📋 Fetching gallery index…')
  const html = await fetchPage(GALLERY_URL)
  const $ = cheerio.load(html)

  const vessels = [] // { name, url, fleet }
  let currentFleet = ''

  // The gallery page has h4 fleet headers and vessel links under each
  // We'll walk through all links that point to boatnerd.com/<slug>/
  $('h4, h2').each((_, el) => {
    const $el = $(el)
    // fleet headers are h4 with links, or just text
    if (el.tagName === 'h4') {
      const fleetLink = $el.find('a')
      if (fleetLink.length) {
        currentFleet = fleetLink.text().trim()
      }
    }
  })

  // Actually, the structure is: h4 for fleet name, then a list of vessel
  // links (each wrapped in an h2 or as direct links)
  // Let's just grab all unique vessel links from the page
  const seen = new Set()
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || ''
    const text = $(el).text().trim()
    // Must be a boatnerd.com vessel page (not category, tag, etc.)
    if (
      href.startsWith('https://boatnerd.com/') &&
      !href.includes('/category/') &&
      !href.includes('/tag/') &&
      !href.includes('/author/') &&
      !href.includes('/gallery/') &&
      !href.includes('#') &&
      !href.includes('wp-content') &&
      !href.includes('boatnerd-news') &&
      !href.includes('port-report') &&
      !href.includes('boatnerd-soo-gathering') &&
      text.length > 1 &&
      text.length < 60 &&
      text !== 'HOME' &&
      text !== 'Home' &&
      text !== 'READ MORE' &&
      text !== 'NO COMMENTS' &&
      text !== 'PREV POST' &&
      text !== 'NEXT POST' &&
      text !== 'Boatnerd' &&
      !text.startsWith('Boatnerd News') &&
      !text.startsWith('Port Report')
    ) {
      const slug = href.replace('https://boatnerd.com/', '').replace(/\/$/, '')
      if (slug && !seen.has(slug) && !slug.includes('/')) {
        seen.add(slug)
        vessels.push({ name: text, url: href, slug })
      }
    }
  })

  console.log(`  Found ${vessels.length} vessel pages`)
  return vessels
}

// ── Step 2: Scrape individual vessel pages ───────────────────────────

function parseVesselPage(html, slug) {
  const $ = cheerio.load(html)
  const data = { slug }

  // Featured image (WordPress thumbnail in the header area)
  // Look for og:image meta, or the first large image
  const ogImage = $('meta[property="og:image"]').attr('content')
  if (ogImage && ogImage.includes('wp-content/uploads')) {
    data.photo = ogImage
  }

  // Also grab the first gallery-quality photo
  if (!data.photo) {
    $('img').each((_, el) => {
      const src = $(el).attr('src') || ''
      if (src.includes('wp-content/uploads') && !src.includes('150x') && !src.includes('75x')) {
        if (!data.photo) data.photo = src
      }
    })
  }

  // Ship Particulars table
  $('table').each((_, table) => {
    const $table = $(table)
    const header = $table.find('th, td').first().text().trim()
    if (header.toLowerCase().includes('ship particulars') || 
        $table.text().toLowerCase().includes('length') && $table.text().toLowerCase().includes('beam')) {
      $table.find('tr').each((_, row) => {
        const cells = $(row).find('td')
        if (cells.length >= 2) {
          const key = $(cells[0]).text().trim().toLowerCase()
          const val = $(cells[1]).text().trim()
          if (key === 'length') data.length = val
          if (key === 'beam') data.beam = val
          if (key === 'depth') data.depth = val
          if (key.includes('draft')) data.draft = val
          if (key.includes('capacity')) data.capacity = val
          if (key.includes('engine') || key.includes('power')) data.enginePower = val
          if (key.includes('boom') || key.includes('unloading')) data.boomLength = val
        }
      })

      // Previous names
      const prevNames = []
      let inPrevNames = false
      $table.find('tr').each((_, row) => {
        const cells = $(row).find('td')
        const text = $(row).text().trim().toLowerCase()
        if (text.includes('previous name')) {
          inPrevNames = true
          return
        }
        if (inPrevNames && cells.length >= 2) {
          const name = $(cells[0]).text().trim()
          const years = $(cells[1]).text().trim()
          if (name && !name.toLowerCase().includes('previous')) {
            prevNames.push({ name, years })
          }
        }
      })
      if (prevNames.length) data.previousNames = prevNames
    }
  })

  // First paragraph of description text (for notes)
  const paragraphs = []
  // Get text from the article body
  const articleBody = $('article, .entry-content, .post-content, .td-post-content')
  const textSource = articleBody.length ? articleBody : $('body')
  
  textSource.find('p').each((_, p) => {
    const text = $(p).text().trim()
    if (text.length > 80 && !text.includes('©') && !text.includes('THEMESPHERE')) {
      paragraphs.push(text)
    }
  })
  if (paragraphs.length) {
    // Take first paragraph as the summary (trim to ~200 chars for a note)
    data.descriptionFull = paragraphs.join('\n\n')
    const first = paragraphs[0]
    data.summary = first.length > 250 ? first.slice(0, 247) + '…' : first
  }

  // Fleet tag
  const tags = []
  $('a[href*="/tag/"]').each((_, el) => {
    tags.push($(el).text().trim())
  })
  if (tags.length) data.fleet = tags[0]

  // All photo URLs from the page
  const photos = []
  $('a[href*="wp-content/uploads"]').each((_, el) => {
    const href = $(el).attr('href')
    if (href && !photos.includes(href)) photos.push(href)
  })
  if (photos.length) data.photos = photos

  return data
}

// Process vessels one at a time (reliable for large sets)
async function scrapeVesselPages(vessels) {
  const rawPath = resolve(__dirname, 'boatnerd-raw.json')

  // Resume from existing partial data if available
  let results = {}
  try {
    results = JSON.parse(readFileSync(rawPath, 'utf8'))
    console.log(`  ♻ Resuming — ${Object.keys(results).length} already cached`)
  } catch { /* fresh start */ }

  let processed = 0
  let skipped = 0

  for (const v of vessels) {
    // Skip already-scraped slugs
    if (results[v.slug]) { skipped++; processed++; continue }

    try {
      const html = await fetchPage(v.url)
      const data = parseVesselPage(html, v.slug)
      data.name = v.name
      results[v.slug] = data
    } catch (err) {
      console.warn(`  ✗ Failed: ${v.name} — ${err.message}`)
    }

    processed++
    if (processed % 25 === 0 || processed === vessels.length) {
      // Save progress incrementally
      writeFileSync(rawPath, JSON.stringify(results, null, 2) + '\n', 'utf8')
      console.log(`  📦 ${processed}/${vessels.length} (${skipped} cached)`)
    }
    await sleep(DELAY_MS)
  }

  // Final save
  writeFileSync(rawPath, JSON.stringify(results, null, 2) + '\n', 'utf8')
  return results
}

// ── Step 3: Merge into ships-db.json ─────────────────────────────────

function mergeIntoShipsDb(scraped) {
  const dbPath = resolve(__dirname, '..', 'src', 'data', 'ships-db.json')
  const db = JSON.parse(readFileSync(dbPath, 'utf8'))

  // Build a lookup from normalised name → scraped data
  const byName = new Map()
  for (const [slug, data] of Object.entries(scraped)) {
    const norm = normalise(data.name || slug.replace(/-/g, ' '))
    byName.set(norm, data)
    // Also add previous names
    if (data.previousNames) {
      for (const pn of data.previousNames) {
        byName.set(normalise(pn.name), data)
      }
    }
  }

  let updated = 0
  let photoUpdated = 0

  for (const [mmsi, entry] of Object.entries(db)) {
    if (mmsi.startsWith('___')) continue
    const norm = normalise(entry.name || '')
    const match = byName.get(norm)
    if (!match) continue

    updated++

    // Upgrade photo if currently using MarineTraffic fallback
    if (match.photo && (
      !entry.photo ||
      entry.photo.includes('marinetraffic.com')
    )) {
      entry.photo = match.photo
      photoUpdated++
    }

    // Add boatnerd page link
    entry.boatnerd = `https://boatnerd.com/${match.slug}/`

    // Add ship particulars if we don't already have them
    if (match.length && !entry.lengthDetail) entry.lengthDetail = match.length
    if (match.beam && !entry.beamDetail) entry.beamDetail = match.beam
    if (match.capacity && !entry.capacity) entry.capacity = match.capacity
    if (match.enginePower && !entry.enginePower) entry.enginePower = match.enginePower

    // Add previous names
    if (match.previousNames && !entry.formerNames) {
      entry.formerNames = match.previousNames.map(pn => pn.name)
    }

    // Enrich note from boatnerd summary if the current note is short
    if (match.summary && (!entry.note || entry.note.length < 80)) {
      entry.note = match.summary
    }
  }

  console.log(`\n✅ Matched ${updated} vessels (${photoUpdated} photos upgraded)`)

  if (!DRY_RUN) {
    writeFileSync(dbPath, JSON.stringify(db, null, 2) + '\n', 'utf8')
    console.log(`💾 Updated ships-db.json`)
  } else {
    console.log('🔍 Dry run — no files changed')
  }

  return { updated, photoUpdated }
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log('🚢  Boatnerd Gallery Scraper\n')

  const vessels = await scrapeGalleryIndex()
  console.log(`\n🔍 Scraping ${vessels.length} vessel pages…\n`)

  const scraped = await scrapeVesselPages(vessels)

  // Save raw scraped data
  const rawPath = resolve(__dirname, 'boatnerd-raw.json')
  writeFileSync(rawPath, JSON.stringify(scraped, null, 2) + '\n', 'utf8')
  console.log(`\n📝 Saved raw data → scripts/boatnerd-raw.json`)

  // Merge
  mergeIntoShipsDb(scraped)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
