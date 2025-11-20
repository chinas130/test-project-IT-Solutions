import express from 'express'
import cors from 'cors'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.env.PORT) || 3001
const HOST = process.env.HOST || '0.0.0.0'
const BASE_MAX_ID = 1_000_000
const PAGE_LIMIT = 20
const QUERY_BATCH_INTERVAL = 1000
const SELECTION_BATCH_INTERVAL = 1000
const ADD_BATCH_INTERVAL = 10_000

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

const createQueryBatcher = () => {
  let timer = null
  let pending = []

  const flush = () => {
    timer = null
    if (!pending.length) return

    const collectedQueries = []
    const keyToQuery = new Map()
    for (const item of pending) {
      for (const query of item.queries) {
        if (!query?.key) continue
        keyToQuery.set(query.key, query)
      }
    }
    collectedQueries.push(...keyToQuery.values())

    const results = {}
    for (const query of collectedQueries) {
      if (query.type === 'available') {
        results[query.key] = buildAvailableResult(query)
      } else if (query.type === 'selected') {
        results[query.key] = buildSelectedResult(query)
      } else if (query.type === 'selectionFull') {
        results[query.key] = { items: [...selectedIds], total: selectedIds.length }
      }
    }

    for (const item of pending) {
      const response = {}
      for (const query of item.queries) {
        if (!query?.key) continue
        if (results[query.key] !== undefined) {
          response[query.key] = results[query.key]
        }
      }
      item.resolve({ results: response })
    }
    pending = []
  }

  return {
    enqueue(queries) {
      return new Promise((resolve) => {
        pending.push({ queries, resolve })
        if (!timer) {
          timer = setTimeout(flush, QUERY_BATCH_INTERVAL)
        }
      })
    },
  }
}

const createSelectionBatcher = () => {
  let timer = null
  let latest = null
  let resolvers = []

  const flush = () => {
    timer = null
    if (!latest) {
      resolvers.forEach((resolve) => resolve({ selected: selectedIds }))
      resolvers = []
      return
    }

    selectedIds = latest
    ensureSelectedLookup()
    latest = null
    resolvers.forEach((resolve) => resolve({ selected: selectedIds }))
    resolvers = []
  }

  return {
    enqueue(nextSelection) {
      return new Promise((resolve) => {
        latest = nextSelection
        resolvers.push(resolve)
        if (!timer) {
          timer = setTimeout(flush, SELECTION_BATCH_INTERVAL)
        }
      })
    },
  }
}

const createAddBatcher = () => {
  let timer = null
  const pendingRequests = []

  const flush = () => {
    timer = null
    if (!pendingRequests.length) return

    const requested = []
    for (const req of pendingRequests) {
      for (const id of req.ids) {
        requested.push(id)
      }
    }
    const toAdd = new Set()
    const rejectedGlobal = []

    for (const raw of requested) {
      const id = Number(raw)
      if (!Number.isInteger(id) || id <= 0) {
        rejectedGlobal.push({ id: raw, reason: 'ID должен быть положительным целым числом' })
        continue
      }
      if (id >= 1 && id <= BASE_MAX_ID) {
        rejectedGlobal.push({ id, reason: 'ID уже существует в базовом наборе' })
        continue
      }
      if (addedIds.has(id)) {
        rejectedGlobal.push({ id, reason: 'ID уже добавлен' })
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

    for (const req of pendingRequests) {
      const addedForRequest = added.filter((id) => req.idSet.has(id))
      const rejectedForRequest = rejectedGlobal.filter((item) => req.idSet.has(Number(item.id)))
      req.resolve({ added: addedForRequest, rejected: rejectedForRequest })
    }

    pendingRequests.length = 0
  }

  return {
    enqueue(ids) {
      return new Promise((resolve) => {
        const idSet = new Set(Array.isArray(ids) ? ids : [])
        pendingRequests.push({ ids, idSet, resolve })
        if (!timer) {
          timer = setTimeout(flush, ADD_BATCH_INTERVAL)
        }
      })
    },
  }
}

const queryBatcher = createQueryBatcher()
const selectionBatcher = createSelectionBatcher()
const addBatcher = createAddBatcher()

app.post('/api/items/batch', async (req, res) => {
  const incoming = Array.isArray(req.body?.ids) ? req.body.ids : []
  const result = await addBatcher.enqueue(incoming)
  res.json(result)
})

app.post('/api/selection', async (req, res) => {
  const nextSelection = sanitizeIds(req.body?.selectedIds)
  const result = await selectionBatcher.enqueue(nextSelection)
  res.json(result)
})

app.post('/api/query', async (req, res) => {
  const queries = Array.isArray(req.body?.queries) ? req.body.queries : []
  const result = await queryBatcher.enqueue(queries)
  res.json(result)
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

app.listen(PORT, HOST, () => {
  console.log(`API server running on http://${HOST}:${PORT}`)
})
