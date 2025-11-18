import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type ReactNode,
} from 'react'
import './App.css'
import { enqueueAddition, persistSelection, runQuery } from './api/client'
import { useDebouncedValue } from './hooks/useDebouncedValue'

const PAGE_SIZE = 20

type ScrollListProps<T> = {
  items: T[]
  renderItem: (item: T) => ReactNode
  hasMore: boolean
  isLoading: boolean
  emptyPlaceholder: string
  onLoadMore: () => void
}

function ScrollList<T>({ items, renderItem, hasMore, isLoading, emptyPlaceholder, onLoadMore }: ScrollListProps<T>) {
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const loadingRef = useRef(isLoading)
  const interactedRef = useRef(false)

  useEffect(() => {
    loadingRef.current = isLoading
  }, [isLoading])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const markScroll = () => {
      interactedRef.current = true
    }
    window.addEventListener('scroll', markScroll, { passive: true })
    window.addEventListener('wheel', markScroll, { passive: true })
    window.addEventListener('touchmove', markScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', markScroll)
      window.removeEventListener('wheel', markScroll)
      window.removeEventListener('touchmove', markScroll)
    }
  }, [])

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || !hasMore) return
    let pending = false
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        if (!entry?.isIntersecting) {
          pending = false
          return
        }
        if (!interactedRef.current || loadingRef.current || pending) return
        pending = true
        interactedRef.current = false
        onLoadMore()
      },
      { root: null, rootMargin: '200px 0px 0px 0px', threshold: 0 }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMore, onLoadMore])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!hasMore || isLoading) return
    const doc = document.documentElement
    if (doc.scrollHeight <= window.innerHeight + 20) {
      onLoadMore()
    }
  }, [hasMore, isLoading, items.length, onLoadMore])

  return (
    <div className="list">
      {items.map((item) => renderItem(item))}
      {isLoading && <div className="hint">Загрузка...</div>}
      {!isLoading && items.length === 0 && <div className="hint">{emptyPlaceholder}</div>}
      {hasMore && <div ref={sentinelRef} className="list__sentinel" aria-hidden />}
    </div>
  )
}

const isSameOrder = (a: number[], b: number[]) => {
  if (a === b) return true
  if (a.length !== b.length) return false
  return a.every((value, index) => value === b[index])
}

