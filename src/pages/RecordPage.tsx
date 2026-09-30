import { useState, useEffect, useRef } from 'react'
import { Bus, MapPin, Armchair, Clock, CloudSun, Signpost, TreePine, Users, FileText, Send, AlertTriangle, Loader2, CopyCheck, RefreshCw } from 'lucide-react'
import { useSceneStore } from '@/store/useSceneStore'
import { getWeatherIcon, getTreeIcon, getPedestrianIcon, formatTimestamp } from '@/utils/sceneHelpers'
import type { SceneFormData, Weather, TreeDensity, PedestrianStatus, SeatDirection } from '@/types'

const WEATHERS: Weather[] = ['晴', '多云', '阴', '小雨', '大雨', '雪', '雾']
const TREES: TreeDensity[] = ['稀疏', '适中', '茂密']
const PEDESTRIANS: PedestrianStatus[] = ['稀少', '零星', '密集']

const initialForm: SceneFormData = {
  routeName: '',
  segment: '',
  seatDirection: '左',
  weather: '晴',
  signText: '',
  treeDensity: '适中',
  pedestrianStatus: '稀少',
  note: '',
}

export default function RecordPage() {
  const saveScene = useSceneStore((s) => s.saveScene)
  const retrySave = useSceneStore((s) => s.retrySave)
  const hydrate = useSceneStore((s) => s.hydrate)
  const retryMigration = useSceneStore((s) => s.retryMigration)
  const migration = useSceneStore((s) => s.migration)
  const notice = useSceneStore((s) => s.notice)
  const loaded = useSceneStore((s) => s.loaded)

  const [form, setForm] = useState<SceneFormData>(initialForm)
  const [now, setNow] = useState(new Date())
  const [saving, setSaving] = useState(false)
  const [success, setSuccess] = useState(false)
  const [duplicate, setDuplicate] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 最近一次失败提交的句柄，用于“原样重试” */
  const pendingRef = useRef<{ opId: string; timestamp: string } | null>(null)
  const successTimer = useRef<number | null>(null)

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    return () => {
      if (successTimer.current) window.clearTimeout(successTimer.current)
    }
  }, [])

  const update = <K extends keyof SceneFormData>(key: K, val: SceneFormData[K]) => {
    setForm((prev) => ({ ...prev, [key]: val }))
    // 内容改动后，失败句柄已不再对应“原内容”，改为普通提交
    if (pendingRef.current && error) {
      pendingRef.current = null
      setError(null)
    }
  }

  const showSuccessToast = (isDuplicate: boolean) => {
    setDuplicate(isDuplicate)
    setSuccess(true)
    if (successTimer.current) window.clearTimeout(successTimer.current)
    successTimer.current = window.setTimeout(() => {
      setSuccess(false)
      setDuplicate(false)
      setForm(initialForm)
      pendingRef.current = null
    }, 1500)
  }

  const submitForm = async () => {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      const pending = pendingRef.current
      // 有失败句柄时走重试（复用 opId/时间戳），否则新建一次提交
      const result = pending
        ? await retrySave(form, pending.opId, pending.timestamp)
        : await saveScene(form)

      if (result.ok) {
        showSuccessToast(Boolean(result.duplicate))
      } else {
        // 保存失败：表单原文完整保留，说明原因并允许重试
        setError(result.message ?? '保存失败，原内容已保留。')
        if (result.opId && result.timestamp) {
          pendingRef.current = { opId: result.opId, timestamp: result.timestamp }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? `${err.message}，原内容已保留。` : '保存失败，原内容已保留。')
    } finally {
      setSaving(false)
    }
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    void submitForm()
  }

  return (
    <div className="relative min-h-screen bg-teal-950 p-4 pb-24">
      {success && (
        <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
          <div className="animate-bounce flex flex-col items-center gap-2 opacity-0" style={{ animation: 'fadeInUp 1.5s ease forwards' }}>
            {duplicate ? <CopyCheck className="w-16 h-16 text-mist-300" /> : <Bus className="w-16 h-16 text-dusk-400" />}
            <span className="text-mist-100 font-serif text-lg">
              {duplicate ? '这段窗景已在台账中，未重复保存' : '记录已保存'}
            </span>
          </div>
          <style>{`@keyframes fadeInUp { 0% { opacity:0; transform:translateY(20px) } 40% { opacity:1; transform:translateY(0) } 100% { opacity:0; transform:translateY(-40px) } }`}</style>
        </div>
      )}

      <form onSubmit={handleSubmit} className="mx-auto max-w-lg space-y-6">
        <div className="flex items-center gap-2 mb-2">
          <Bus className="w-6 h-6 text-dusk-400" />
          <h1 className="text-mist-100 font-serif text-2xl">窗景记录</h1>
        </div>

        {migration && migration.status === 'running' && (
          <div className="rounded-xl border border-dusk-400/30 bg-dusk-400/10 px-4 py-3">
            <p className="text-xs text-dusk-300 mb-2 flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              正在迁移已有窗景 {migration.done}/{migration.total}（中断会自动续传）
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
          <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3">
            <p className="text-xs text-amber-200 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              旧数据迁移在第 {migration.done}/{migration.total} 条处中断，已保留进度，不会重复迁移。
            </p>
            <button
              type="button"
              onClick={() => void retryMigration()}
              className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-amber-400/40 px-3 py-1.5 text-xs text-amber-200 hover:bg-amber-500/10 transition-colors"
            >
              <RefreshCw className="w-3 h-3" />继续补齐
            </button>
          </div>
        )}

        {notice && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-200 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{notice}</span>
          </div>
        )}

        {error && (
          <div className="rounded-xl border border-red-500/40 bg-red-900/20 px-4 py-3">
            <p className="text-xs text-red-300 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </p>
            {pendingRef.current && (
              <button
                type="button"
                onClick={() => void submitForm()}
                className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-red-400/40 px-3 py-1.5 text-xs text-red-200 hover:bg-red-900/30 transition-colors"
              >
                <RefreshCw className="w-3 h-3" />用原内容重试
              </button>
            )}
          </div>
        )}

        <section className="space-y-3">
          <h2 className="text-dusk-400 font-serif text-lg flex items-center gap-2">
            <MapPin className="w-4 h-4" />路线信息
          </h2>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-mist-300 text-xs mb-1 flex items-center gap-1"><Bus className="w-3 h-3" />线路</label>
              <input className="w-full bg-teal-850 text-mist-100 rounded-xl px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-dusk-400" value={form.routeName} onChange={(e) => update('routeName', e.target.value)} required />
            </div>
            <div>
              <label className="text-mist-300 text-xs mb-1 flex items-center gap-1"><MapPin className="w-3 h-3" />区间</label>
              <input className="w-full bg-teal-850 text-mist-100 rounded-xl px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-dusk-400" value={form.segment} onChange={(e) => update('segment', e.target.value)} required />
            </div>
          </div>
          <div>
            <label className="text-mist-300 text-xs mb-1 flex items-center gap-1"><Armchair className="w-3 h-3" />座位方向</label>
            <div className="flex gap-2">
              {(['左', '右'] as SeatDirection[]).map((d) => (
                <button key={d} type="button" onClick={() => update('seatDirection', d)}
                  className={`flex-1 py-2 rounded-xl text-sm font-medium transition ${form.seatDirection === d ? 'bg-dusk-400/20 text-dusk-400 border border-dusk-400' : 'bg-teal-850 text-mist-300 border border-transparent'}`}>
                  {d}侧
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-dusk-400 font-serif text-lg flex items-center gap-2">
            <CloudSun className="w-4 h-4" />窗景信息
          </h2>
          <div>
            <label className="text-mist-300 text-xs mb-1 block">天气</label>
            <div className="grid grid-cols-4 gap-2">
              {WEATHERS.map((w) => (
                <button key={w} type="button" onClick={() => update('weather', w)}
                  className={`flex flex-col items-center gap-1 py-2 rounded-xl text-xs transition ${form.weather === w ? 'bg-dusk-400/20 border border-dusk-400 text-dusk-400' : 'bg-teal-850 border border-transparent text-mist-300'}`}>
                  {getWeatherIcon(w)}{w}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-mist-300 text-xs mb-1 flex items-center gap-1"><Signpost className="w-3 h-3" />招牌文字</label>
            <input className="w-full bg-teal-850 text-mist-100 rounded-xl px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-dusk-400" value={form.signText} onChange={(e) => update('signText', e.target.value)} />
          </div>
          <div>
            <label className="text-mist-300 text-xs mb-1 flex items-center gap-1"><TreePine className="w-3 h-3" />树木密度</label>
            <div className="grid grid-cols-3 gap-2">
              {TREES.map((t) => (
                <button key={t} type="button" onClick={() => update('treeDensity', t)}
                  className={`flex flex-col items-center gap-1 py-3 rounded-xl text-xs transition ${form.treeDensity === t ? 'bg-dusk-400/20 border border-dusk-400 text-dusk-400' : 'bg-teal-850 border border-transparent text-mist-300'}`}>
                  {getTreeIcon(t)}{t}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-mist-300 text-xs mb-1 flex items-center gap-1"><Users className="w-3 h-3" />行人状态</label>
            <div className="grid grid-cols-3 gap-2">
              {PEDESTRIANS.map((p) => (
                <button key={p} type="button" onClick={() => update('pedestrianStatus', p)}
                  className={`flex flex-col items-center gap-1 py-3 rounded-xl text-xs transition ${form.pedestrianStatus === p ? 'bg-dusk-400/20 border border-dusk-400 text-dusk-400' : 'bg-teal-850 border border-transparent text-mist-300'}`}>
                  {getPedestrianIcon(p)}{p}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-dusk-400 font-serif text-lg flex items-center gap-2">
            <FileText className="w-4 h-4" />观察笔记
          </h2>
          <textarea className="w-full bg-teal-850 text-mist-100 rounded-xl px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-dusk-400 resize-none h-24" value={form.note} onChange={(e) => update('note', e.target.value)} />
        </section>

        <div className="flex items-center gap-2 text-mist-400 text-xs">
          <Clock className="w-3 h-3" />
          <span>{formatTimestamp(now.toISOString())}</span>
        </div>

        <button type="submit" disabled={saving || !loaded}
          className="w-full py-3 rounded-xl bg-dusk-400 text-teal-950 font-medium text-sm flex items-center justify-center gap-2 active:scale-[0.98] transition disabled:opacity-50 disabled:active:scale-100">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          {saving ? '正在写入台账…' : '保存记录'}
        </button>
      </form>
    </div>
  )
}
