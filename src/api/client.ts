import { AddQueue, BatchQueryQueue, LatestPayloadQueue, type AddQueueResult } from './queues'

export type QueryResult = {
  items: number[]
  total: number
}

export type QueryRequest = {
  key: string
  type: 'available' | 'selected' | 'selectionFull'
  filter?: string
  offset?: number
  limit?: number
}

const API_BASE_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3001'

async function postJson<T>(path: string, body: unknown): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : ''
    if (message.toLowerCase().includes('failed to fetch')) {
      throw new Error('Сервер недоступен. Проверьте соединение и повторите попытку.')
    }
    throw new Error('Не удалось выполнить запрос. Попробуйте ещё раз позже.')
  }

  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || 'Ошибка сети')
  }

  return response.json()
}

const queryQueue = new BatchQueryQueue<QueryRequest, QueryResult>(1000, async (requests) => {
  if (!requests.length) return {}
  const data = await postJson<{ results: Record<string, QueryResult> }>('/api/query', {
    queries: requests,
  })
  return data.results ?? {}
})

const addQueue = new AddQueue(10_000, async (ids) => {
  if (!ids.length) return { added: [], rejected: [] }
  return postJson('/api/items/batch', { ids })
})

const selectionQueue = new LatestPayloadQueue<number[], void>(1000, async (payload) => {
  await postJson('/api/selection', { selectedIds: payload })
})

export function runQuery(request: QueryRequest) {
  return queryQueue.enqueue(request)
}

export function enqueueAddition(id: number): Promise<AddQueueResult> {
  return addQueue.enqueue(id)
}

export function persistSelection(ids: number[]) {
  return selectionQueue.enqueue([...ids])
}
