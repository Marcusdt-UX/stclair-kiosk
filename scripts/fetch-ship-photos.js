/**
 * fetch-ship-photos.js — browser console script
 * ---------------------------------------------
 * Precaches one photo per fleet vessel from Boatnerd's media library.
 *
 * Why a browser script: Boatnerd's 2025–26 site rebuild removed the old
 * vessel pages and most of the photo URLs in boatnerd-raw.json. Their
 * WordPress media search still works, and running it from a boatnerd.com
 * tab keeps every request same-origin (no CORS, no bot walls).
 *
 * How to run:
 *   1. node scripts/build-fleet-db.mjs           (makes src/data/fleet-db.json)
 *   2. Open https://www.boatnerd.com/ in Chrome, open DevTools → Console
 *   3. Paste:  window.__slugs = <contents of the "slugs" array printed below>
 *        node -e "console.log(JSON.stringify(Object.keys(require('./src/data/fleet-db.json'))))"
 *   4. Paste this whole file. When it finishes it downloads ship-photos.zip
 *   5. Unzip into public/ships/ and re-run: node scripts/build-fleet-db.mjs
 *
 * Picking a photo: the vessel name must appear near the start of the media
 * title; St. Clair River / Port Huron / Sarnia shots score highest (that's
 * the view from the MOC), then landscape, credited, and newer photos.
 * Port-report images (long titles listing many ships) are skipped.
 * Output: <slug>.jpg (≤800px wide, JPEG q76) + manifest.json with caption,
 * photographer credit, source URL and date for each photo.
 */
;(async () => {
  const slugs = window.__slugs
  if (!Array.isArray(slugs)) throw new Error('Set window.__slugs first')

  // Search terms that can't be derived from the slug
  const FIX = {
    'constable-carricre': 'constable carriere', 'demo-laura-l-van-enkevort': 'laura l vanenkevort',
    'biscayne-bay-wtgb-104': 'biscayne bay', 'uscgc-hollyhock-2': 'hollyhock',
    'dirk-s-vanenkevort': 'dirk s vanenkevort', 'clyde-s-van-enkevort': 'clyde s vanenkevort',
    'maumee-2-2': 'maumee', 'menominee-3': 'menominee', 'provmar-terminal-storage-barge': 'provmar terminal',
    'pere-marquette-41-barge': 'pere marquette 41', 'undaunted-articulated-tug': 'undaunted',
    'michigan-articulated-tug': 'michigan', 'great-lakes-barge': 'great lakes',
    'st-marys-cement-ii-barge': 'st marys cement ii', 'st-marys-cement-barge': 'st marys cement',
    'c-t-c-no-1': 'ctc no 1', 'g-l-b-no-2': 'glb no 2',
  }
  const term = s => FIX[s] || s.replace(/-(barge|tug|ferry)$/, '').replace(/-\d+$/, '').replace(/-/g, ' ')
  const compact = s => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '')
  const decode = s => { const t = document.createElement('textarea'); t.innerHTML = s; return t.value }
  const LOCAL = /st\.? ?clair|port huron|sarnia|blue water|marine city|algonac|marysville|lake huron cut|point edward/i

  const photos = {}, manifest = {}, missing = []
  const queue = [...slugs]

  async function worker() {
    while (queue.length) {
      const slug = queue.shift()
      try {
        const q = term(slug)
        const r = await fetch(`/wp-json/wp/v2/media?search=${encodeURIComponent(q)}&per_page=30&media_type=image` +
          `&_fields=id,source_url,title,date,media_details.width,media_details.height,media_details.sizes`)
        const items = r.ok ? await r.json() : []
        const key = compact(q)
        let best = null, bestScore = -1
        for (const it of items) {
          const title = decode(it.title?.rendered || '').trim()
          if (title.length > 220 || /port report|^\d{1,2}\/\d{1,2}\/\d{2,4}/i.test(title)) continue
          const ct = compact(title), pos = ct.indexOf(key)
          if (pos < 0 || pos > 45) continue
          const after = ct.slice(pos + key.length, pos + key.length + 2)
          if (/^(ii|iv|vi|[0-9])/.test(after) && !/(ii|iv|vi|[0-9])$/.test(key)) continue
          const w = it.media_details?.width || 0, h = it.media_details?.height || 0
          if (w && w < 600) continue
          let score = 2
          if (pos === 0) score += 1
          if (LOCAL.test(title)) score += 3
          if (w > h * 1.2) score += 1
          if (/\[[^\]]*[a-z][^\]]*\]/i.test(title)) score += 0.5
          score += Math.max(0, new Date(it.date).getFullYear() - 2015) * 0.1
          if (score > bestScore) { best = { it, title }; bestScore = score }
        }
        if (!best) { missing.push(slug); continue }
        const sz = best.it.media_details?.sizes || {}
        const src = (sz.large || sz.medium_large || {}).source_url || best.it.source_url
        const bmp = await createImageBitmap(await (await fetch(src)).blob())
        const scale = Math.min(1, 800 / bmp.width)
        const c = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale))
        c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height)
        photos[slug] = await c.convertToBlob({ type: 'image/jpeg', quality: 0.76 })
        const credits = [...best.title.matchAll(/\[([^\]]+)\]/g)].map(m => m[1].trim()).filter(x => !/^\d+$/.test(x))
        manifest[slug] = {
          caption: best.title.replace(/\s*\[[^\]]*\]/g, '').trim(),
          credit: credits.at(-1) || null,
          source: best.it.source_url,
          date: best.it.date.slice(0, 10),
        }
      } catch (e) { missing.push(slug); console.warn(slug, e) }
      console.log(`${slugs.length - queue.length}/${slugs.length}`)
    }
  }
  await Promise.all([worker(), worker()])

  const files = Object.entries(photos).map(async ([slug, blob]) => ({ name: `${slug}.jpg`, data: new Uint8Array(await blob.arrayBuffer()) }))
  const all = await Promise.all(files)
  all.push({ name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) })
  const zip = await makeZip(all)
  const a = document.createElement('a')
  a.href = URL.createObjectURL(zip); a.download = 'ship-photos.zip'; a.click()
  console.log(`Done: ${Object.keys(photos).length} photos, ${missing.length} not found:`, missing)

  // Minimal store-only ZIP writer (JPEGs don't compress further)
  async function makeZip(files) {
    const table = new Uint32Array(256)
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0 }
    const crc32 = d => { let c = 0xFFFFFFFF; for (let i = 0; i < d.length; i++) c = table[(c ^ d[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0 }
    const enc = new TextEncoder(), parts = [], central = []
    let offset = 0
    for (const f of files) {
      const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length
      const lh = new DataView(new ArrayBuffer(30))
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true)
      lh.setUint16(12, 0x21, true); lh.setUint32(14, crc, true); lh.setUint32(18, size, true); lh.setUint32(22, size, true)
      lh.setUint16(26, name.length, true)
      parts.push(lh.buffer, name, f.data)
      const ch = new DataView(new ArrayBuffer(46))
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true)
      ch.setUint16(14, 0x21, true); ch.setUint32(16, crc, true); ch.setUint32(20, size, true); ch.setUint32(24, size, true)
      ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true)
      central.push(ch.buffer, name)
      offset += 30 + name.length + size
    }
    const cdSize = central.reduce((a, b) => a + (b.byteLength ?? b.length), 0)
    const end = new DataView(new ArrayBuffer(22))
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true)
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true)
    return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' })
  }
})()
