import { create } from 'zustand'
import type {
  SceneFormData,
  LedgerScene,
  Ledger,
  LedgerView,
  SaveResult,
  HydrateState,
} from '@/types'
import {
  commitAdd,
  commitUndo,
  runMigration,
  reduceLedger,
  peekLedger,
  getClientId,
  LEDGER_STORAGE_KEY,
} from '@/services/ledger'

interface SceneState extends HydrateState {
  /** 归并后的全部版本（冲突的两版都在），时间线使用 */
  scenes: LedgerScene[]
  /** 冲突信息（时间线标冲突用） */
  view: LedgerView
  routeNames: string[]
  currentRouteScenes: LedgerScene[]
  selectedRoute: string
  /** 灵感页当前抽到的（合并视图中的）窗景 */
  randomScene: LedgerScene | null
  /** 本标签页 id */
  clientId: string

  hydrate: () => Promise<void>
  /** 迁移中断后从游标继续补齐 */
  retryMigration: () => Promise<void>
  /** 保存；失败时返回原因，调用方保留表单原文 */
  saveScene: (data: SceneFormData) => Promise<SaveResult>
  /** 失败后用原 opId/时间戳重试 */
  retrySave: (data: SceneFormData, opId: string, timestamp: string) => Promise<SaveResult>
  undoScene: (versionId: string) => Promise<SaveResult>
  selectRoute: (routeName: string) => void
  refreshRandom: () => void
}

const emptyView: LedgerView = {
  scenes: [],
  mergedScenes: [],
  conflicts: { groups: [], byKey: new Map(), versionIds: new Set() },
}

function routeNamesOf(scenes: LedgerScene[]): string[] {
  return Array.from(new Set(scenes.map((s) => s.routeName))).sort()
}

let hydratePromise: Promise<void> | null = null

export const useSceneStore = create<SceneState>((set, get) => {
  const applyLedger = (ledger: Ledger, patch?: Partial<HydrateState>) => {
    const view = reduceLedger(ledger)
    set((state) => {
      const currentRouteScenes = state.selectedRoute
        ? view.scenes.filter((s) => s.routeName === state.selectedRoute)
        : []
      const randomScene =
        state.randomScene && view.mergedScenes.some((s) => s.versionId === state.randomScene?.versionId)
          ? state.randomScene
          : null
      return {
        scenes: view.scenes,
        view,
        routeNames: routeNamesOf(view.scenes),
        currentRouteScenes,
        randomScene,
        ...patch,
      }
    })
  }

  const internalSave = async (
    data: SceneFormData,
    opId: string,
    timestamp: string,
  ): Promise<SaveResult> => {
    const outcome = await commitAdd(data, { opId, timestamp, origin: get().clientId })
    if (outcome.ok && outcome.ledger) {
      applyLedger(outcome.ledger)
      return { ok: true, duplicate: outcome.duplicate, opId, timestamp }
    }
    // 保存失败：不更新任何本地状态（表单原文由页面保留），只把原因带回去
    return {
      ok: false,
      opId,
      timestamp,
      reason: outcome.reason,
      message: outcome.message,
    }
  }

  return {
    scenes: [],
    view: emptyView,
    routeNames: [],
    currentRouteScenes: [],
    selectedRoute: '',
    randomScene: null,
    clientId: getClientId(),
    loaded: false,
    migration: null,
    notice: null,

    hydrate: () => {
      if (!hydratePromise) {
        hydratePromise = get().retryMigration()
      }
      return hydratePromise
    },

    retryMigration: () =>
      (async () => {
        try {
          const result = await runMigration(({ done, total }) => {
            set({ migration: { status: 'running', done, total } })
          })
          applyLedger(result.ledger, {
            loaded: true,
            migration:
              result.total > 0
                ? {
                    status: 'done',
                    done: result.ledger.migration.cursor,
                    total: result.total,
                  }
                : null,
            notice: result.notice,
          })
        } catch (err) {
          const saveResult = (err as { saveResult?: SaveResult }).saveResult
          // 迁移中断（例如空间不足）：游标已随已完成批次落盘，下次重试从断点补齐
          const ledger = peekLedger()
          if (ledger) applyLedger(ledger)
          set({
            loaded: true,
            migration: {
              status: 'failed',
              done: ledger?.migration.cursor ?? 0,
              total: ledger?.migration.total ?? 0,
            },
            notice:
              saveResult?.message ??
              (err instanceof Error ? err.message : '旧数据迁移中断，将在下次打开时继续补齐'),
          })
        }
      })(),

    saveScene: (data) =>
      internalSave(data, crypto.randomUUID(), new Date().toISOString()),

    retrySave: (data, opId, timestamp) => internalSave(data, opId, timestamp),

    undoScene: async (versionId) => {
      try {
        const outcome = await commitUndo(versionId)
        if (outcome.ledger) applyLedger(outcome.ledger)
        return outcome.ok
          ? { ok: true, duplicate: outcome.duplicate }
          : { ok: false, reason: outcome.reason, message: outcome.message }
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : '撤销失败' }
      }
    },

    selectRoute: (routeName) => {
      const currentRouteScenes = routeName
        ? get().scenes.filter((s) => s.routeName === routeName)
        : []
      set({ selectedRoute: routeName, currentRouteScenes })
    },

    refreshRandom: () => {
      // 灵感页只用合并结果：冲突组里取最新版，旧版本不会被采到
      const pool = get().view.mergedScenes
      if (pool.length === 0) {
        set({ randomScene: null })
        return
      }
      const current = get().randomScene
      let next = pool[Math.floor(Math.random() * pool.length)]
      if (pool.length > 1 && current) {
        let guard = 0
        while (next.versionId === current.versionId && guard < 6) {
          next = pool[Math.floor(Math.random() * pool.length)]
          guard++
        }
      }
      set({ randomScene: next })
    },
  }
})

// 其它标签页写入后，本页实时合并（storage 事件只在别的标签页写时触发）
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== LEDGER_STORAGE_KEY || !event.newValue) return
    const ledger = peekLedger()
    if (ledger) {
      const state = useSceneStore.getState()
      if (!state.loaded) return
      const view = reduceLedger(ledger)
      useSceneStore.setState({
        scenes: view.scenes,
        view,
        routeNames: routeNamesOf(view.scenes),
        currentRouteScenes: state.selectedRoute
          ? view.scenes.filter((s) => s.routeName === state.selectedRoute)
          : [],
        randomScene:
          state.randomScene &&
          view.mergedScenes.some((s) => s.versionId === state.randomScene?.versionId)
            ? state.randomScene
            : null,
        // 其它标签页完成迁移时同步状态
        migration:
          state.migration?.status === 'running' && ledger.migration.status === 'done'
            ? { ...state.migration, status: 'done' as const, done: ledger.migration.cursor }
            : state.migration,
      })
    }
  })
}
