import express from 'express'
import cors from 'cors'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.env.PORT) || 3001
const BASE_MAX_ID = 1_000_000
const PAGE_LIMIT = 20

const app = express()
app.use((req, res, next) => {
  const start = Date.now()
  res.on('finish', () => {
    const duration = Date.now() - start
    console.log(
      `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} - ${res.statusCode} (${duration}ms)`
    )
  })
  next()
})
app.use(cors())
app.use(express.json({ limit: '1mb' }))

const addedIds = new Set()
let addedIdCache = null
let selectedIds = []
let selectedLookup = new Set()

const getNormalizedFilter = (value) => (typeof value === 'string' ? value.trim() : '')
const clampOffset = (value) => (Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0)
const clampLimit = (value) => {
  if (!Number.isFinite(value) || value <= 0) return PAGE_LIMIT
  return Math.min(Math.floor(value), 200)
}

const ensureSelectedLookup = () => {
  selectedLookup = new Set(selectedIds)
}

ensureSelectedLookup()

const hasId = (rawId) => {
  const id = Number(rawId)
  if (!Number.isInteger(id) || id <= 0) return false
  if (id >= 1 && id <= BASE_MAX_ID) return true
  return addedIds.has(id)
}

const getSortedAdded = () => {
  if (!addedIdCache) {
    addedIdCache = Array.from(addedIds).sort((a, b) => a - b)
  }
  return addedIdCache
}

const buildAvailableResult = ({ filter, offset = 0, limit = PAGE_LIMIT }) => {
  const normalizedFilter = getNormalizedFilter(filter)
  const safeOffset = clampOffset(offset)
  const safeLimit = clampLimit(limit)
  const matchesFilter = normalizedFilter
    ? (id) => String(id).includes(normalizedFilter)
    : () => true

  const items = []
  let total = 0
  const consider = (id) => {
    if (selectedLookup.has(id)) return
    if (!matchesFilter(id)) return
    if (total >= safeOffset && items.length < safeLimit) {
      items.push(id)
    }
    total += 1
  }

  for (let id = 1; id <= BASE_MAX_ID; id += 1) {
    consider(id)
  }

  for (const id of getSortedAdded()) {
    consider(id)
  }

  return { items, total }
}

const buildSelectedResult = ({ filter, offset = 0, limit = PAGE_LIMIT }) => {
  const normalizedFilter = getNormalizedFilter(filter)
  const safeOffset = clampOffset(offset)
  const safeLimit = clampLimit(limit)
  const matchesFilter = normalizedFilter
    ? (id) => String(id).includes(normalizedFilter)
    : () => true

  const items = []
  let total = 0

  for (const id of selectedIds) {
    if (!matchesFilter(id)) continue
    if (total >= safeOffset && items.length < safeLimit) {
      items.push(id)
    }
    total += 1
  }

  return { items, total }
}

const sanitizeIds = (ids) => {
  if (!Array.isArray(ids)) return []
  const seen = new Set()
  const result = []
  for (const raw of ids) {
    const id = Number(raw)
    if (!Number.isInteger(id) || id <= 0) continue
    if (!hasId(id)) continue
    if (seen.has(id)) continue
    seen.add(id)
    result.push(id)
  }
  return result
}

app.post('/api/items/batch', (req, res) => {
  const incoming = Array.isArray(req.body?.ids) ? req.body.ids : []
  const toAdd = new Set()
  const rejected = []

  for (const raw of incoming) {
    const id = Number(raw)
    if (!Number.isInteger(id) || id <= 0) {
      rejected.push({ id: raw, reason: 'ID должен быть положительным целым числом' })
      continue
    }
    if (id >= 1 && id <= BASE_MAX_ID) {
      rejected.push({ id, reason: 'ID уже существует в базовом наборе' })
      continue
    }
    if (addedIds.has(id)) {
      rejected.push({ id, reason: 'ID уже добавлен' })
      continue
    }
    toAdd.add(id)
  }

  const added = Array.from(toAdd).sort((a, b) => a - b)
  for (const id of added) {
    addedIds.add(id)
  }
  if (added.length > 0) {
    addedIdCache = null
  }

  res.json({ added, rejected })
})

app.post('/api/selection', (req, res) => {
  const nextSelection = sanitizeIds(req.body?.selectedIds)
  selectedIds = nextSelection
  ensureSelectedLookup()
  res.json({ selected: selectedIds })
})

app.post('/api/query', (req, res) => {
  const queries = Array.isArray(req.body?.queries) ? req.body.queries : []
  const results = {}

  for (const query of queries) {
    const key = query?.key
    if (!key) continue
    if (query.type === 'available') {
      results[key] = buildAvailableResult(query)
    } else if (query.type === 'selected') {
      results[key] = buildSelectedResult(query)
    } else if (query.type === 'selectionFull') {
      results[key] = { items: [...selectedIds], total: selectedIds.length }
    }
  }

  res.json({ results })
})

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distPath = path.join(__dirname, '../dist')
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath))
  app.get(/^\/(?!api).*/, (req, res, next) => {
    if (req.path.startsWith('/api')) return next()
    return res.sendFile(path.join(distPath, 'index.html'))
  })
}

app.listen(PORT, () => {
  console.log(`API server running on http://localhost:${PORT}`)
})
