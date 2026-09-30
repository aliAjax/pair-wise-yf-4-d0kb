import { create } from 'zustand'
import type { WindowScene, SceneFormData, ActionResult } from '@/types'
import {
  type Operation,
  type SceneGroup,
  loadLedger,
  saveLedger,
  appendOp,
  reduceOps,
  unionOps,
  migrateLegacyIfNeeded,
  newClientId,
  sceneKeyOf,
  contentKey,
  getLedgerKey,
} from '@/services/ledger'

interface SceneState {
  /** 合并后的标准窗景（灵感页只使用它） */
  scenes: WindowScene[]
  /** 场景分组（时间线页使用，含冲突信息） */
  groups: SceneGroup[]
  routeNames: string[]
  selectedRoute: string
  currentRouteGroups: SceneGroup[]
  randomScene: WindowScene | null
  /** 最近一次保存失败的原因（供页面提示） */
  lastError: string | null
  /** 最近一次保存的场景（供撤销）：opSceneId 是本次提交的版本，canonicalSceneId 是合并结果 */
  lastSaved: { opSceneId: string; canonicalSceneId: string } | null
  syncStarted: boolean

  loadAll: () => void
  saveScene: (data: SceneFormData) => ActionResult
  undoLastSave: () => ActionResult
  deleteScene: (id: string) => ActionResult
  selectRoute: (routeName: string) => void
  refreshRandom: () => void
  clearLastError: () => void
  _syncFromRemote: () => void
}

/** 本标签页已知的全部操作（写入成功后才替换，失败即回滚） */
let knownOps: Operation[] = []
const clientId = newClientId()
let syncListenerStarted = false

function groupsForRoute(groups: SceneGroup[], routeName: string): SceneGroup[] {
  if (!routeName) return groups
  return groups.filter((g) => g.canonical.routeName === routeName)
}

function routeNamesOf(groups: SceneGroup[]): string[] {
  return Array.from(new Set(groups.map((g) => g.canonical.routeName).filter(Boolean))).sort()
}

export const useSceneStore = create<SceneState>((set, get) => ({
  scenes: [],
  groups: [],
  routeNames: [],
  selectedRoute: '',
  currentRouteGroups: [],
  randomScene: null,
  lastError: null,
  lastSaved: null,
  syncStarted: false,

  loadAll: () => {
    // 首次启动迁移旧数据；中断后再次启动会继续补齐
    migrateLegacyIfNeeded()
    const ledger = loadLedger()
    knownOps = ledger.ops
    const { scenes, groups } = reduceOps(knownOps)
    set({
      scenes,
      groups,
      routeNames: routeNamesOf(groups),
      currentRouteGroups: groupsForRoute(groups, get().selectedRoute),
    })
    if (!syncListenerStarted) {
      syncListenerStarted = true
      window.addEventListener('storage', (e) => {
        // 其他标签页写入了台账（或清空）→ 合并远端日志
        if (e.key === getLedgerKey() || e.key === null) {
          get()._syncFromRemote()
        }
      })
    }
  },

  saveScene: (data) => {
    const scene: WindowScene = {
      ...data,
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
    }
    const op: Operation = {
      opId: crypto.randomUUID(),
      type: 'add',
      sceneId: scene.id,
      scene,
      sceneKey: sceneKeyOf(scene),
      fingerprint: contentKey(scene),
      clientId,
      ts: Date.now(),
    }
    const result = appendOp(op, knownOps)
    if (result.ok === false) {
      // 写入失败：knownOps 未变，内容原样保留，仅上报原因
      set({ lastError: result.reason })
      return result
    }
    knownOps = result.ops
    const { scenes, groups } = reduceOps(knownOps)
    set((state) => ({
      scenes,
      groups,
      routeNames: routeNamesOf(groups),
      currentRouteGroups: groupsForRoute(groups, state.selectedRoute),
      lastSaved: { opSceneId: result.opSceneId, canonicalSceneId: result.canonicalSceneId },
      lastError: null,
      randomScene:
        state.randomScene && scenes.some((s) => s.id === state.randomScene!.id)
          ? state.randomScene
          : null,
    }))
    return { ok: true, sceneId: result.canonicalSceneId }
  },

  undoLastSave: () => {
    const last = get().lastSaved
    if (!last) return { ok: false, reason: '没有可撤销的保存记录' }
    // 撤销目标：本次提交的版本若仍存活（新场景/冲突版本）则删它；
    // 若已被去重（重复提交）则删合并结果（整个场景）
    const opIsLive = get().groups.some((g) =>
      g.versions.some((v) => v.id === last.opSceneId)
    )
    const targetId = opIsLive ? last.opSceneId : last.canonicalSceneId
    const op: Operation = {
      opId: crypto.randomUUID(),
      type: 'delete',
      sceneId: targetId,
      clientId,
      ts: Date.now(),
    }
    const result = appendOp(op, knownOps)
    if (result.ok === false) {
      set({ lastError: result.reason })
      return result
    }
    knownOps = result.ops
    const { scenes, groups } = reduceOps(knownOps)
    set((state) => ({
      scenes,
      groups,
      routeNames: routeNamesOf(groups),
      currentRouteGroups: groupsForRoute(groups, state.selectedRoute),
      lastSaved: null,
      lastError: null,
      randomScene: state.randomScene?.id === targetId ? null : state.randomScene,
    }))
    return { ok: true, sceneId: targetId }
  },

  deleteScene: (id) => {
    const op: Operation = {
      opId: crypto.randomUUID(),
      type: 'delete',
      sceneId: id,
      clientId,
      ts: Date.now(),
    }
    const result = appendOp(op, knownOps)
    if (result.ok === false) {
      set({ lastError: result.reason })
      return result
    }
    knownOps = result.ops
    const { scenes, groups } = reduceOps(knownOps)
    set((state) => ({
      scenes,
      groups,
      routeNames: routeNamesOf(groups),
      currentRouteGroups: groupsForRoute(groups, state.selectedRoute),
      lastError: null,
      randomScene: state.randomScene?.id === id ? null : state.randomScene,
    }))
    return { ok: true, sceneId: id }
  },

  selectRoute: (routeName) => {
    set((state) => ({
      selectedRoute: routeName,
      currentRouteGroups: groupsForRoute(state.groups, routeName),
    }))
  },

  refreshRandom: () => {
    const scenes = get().scenes
    if (scenes.length === 0) {
      set({ randomScene: null })
      return
    }
    const pick = () => scenes[Math.floor(Math.random() * scenes.length)]
    let next = pick()
    if (scenes.length > 1) {
      while (next.id === get().randomScene?.id) next = pick()
    }
    set({ randomScene: next })
  },

  clearLastError: () => set({ lastError: null }),

  _syncFromRemote: () => {
    const remote = loadLedger()
    const merged = unionOps(knownOps, remote.ops)
    // 修复：若远端缺少本标签页已知的操作（并发覆盖），写回并集
    if (merged.length !== remote.ops.length) {
      try {
        saveLedger({ version: 1, ops: merged })
      } catch {
        /* 修复失败可忽略，后续写入会再次合并 */
      }
    }
    knownOps = merged
    const { scenes, groups } = reduceOps(knownOps)
    set((state) => ({
      scenes,
      groups,
      routeNames: routeNamesOf(groups),
      currentRouteGroups: groupsForRoute(groups, state.selectedRoute),
      randomScene:
        state.randomScene && scenes.some((s) => s.id === state.randomScene!.id)
          ? state.randomScene
          : null,
    }))
  },
}))
