import { useEffect, useState } from 'react'
import { Search, Route, X, Undo2, Clock, MapPin, GitBranch, AlertTriangle, Loader2 } from 'lucide-react'
import { useSceneStore } from '@/store/useSceneStore'
import {
  formatTimestamp,
  getTimeOfDay,
  getWeatherIcon,
  getTreeIcon,
  getPedestrianIcon,
} from '@/utils/sceneHelpers'
import type { LedgerScene } from '@/types'
import { MIGRATION_ORIGIN } from '@/services/ledger'

export default function TimelinePage() {
  const {
    routeNames,
    selectedRoute,
    currentRouteScenes,
    selectRoute,
    hydrate,
    retryMigration,
    undoScene,
    view,
    clientId,
    migration,
    notice,
  } = useSceneStore()
  const [search, setSearch] = useState('')
  const [detailScene, setDetailScene] = useState<LedgerScene | null>(null)
  const [conflictOnly, setConflictOnly] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  // 其它标签页撤销了弹窗里正在看的版本时，关闭弹窗
  useEffect(() => {
    if (!detailScene) return
    if (!view.scenes.some((s) => s.versionId === detailScene.versionId)) {
      setDetailScene(null)
    }
  }, [detailScene, view.scenes])

  const filteredRoutes = routeNames.filter((r) =>
    r.toLowerCase().includes(search.toLowerCase())
  )

  const base = selectedRoute
    ? currentRouteScenes
    : view.scenes
  const conflictIds = view.conflicts.versionIds
  const sorted = (conflictOnly ? base.filter((s) => conflictIds.has(s.versionId)) : base).sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  )

  const originLabel = (scene: LedgerScene, merged: boolean) => {
    if (scene.origin === MIGRATION_ORIGIN) return '旧数据迁移'
    return scene.origin === clientId ? '本标签页' : merged ? '另一标签页（采用）' : '另一标签页'
  }

  const handleUndo = async (versionId: string) => {
    setBusyId(versionId)
    setActionError(null)
    const result = await undoScene(versionId)
    setBusyId(null)
    if (!result.ok) {
      setActionError(result.message ?? '撤销失败，内容未改动。')
      return
    }
    setDetailScene(null)
  }

  const detailConflict = detailScene
    ? view.conflicts.byKey.get(detailScene.conflictKey)
    : undefined

  return (
    <div className="min-h-screen bg-teal-950 font-serif text-mist-100">
      <div className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="mb-6 text-3xl font-bold tracking-wide text-dusk-400">
          窗景时间线
        </h1>

        {migration && migration.status === 'running' && (
          <div className="mb-4 rounded-xl border border-dusk-400/30 bg-dusk-400/10 px-4 py-3">
            <p className="text-xs text-dusk-300 mb-2 flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              正在迁移已有窗景 {migration.done}/{migration.total}
            </p>
            <div className="h-1 rounded-full bg-teal-800 overflow-hidden">
              <div
                className="h-full bg-dusk-400 transition-all"
                style={{ width: `${migration.total ? (migration.done / migration.total) * 100 : 0}%` }}
              />
            </div>
          </div>
        )}

        {migration && migration.status === 'failed' && (
          <div className="mb-4 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3">
            <p className="text-xs text-amber-200 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              旧数据迁移在第 {migration.done}/{migration.total} 条处中断，已保留进度。
            </p>
            <button
              onClick={() => void retryMigration()}
              className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-amber-400/40 px-3 py-1.5 text-xs text-amber-200 hover:bg-amber-500/10 transition-colors"
            >
              <Undo2 className="w-3 h-3" />继续补齐
            </button>
          </div>
        )}

        {notice && (
          <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-200 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{notice}</span>
          </div>
        )}

        {actionError && (
          <div className="mb-4 rounded-xl border border-red-500/40 bg-red-900/20 px-4 py-3 text-xs text-red-300 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{actionError}</span>
          </div>
        )}

        <div className="mb-6 space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 w-4 h-4 -translate-y-1/2 text-mist-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索路线..."
              className="w-full rounded-lg border border-teal-800 bg-teal-900/60 py-2.5 pl-10 pr-4 text-sm text-mist-100 placeholder:text-mist-500 focus:border-dusk-400 focus:outline-none"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => selectRoute('')}
              className={`rounded-full px-3.5 py-1.5 text-xs transition-colors ${
                !selectedRoute
                  ? 'bg-dusk-400 text-teal-950'
                  : 'bg-teal-900 text-mist-300 hover:bg-teal-800'
              }`}
            >
              全部
            </button>
            <button
              onClick={() => setConflictOnly((v) => !v)}
              className={`rounded-full px-3.5 py-1.5 text-xs transition-colors flex items-center gap-1 ${
                conflictOnly
                  ? 'bg-amber-500 text-teal-950'
                  : 'bg-teal-900 text-amber-300/80 hover:bg-teal-800 border border-amber-500/30'
              }`}
            >
              <GitBranch className="w-3 h-3" />
              仅看冲突{conflictIds.size > 0 && !conflictOnly ? ` (${view.conflicts.groups.length})` : ''}
            </button>
            {filteredRoutes.map((name) => (
              <button
                key={name}
                onClick={() => selectRoute(name)}
                className={`rounded-full px-3.5 py-1.5 text-xs transition-colors ${
                  selectedRoute === name
                    ? 'bg-dusk-400 text-teal-950'
                    : 'bg-teal-900 text-mist-300 hover:bg-teal-800'
                }`}
              >
                <Route className="mr-1 inline w-3 h-3" />
                {name}
              </button>
            ))}
          </div>
        </div>

        {sorted.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-mist-400">
            <div className="mb-4 text-6xl opacity-30">🪟</div>
            <p className="text-lg">
              {conflictOnly
                ? '当前没有待处理的冲突窗景'
                : selectedRoute
                  ? '该路线暂无窗景记录'
                  : '选择一条路线，开始浏览窗景'}
            </p>
          </div>
        ) : (
          <div className="relative pl-8">
            <div className="absolute left-3 top-0 bottom-0 w-px bg-teal-800" />
            <div className="space-y-6">
              {sorted.map((scene) => {
                const conflict = view.conflicts.byKey.get(scene.conflictKey)
                const isConflict = Boolean(conflict)
                const isMerged = conflict?.merged.versionId === scene.versionId
                return (
                  <div key={scene.versionId} className="relative flex gap-4">
                    <div
                      className={`absolute -left-5 top-1 h-2.5 w-2.5 rounded-full ring-4 ring-teal-950 ${
                        isConflict ? 'bg-amber-500' : 'bg-dusk-400'
                      }`}
                    />
                    <div className="w-20 shrink-0 pt-0.5 text-right">
                      <p className="text-xs text-dusk-400">
                        {formatTimestamp(scene.timestamp)}
                      </p>
                      <p className="mt-0.5 text-[10px] text-mist-500">
                        {getTimeOfDay(scene.timestamp)}
                      </p>
                    </div>
                    <button
                      onClick={() => setDetailScene(scene)}
                      className={`group flex-1 rounded-xl border p-4 text-left transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg ${
                        isConflict
                          ? 'border-amber-500/50 bg-amber-500/5 hover:border-amber-400 hover:shadow-amber-500/10'
                          : 'border-teal-800 bg-teal-900/50 hover:border-dusk-400/40 hover:shadow-dusk-400/10'
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-2 flex-wrap">
                        {getWeatherIcon(scene.weather)}
                        <span className="text-sm font-semibold text-mist-100">
                          {scene.segment}
                        </span>
                        {isConflict && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 border border-amber-500/40 px-2 py-0.5 text-[10px] text-amber-300">
                            <GitBranch className="w-3 h-3" />
                            冲突 · {conflict!.versions.length} 版
                            {isMerged ? ' · 已采用此版' : ' · 保留待裁'}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1 mb-1.5 text-mist-400">
                        <MapPin className="w-3 h-3" />
                        <span className="text-xs">{scene.routeName}</span>
                        <span className="mx-1 text-teal-700">·</span>
                        <span className="text-xs">{scene.seatDirection}侧</span>
                        <span className="mx-1 text-teal-700">·</span>
                        <span className="text-[10px] text-mist-500">{originLabel(scene, isMerged)}</span>
                      </div>
                      {scene.note && (
                        <p className="text-xs text-mist-400 line-clamp-2">
                          {scene.note}
                        </p>
                      )}
                      <div className="mt-2 flex items-center gap-2">
                        {getTreeIcon(scene.treeDensity)}
                        {getPedestrianIcon(scene.pedestrianStatus)}
                        {scene.signText && (
                          <span className="rounded bg-teal-800/60 px-1.5 py-0.5 text-[10px] text-mist-300">
                            {scene.signText}
                          </span>
                        )}
                      </div>
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {detailScene && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={() => setDetailScene(null)}
        >
          <div
            className="relative mx-4 w-full max-w-md max-h-[85vh] overflow-y-auto animate-scale-in rounded-2xl border border-teal-700 bg-teal-900 p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setDetailScene(null)}
              className="absolute right-4 top-4 text-mist-400 hover:text-mist-100 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>

            {detailConflict && (
              <div className="mb-4 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3">
                <p className="text-xs text-amber-300 flex items-center gap-1.5 mb-2">
                  <GitBranch className="w-3.5 h-3.5" />
                  两个标签页同段窗景各存了一版，已全部保留；时间最新的一版用于灵感页。
                </p>
                <p className="text-[10px] text-amber-200/70">
                  撤销不需要的版本后冲突即消除。
                </p>
              </div>
            )}

            {(detailConflict ? detailConflict.versions : [detailScene]).map((scene, idx, all) => {
              const isMerged = detailConflict?.merged.versionId === scene.versionId
              return (
                <div
                  key={scene.versionId}
                  className={`rounded-xl p-4 ${all.length > 1 ? 'border border-teal-800 bg-teal-950/40 mb-3 last:mb-0' : ''}`}
                >
                  {all.length > 1 && (
                    <div className="mb-3 flex items-center justify-between text-[11px]">
                      <span className={`rounded-full px-2 py-0.5 ${isMerged ? 'bg-amber-500/20 text-amber-300' : 'bg-teal-800 text-mist-400'}`}>
                        {isMerged ? '✓ 灵感页采用版' : '保留版本'}
                      </span>
                      <span className="text-mist-500">{originLabel(scene, isMerged)}</span>
                    </div>
                  )}

                  <div className="mb-4 flex items-center gap-3">
                    {getWeatherIcon(scene.weather)}
                    <h2 className="text-xl font-bold text-dusk-400">{scene.segment}</h2>
                  </div>

                  <div className="space-y-3 text-sm">
                    <div className="flex items-center gap-2 text-mist-300">
                      <MapPin className="w-4 h-4 text-dusk-400" />
                      <span>{scene.routeName}</span>
                      <span className="text-teal-600">·</span>
                      <span>{scene.seatDirection}侧</span>
                    </div>
                    <div className="flex items-center gap-2 text-mist-300">
                      <Clock className="w-4 h-4 text-dusk-400" />
                      <span>{formatTimestamp(scene.timestamp)}</span>
                      <span className="text-teal-600">·</span>
                      <span>{getTimeOfDay(scene.timestamp)}</span>
                    </div>
                    <div className="flex items-center gap-3 text-mist-300">
                      {getTreeIcon(scene.treeDensity)}
                      <span>{scene.treeDensity}</span>
                      {getPedestrianIcon(scene.pedestrianStatus)}
                      <span>{scene.pedestrianStatus}</span>
                    </div>
                    {scene.signText && (
                      <div className="rounded-lg bg-teal-800/50 px-3 py-2 text-mist-200">
                        招牌: {scene.signText}
                      </div>
                    )}
                    {scene.note && (
                      <div className="rounded-lg border border-teal-800 px-3 py-2 text-mist-300">
                        {scene.note}
                      </div>
                    )}
                  </div>

                  <button
                    onClick={() => void handleUndo(scene.versionId)}
                    disabled={busyId === scene.versionId}
                    className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-red-900/40 py-2.5 text-sm text-red-300 transition-colors hover:bg-red-900/60 disabled:opacity-50"
                  >
                    {busyId === scene.versionId ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Undo2 className="w-4 h-4" />
                    )}
                    撤销此版本（可追溯）
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
