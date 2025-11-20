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

export async function runQuery(request: QueryRequest): Promise<QueryResult> {
  const payload = await postJson<{ results: Record<string, QueryResult> }>('/api/query', {
    queries: [request],
  })
  const result = payload.results?.[request.key]
  if (!result) {
    throw new Error('Сервер не вернул результат для запроса')
  }
  return result
}

export type AddResult = { id: number; success: boolean; message: string }

export async function enqueueAddition(id: number): Promise<AddResult> {
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('ID должен быть положительным целым числом')
  }
  const result = await postJson<{
    added: number[]
    rejected: Array<{ id: number; reason: string }>
  }>('/api/items/batch', { ids: [id] })
  if (result.added?.includes(id)) {
    return { id, success: true, message: `ID ${id} успешно добавлен` }
  }
  const reason = result.rejected?.find((item) => Number(item.id) === id)?.reason
  return { id, success: false, message: reason ?? 'ID не был добавлен' }
}

export async function persistSelection(ids: number[]) {
  await postJson('/api/selection', { selectedIds: [...ids] })
}