function App() {
  const [availableFilter, setAvailableFilter] = useState('')
  const [selectedFilter, setSelectedFilter] = useState('')
  const debouncedAvailableFilter = useDebouncedValue(availableFilter, 300)
  const debouncedSelectedFilter = useDebouncedValue(selectedFilter, 300)

  const [availableItems, setAvailableItems] = useState<number[]>([])
  const [availableTotal, setAvailableTotal] = useState(0)
  const [availableLoading, setAvailableLoading] = useState(false)
  const [availableError, setAvailableError] = useState<string | null>(null)

  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const selectionRef = useRef<number[]>([])
  const [selectionLoading, setSelectionLoading] = useState(true)
  const [selectedItems, setSelectedItems] = useState<number[]>([])
  const [selectedTotal, setSelectedTotal] = useState(0)
  const [selectedListLoading, setSelectedListLoading] = useState(false)
  const [selectedListError, setSelectedListError] = useState<string | null>(null)
  const [draggingId, setDraggingId] = useState<number | null>(null)
  const pendingOrderRef = useRef<number[] | null>(null)

  const [addValue, setAddValue] = useState('')
  const [statusMessage, setStatusMessage] = useState<string | null>(null)


  const availableFilterRef = useRef(debouncedAvailableFilter)
  useEffect(() => {
    availableFilterRef.current = debouncedAvailableFilter
  }, [debouncedAvailableFilter])

  const selectedFilterRef = useRef(debouncedSelectedFilter)
  useEffect(() => {
    selectedFilterRef.current = debouncedSelectedFilter
  }, [debouncedSelectedFilter])

  const removeIdFromAvailableList = useCallback((id: number) => {
    let removed = false
    setAvailableItems((prev) => {
      if (!prev.includes(id)) return prev
      removed = true
      return prev.filter((value) => value !== id)
    })
    if (removed) {
      setAvailableTotal((prev) => Math.max(prev - 1, 0))
    }
  }, [])

  const fetchAvailablePage = useCallback(async (filterValue: string, offset: number, append: boolean) => {
    setAvailableLoading(true)
    setAvailableError(null)
    try {
      const result = await runQuery({
        key: `available:${filterValue}:${offset}`,
        type: 'available',
        filter: filterValue,
        offset,
        limit: PAGE_SIZE,
      })
      if (availableFilterRef.current !== filterValue) return
      setAvailableTotal(result.total ?? 0)
      setAvailableItems((prev) => {
        if (!append) return result.items
        const seen = new Set(prev)
        const merged = [...prev]
        for (const id of result.items) {
          if (seen.has(id)) continue
          seen.add(id)
          merged.push(id)
        }
        return merged
      })
    } catch (error) {
      if (availableFilterRef.current !== filterValue) return
      const message = error instanceof Error ? error.message : 'Не удалось загрузить элементы'
      setAvailableError(message)
    } finally {
      if (availableFilterRef.current === filterValue) {
        setAvailableLoading(false)
      }
    }
  }, [runQuery])

  const refreshAvailable = useCallback(() => {
    fetchAvailablePage(availableFilterRef.current, 0, false)
  }, [fetchAvailablePage])

  const fetchSelectedPage = useCallback(
    async (filterValue: string, offset: number, append: boolean) => {
      setSelectedListLoading(true)
      setSelectedListError(null)
      try {
        const result = await runQuery({
          key: `selected:${filterValue}:${offset}`,
          type: 'selected',
          filter: filterValue,
          offset,
          limit: PAGE_SIZE,
        })
        if (selectedFilterRef.current !== filterValue) return
        setSelectedTotal(result.total ?? 0)
        setSelectedItems((prev) => {
          if (!append) return result.items
          const seen = new Set(prev)
          const merged = [...prev]
          for (const id of result.items) {
            if (seen.has(id)) continue
            seen.add(id)
            merged.push(id)
          }
          return merged
        })
      } catch (error) {
        if (selectedFilterRef.current !== filterValue) return
        const message = error instanceof Error ? error.message : 'Не удалось загрузить выбранные элементы'
        setSelectedListError(message)
      } finally {
        if (selectedFilterRef.current === filterValue) {
          setSelectedListLoading(false)
        }
      }
    },
    [runQuery]
  )

  const refreshSelectedList = useCallback(() => {
    fetchSelectedPage(selectedFilterRef.current, 0, false)
  }, [fetchSelectedPage])

  useEffect(() => {
    setAvailableItems([])
    setAvailableTotal(0)
    fetchAvailablePage(debouncedAvailableFilter, 0, false)
  }, [debouncedAvailableFilter, fetchAvailablePage])

  useEffect(() => {
    setSelectedItems([])
    setSelectedTotal(0)
    fetchSelectedPage(debouncedSelectedFilter, 0, false)
  }, [debouncedSelectedFilter, fetchSelectedPage])

  useEffect(() => {
    let cancelled = false
    const loadSelection = async () => {
      setSelectionLoading(true)
      try {
        const result = await runQuery({ key: 'selectionFull', type: 'selectionFull' })
        if (cancelled) return
        setSelectedIds(result.items ?? [])
        selectionRef.current = result.items ?? []
      } catch (error) {
        if (cancelled) return
        const message = error instanceof Error ? error.message : 'Ошибка при загрузке выбранных элементов'
        setStatusMessage(message)
      } finally {
        if (!cancelled) {
          setSelectionLoading(false)
        }
      }
    }
    loadSelection()
    return () => {
      cancelled = true
    }
  }, [runQuery])

  useEffect(() => {
    const timer = statusMessage ? setTimeout(() => setStatusMessage(null), 4000) : null
    return () => {
      if (timer) clearTimeout(timer)
    }
  }, [statusMessage])

  useEffect(() => {
    selectionRef.current = selectedIds
  }, [selectedIds])

  type SelectionPersistOptions = { refreshLeft?: boolean; refreshSelected?: boolean }

  const syncSelectedItemsFromSelection = useCallback(() => {
    setSelectedItems((prev) => {
      if (!prev.length) return prev
      const filterValue = selectedFilterRef.current.trim()
      const matchesFilter = filterValue ? (id: number) => String(id).includes(filterValue) : () => true
      const nextItems: number[] = []
      for (const id of selectionRef.current) {
        if (!matchesFilter(id)) continue
        nextItems.push(id)
        if (nextItems.length >= prev.length) break
      }
      return nextItems
    })
  }, [])

  const persistSelectionChange = useCallback(
    (ids: number[], options: SelectionPersistOptions = {}) => {
      persistSelection(ids)
        .then(() => {
          if (options.refreshLeft) {
            refreshAvailable()
          }
          if (options.refreshSelected) {
            refreshSelectedList()
          }
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : 'Не удалось сохранить выбор'
          setStatusMessage(message)
        })
    },
    [persistSelection, refreshAvailable, refreshSelectedList]
  )

  const applySelection = useCallback(
    (next: number[], options?: SelectionPersistOptions) => {
      if (isSameOrder(next, selectionRef.current)) return
      setSelectedIds(next)
      selectionRef.current = next
      syncSelectedItemsFromSelection()
      persistSelectionChange(next, options)
    },
    [persistSelectionChange, syncSelectedItemsFromSelection]
  )

  const handleMoveToSelection = useCallback(
    (id: number) => {
      const current = selectionRef.current
      if (current.includes(id)) return
      removeIdFromAvailableList(id)
      const next = [...current, id]
      const filterValue = selectedFilterRef.current.trim()
      if (!filterValue || String(id).includes(filterValue)) {
        setSelectedTotal((prev) => prev + 1)
      }
      applySelection(next, { refreshLeft: true, refreshSelected: true })
    },
    [applySelection, removeIdFromAvailableList]
  )

  const handleRemoveFromSelection = useCallback(
    (id: number) => {
      const current = selectionRef.current
      if (!current.includes(id)) return
      const next = current.filter((value) => value !== id)
      const filterValue = selectedFilterRef.current.trim()
      if (!filterValue || String(id).includes(filterValue)) {
        setSelectedTotal((prev) => Math.max(prev - 1, 0))
      }
      applySelection(next, { refreshLeft: true, refreshSelected: true })
    },
    [applySelection]
  )

  const handleDragStart = useCallback((event: DragEvent<HTMLDivElement>, id: number) => {
    event.dataTransfer.effectAllowed = 'move'
    setDraggingId(id)
  }, [])

  const handleDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>, targetId: number) => {
      event.preventDefault()
      if (draggingId === null || draggingId === targetId) return
      const current = selectionRef.current
      const fromIndex = current.indexOf(draggingId)
      const toIndex = current.indexOf(targetId)
      if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return
      const next = [...current]
      next.splice(fromIndex, 1)
      next.splice(toIndex, 0, draggingId)
      setSelectedIds(next)
      selectionRef.current = next
      setSelectedItems((prev) => {
        const prevFrom = prev.indexOf(draggingId)
        const prevTo = prev.indexOf(targetId)
        if (prevFrom === -1 || prevTo === -1) return prev
        const reordered = [...prev]
        reordered.splice(prevFrom, 1)
        reordered.splice(prevTo, 0, draggingId)
        return reordered
      })
      pendingOrderRef.current = next
    },
    [draggingId]
  )

  const handleDragEnd = useCallback(() => {
    if (draggingId === null) return
    setDraggingId(null)
    const pending = pendingOrderRef.current
    pendingOrderRef.current = null
    if (!pending) return
    if (!isSameOrder(pending, selectionRef.current)) {
      selectionRef.current = pending
      setSelectedIds(pending)
    }
    syncSelectedItemsFromSelection()
    persistSelectionChange(pending)
  }, [draggingId, persistSelectionChange, syncSelectedItemsFromSelection])

  const selectedHasMore = selectedItems.length < selectedTotal
  const availableHasMore = availableItems.length < availableTotal

  const handleSelectedLoadMore = useCallback(() => {
    if (selectedListLoading || !selectedHasMore) return
    fetchSelectedPage(selectedFilterRef.current, selectedItems.length, true)
  }, [fetchSelectedPage, selectedHasMore, selectedItems.length, selectedListLoading])

  const handleAvailableLoadMore = useCallback(() => {
    if (availableLoading || !availableHasMore) return
    fetchAvailablePage(availableFilterRef.current, availableItems.length, true)
  }, [availableHasMore, availableItems.length, availableLoading, fetchAvailablePage])

  const handleAddCustom = useCallback(() => {
    const trimmed = addValue.trim()
    if (!trimmed) {
      setStatusMessage('Введите ID для добавления')
      return
    }
    const numericId = Number(trimmed)
    if (!Number.isInteger(numericId) || numericId <= 0) {
      setStatusMessage('ID должен быть положительным целым числом')
      return
    }
    setStatusMessage(`ID ${numericId} поставлен в очередь на добавление`)
    enqueueAddition(numericId)
      .then((result) => {
        setStatusMessage(result.message)
        if (result.success) {
          setAddValue('')
          refreshAvailable()
        }
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : 'Не удалось добавить элемент'
        setStatusMessage(message)
      })
  }, [addValue, enqueueAddition, refreshAvailable])

  const handleAddSubmit = useCallback(
    (event: FormEvent) => {
      event.preventDefault()
      handleAddCustom()
    },
    [handleAddCustom]
  )

  const availablePlaceholder = availableError ?? 'Совпадений не найдено'
  const selectedPlaceholder =
    selectedListError ?? (selectionLoading || selectedListLoading ? 'Загрузка выбранных элементов...' : 'Выбор пуст')

  return (
    <div className="app">
      <header className="app__header">
        <div>
          <h1>Менеджер элементов</h1>
        </div>
        <div className="status-line">
          <span>Выбрано: {selectedIds.length}</span>
          <span>Доступно: {availableTotal}</span>
        </div>
      </header>

      {statusMessage && <div className="status-banner">{statusMessage}</div>}

      <main className="panels">
        <section className="panel">
          <div className="panel__header panel__header--with-actions">
            <h2>Все элементы</h2>
            <form className="add-form" onSubmit={handleAddSubmit}>
              <input
                type="text"
                value={addValue}
                onChange={(event) => setAddValue(event.target.value)}
                placeholder="Новый ID"
              />
              <button type="submit">Добавить</button>
            </form>
          </div>
          <div className="filter">
            <input
              type="search"
              value={availableFilter}
              onChange={(event) => setAvailableFilter(event.target.value)}
              placeholder="Фильтр по ID"
            />
          </div>
          <ScrollList
            items={availableItems}
            renderItem={(id) => (
              <div key={id} className="row">
                <span>ID {id}</span>
                <button type="button" onClick={() => handleMoveToSelection(id)}>
                  Выбрать
                </button>
              </div>
            )}
            hasMore={availableHasMore}
            isLoading={availableLoading}
            emptyPlaceholder={availablePlaceholder}
            onLoadMore={handleAvailableLoadMore}
          />
        </section>

        <section className="panel">
          <div className="panel__header">
            <h2>Выбранные элементы</h2>
          </div>
          <div className="filter">
            <input
              type="search"
              value={selectedFilter}
              onChange={(event) => setSelectedFilter(event.target.value)}
              placeholder="Фильтр по выбранным ID"
            />
          </div>
          <ScrollList
            items={selectedItems}
            renderItem={(id) => (
              <div
                key={id}
                className={`row row--selected ${draggingId === id ? 'row--dragging' : ''}`}
                draggable
                onDragStart={(event) => handleDragStart(event, id)}
                onDragOver={(event) => handleDragOver(event, id)}
                onDragEnd={handleDragEnd}
              >
                <span>ID {id}</span>
                <div className="row__actions">
                  <button type="button" className="ghost" onClick={() => handleRemoveFromSelection(id)}>
                    Удалить
                  </button>
                </div>
              </div>
            )}
            hasMore={selectedHasMore}
            isLoading={selectionLoading || selectedListLoading}
            emptyPlaceholder={selectedPlaceholder}
            onLoadMore={handleSelectedLoadMore}
          />
        </section>
      </main>
    </div>
  )
}

export default App
