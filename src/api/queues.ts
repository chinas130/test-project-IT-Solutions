type Resolver<T> = {
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

export class BatchQueryQueue<Request extends { key: string }, Result> {
  private pending = new Map<string, { request: Request; resolvers: Resolver<Result>[] }>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private intervalMs: number
  private dispatcher: (requests: Request[]) => Promise<Record<string, Result>>

  constructor(intervalMs: number, dispatcher: (requests: Request[]) => Promise<Record<string, Result>>) {
    this.intervalMs = intervalMs
    this.dispatcher = dispatcher
  }

  enqueue(request: Request) {
    return new Promise<Result>((resolve, reject) => {
      if (!request?.key) {
        reject(new Error('Запрос должен содержать ключ'))
        return
      }

      const existing = this.pending.get(request.key)
      const resolver: Resolver<Result> = { resolve, reject }
      if (existing) {
        existing.request = request
        existing.resolvers.push(resolver)
      } else {
        this.pending.set(request.key, { request, resolvers: [resolver] })
      }
      this.schedule()
    })
  }

  private schedule() {
    if (this.timer) return
    this.timer = setTimeout(() => this.flush(), this.intervalMs)
  }

  private async flush() {
    if (!this.pending.size) {
      if (this.timer) {
        clearTimeout(this.timer)
        this.timer = null
      }
      return
    }

    const entries = Array.from(this.pending.entries())
    this.pending.clear()
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }

    try {
      const requests = entries.map(([, value]) => value.request)
      const responseMap = await this.dispatcher(requests)
      for (const [key, { resolvers }] of entries) {
        const result = responseMap[key]
        if (result === undefined) {
          const error = new Error('Сервер не вернул результат для запроса')
          resolvers.forEach(({ reject }) => reject(error))
        } else {
          resolvers.forEach(({ resolve }) => resolve(result))
        }
      }
    } catch (error) {
      for (const [, { resolvers }] of entries) {
        resolvers.forEach(({ reject }) => reject(error))
      }
    }
  }
}

export type AddQueueResult = { id: number; success: boolean; message: string }

export class AddQueue {
  private pending = new Map<number, Resolver<AddQueueResult>[]>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private intervalMs: number
  private dispatcher: (ids: number[]) => Promise<{
    added: number[]
    rejected: Array<{ id: number; reason: string }>
  }>

  constructor(
    intervalMs: number,
    dispatcher: (ids: number[]) => Promise<{
      added: number[]
      rejected: Array<{ id: number; reason: string }>
    }>
  ) {
    this.intervalMs = intervalMs
    this.dispatcher = dispatcher
  }

  enqueue(id: number) {
    return new Promise<AddQueueResult>((resolve, reject) => {
      if (!Number.isInteger(id) || id <= 0) {
        reject(new Error('ID должен быть положительным целым числом'))
        return
      }

      const resolver: Resolver<AddQueueResult> = { resolve, reject }
      const existing = this.pending.get(id)
      if (existing) {
        existing.push(resolver)
      } else {
        this.pending.set(id, [resolver])
      }
      this.schedule()
    })
  }

  private schedule() {
    if (this.timer) return
    this.timer = setTimeout(() => this.flush(), this.intervalMs)
  }

  private async flush() {
    if (!this.pending.size) {
      if (this.timer) {
        clearTimeout(this.timer)
        this.timer = null
      }
      return
    }

    const entries = Array.from(this.pending.entries())
    this.pending.clear()
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }

    try {
      const ids = entries.map(([id]) => id)
      const response = await this.dispatcher(ids)
      const addedSet = new Set(response.added ?? [])
      const rejectedMap = new Map<number, string>()
      for (const record of response.rejected ?? []) {
        const numeric = Number(record.id)
        rejectedMap.set(numeric, record.reason)
      }

      for (const [id, resolvers] of entries) {
        let payload: AddQueueResult
        if (addedSet.has(id)) {
          payload = { id, success: true, message: `ID ${id} успешно добавлен` }
        } else {
          const reason = rejectedMap.get(id) ?? 'ID не был добавлен'
          payload = { id, success: false, message: reason }
        }
        resolvers.forEach(({ resolve }) => resolve(payload))
      }
    } catch (error) {
      for (const [, resolvers] of entries) {
        resolvers.forEach(({ reject }) => reject(error))
      }
    }
  }
}

export class LatestPayloadQueue<TPayload, TResult> {
  private pending: { payload: TPayload; resolvers: Resolver<TResult>[] } | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private intervalMs: number
  private dispatcher: (payload: TPayload) => Promise<TResult>

  constructor(intervalMs: number, dispatcher: (payload: TPayload) => Promise<TResult>) {
    this.intervalMs = intervalMs
    this.dispatcher = dispatcher
  }

  enqueue(payload: TPayload) {
    return new Promise<TResult>((resolve, reject) => {
      const resolver: Resolver<TResult> = { resolve, reject }
      if (this.pending) {
        this.pending.payload = payload
        this.pending.resolvers.push(resolver)
      } else {
        this.pending = { payload, resolvers: [resolver] }
      }
      this.schedule()
    })
  }

  private schedule() {
    if (this.timer) return
    this.timer = setTimeout(() => this.flush(), this.intervalMs)
  }

  private async flush() {
    if (!this.pending) {
      if (this.timer) {
        clearTimeout(this.timer)
        this.timer = null
      }
      return
    }

    const current = this.pending
    this.pending = null
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }

    try {
      const result = await this.dispatcher(current.payload)
      current.resolvers.forEach(({ resolve }) => resolve(result))
    } catch (error) {
      current.resolvers.forEach(({ reject }) => reject(error))
    }
  }
}
