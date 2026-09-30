import { useEffect, useState } from 'react'
import { Search, Route, X, Trash2, Clock, MapPin, GitBranch, AlertTriangle } from 'lucide-react'
import { useSceneStore } from '@/store/useSceneStore'
import { useToast } from '@/components/Toast'
import {
  formatTimestamp,
  getTimeOfDay,
  getWeatherIcon,
  getTreeIcon,
  getPedestrianIcon,
} from '@/utils/sceneHelpers'
import type { SceneGroup } from '@/services/ledger'

export default function TimelinePage() {
  const {
    routeNames,
    selectedRoute,
    currentRouteGroups,
    selectRoute,
    loadAll,
    deleteScene,
  } = useSceneStore()
  const { showToast } = useToast()
  const [search, setSearch] = useState('')
  const [detailKey, setDetailKey] = useState<string | null>(null)

  useEffect(() => {
    loadAll()
  }, [loadAll])

  const filteredRoutes = routeNames.filter((r) =>
    r.toLowerCase().includes(search.toLowerCase())
  )

  // 删除某一版本后，分组可能消失；弹窗跟随最新分组，分组不存在则关闭
  const detailGroup: SceneGroup | null =
    currentRouteGroups.find((g) => g.key === detailKey) ?? null
  useEffect(() => {
    if (detailKey && !detailGroup) setDetailKey(null)
  }, [detailKey, detailGroup])

  const handleDeleteVersion = (sceneId: string) => {
    const result = deleteScene(sceneId)
    if (result.ok === false) {
      showToast({ kind: 'error', message: result.reason })
      return
    }
    showToast({ kind: 'info', message: '已删除该版本' })
  }

  return (
    <div className="min-h-screen bg-teal-950 font-serif text-mist-100">
      <div className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="mb-6 text-3xl font-bold tracking-wide text-dusk-400">
          窗景时间线
        </h1>

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

        {currentRouteGroups.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-mist-400">
            <div className="mb-4 text-6xl opacity-30">🪟</div>
            <p className="text-lg">
              {selectedRoute ? '该路线暂无窗景记录' : '选择一条路线，开始浏览窗景'}
            </p>
          </div>
        ) : (
          <div className="relative pl-8">
            <div className="absolute left-3 top-0 bottom-0 w-px bg-teal-800" />
            <div className="space-y-6">
              {currentRouteGroups.map((group) => {
                const scene = group.canonical
                return (
                  <div key={group.key} className="relative flex gap-4">
                    <div className="absolute -left-5 top-1 h-2.5 w-2.5 rounded-full bg-dusk-400 ring-4 ring-teal-950" />
                    <div className="w-20 shrink-0 pt-0.5 text-right">
                      <p className="text-xs text-dusk-400">
                        {formatTimestamp(scene.timestamp)}
                      </p>
                      <p className="mt-0.5 text-[10px] text-mist-500">
                        {getTimeOfDay(scene.timestamp)}
                      </p>
                    </div>
                    <button
                      onClick={() => setDetailKey(group.key)}
                      className="group flex-1 rounded-xl border border-teal-800 bg-teal-900/50 p-4 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-dusk-400/40 hover:shadow-lg hover:shadow-dusk-400/10"
                    >
                      <div className="flex items-center gap-2 mb-2 flex-wrap">
                        {getWeatherIcon(scene.weather)}
                        <span className="text-sm font-semibold text-mist-100">
                          {scene.segment}
                        </span>
                        {group.conflict && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-amber-400/15 px-2 py-0.5 text-[10px] font-medium text-amber-300 ring-1 ring-amber-400/30">
                            <GitBranch className="w-3 h-3" />
                            冲突 · {group.versions.length} 版
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1 mb-1.5 text-mist-400">
                        <MapPin className="w-3 h-3" />
                        <span className="text-xs">{scene.routeName}</span>
                        <span className="mx-1 text-teal-700">·</span>
                        <span className="text-xs">{scene.seatDirection}侧</span>
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
                        {group.conflict && (
                          <span className="ml-auto text-[10px] text-amber-300/80">
                            两版记录不一致，点击查看
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

      {detailGroup && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={() => setDetailKey(null)}
        >
          <div
            className="relative mx-4 w-full max-w-md animate-scale-in rounded-2xl border border-teal-700 bg-teal-900 p-6 shadow-2xl max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setDetailKey(null)}
              className="absolute right-4 top-4 text-mist-400 hover:text-mist-100 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="mb-4 flex items-center gap-3">
              {getWeatherIcon(detailGroup.canonical.weather)}
              <h2 className="text-xl font-bold text-dusk-400">
                {detailGroup.canonical.segment}
              </h2>
            </div>

            {detailGroup.conflict && (
              <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2.5 text-xs leading-relaxed text-amber-200">
                <AlertTriangle className="mt-0.5 w-4 h-4 shrink-0 text-amber-300" />
                <p>
                  两个标签页记录了同一段窗景，但内容不一致。两版均已保留，
                  灵感页仅采用合并结果；你可以删除不需要的版本。
                </p>
              </div>
            )}

            <div className="space-y-4">
              {detailGroup.versions.map((version, idx) => (
                <div
                  key={version.id}
                  className={`rounded-xl border p-4 ${
                    idx === 0
                      ? 'border-dusk-400/40 bg-teal-800/40'
                      : 'border-teal-700 bg-teal-900/40'
                  }`}
                >
                  <div className="mb-3 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Clock className="w-3.5 h-3.5 text-dusk-400" />
                      <span className="text-xs text-mist-300">
                        {formatTimestamp(version.timestamp)}
                      </span>
                      <span className="text-teal-600">·</span>
                      <span className="text-xs text-mist-400">
                        {getTimeOfDay(version.timestamp)}
                      </span>
                    </div>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] ${
                        idx === 0
                          ? 'bg-dusk-400/20 text-dusk-300'
                          : 'bg-teal-800 text-mist-400'
                      }`}
                    >
                      {idx === 0 ? '合并版' : `版本 ${idx + 1}`}
                    </span>
                  </div>

                  <div className="space-y-2 text-sm">
                    <div className="flex items-center gap-2 text-mist-300">
                      <MapPin className="w-4 h-4 text-dusk-400" />
                      <span>{version.routeName}</span>
                      <span className="text-teal-600">·</span>
                      <span>{version.seatDirection}侧</span>
                    </div>
                    <div className="flex items-center gap-3 text-mist-300">
                      {getTreeIcon(version.treeDensity)}
                      <span>{version.treeDensity}</span>
                      {getPedestrianIcon(version.pedestrianStatus)}
                      <span>{version.pedestrianStatus}</span>
                    </div>
                    {version.signText && (
                      <div className="rounded-lg bg-teal-800/50 px-3 py-2 text-mist-200">
                        招牌: {version.signText}
                      </div>
                    )}
                    {version.note && (
                      <div className="rounded-lg border border-teal-800 px-3 py-2 text-mist-300">
                        {version.note}
                      </div>
                    )}
                  </div>

                  <button
                    onClick={() => handleDeleteVersion(version.id)}
                    className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-red-900/40 py-2 text-xs text-red-300 transition-colors hover:bg-red-900/60"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    删除此版本
                  </button>
                </div>
              ))}
            </div>

            <button
              onClick={() => setDetailKey(null)}
              className="mt-5 w-full rounded-lg bg-teal-800/60 py-2.5 text-sm text-mist-300 transition-colors hover:bg-teal-800"
            >
              关闭
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
