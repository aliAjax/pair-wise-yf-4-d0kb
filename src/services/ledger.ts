import type {
  WindowScene,
  SceneFormData,
  LedgerScene,
  SceneOp,
  Ledger,
  SaveResult,
  SaveFailReason,
  LedgerView,
  LedgerConflicts,
} from '@/types'

/**
 * 窗景记录本地台账
 *
 * 设计要点：
 * - 事实来源是操作日志 ops（add / undo 一律追加），读取时再归并，
 *   多标签页不再“读全量-改-写全量”互相覆盖。
 * - 写入经跨标签页互斥锁串行化（Web Locks，不可用时降级为带 TTL 的 localStorage 锁）。
 * - 每次提交前留备份、提交后回读校验；失败则恢复备份并返回明确原因，绝不谎报成功。
 * - 重复提交：同 opId 重放去重；同内容（idemKey）短时间内只保留一份。
 * - 冲突：不同标签页在同一线路/区间/时间槽各写一版时两版都保留，由读取层标冲突。
 * - 旧数组格式分批迁移，游标随批次落盘，中断后可继续补齐。
 */

const LEDGER_KEY = 'bus_window_scenes_ledger_v1'
const BACKUP_KEY = `${LEDGER_KEY}__backup`
const LEGACY_KEY = 'bus_window_scenes'
const LOCK_KEY = `${LEDGER_KEY}__lock`
const LOCK_NAME = 'bus-window-scenes-ledger'
const TAB_ID_KEY = `${LEDGER_KEY}__tab`

/** 台账主存储键（供 storage 事件监听使用） */
export const LEDGER_STORAGE_KEY = LEDGER_KEY

const MIGRATION_BATCH = 5
/** 同内容幂等窗口（按小时分桶）：窗口内同标签页同内容视为重复提交 */
const IDEM_BUCKET_MS = 60 * 60 * 1000
/** 冲突时间槽：同一线路/区间在该槽内来自不同标签页的版本互为冲突 */
const CONFLICT_BUCKET_MS = 30 * 60 * 1000
const FALLBACK_LOCK_TTL_MS = 4000

/** 迁移记录的来源标识 */
export const MIGRATION_ORIGIN = 'legacy-migration'

function safeStorage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function uuid(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return crypto.randomUUID()
    }
  } catch {
    /* ignore */
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** 每个标签页一个稳定 id（sessionStorage 随标签页生命周期，天然区分两个标签页） */
export function getClientId(): string {
  try {
    const existing = window.sessionStorage.getItem(TAB_ID_KEY)
    if (existing) return existing
    const id = `tab-${uuid().slice(0, 8)}`
    window.sessionStorage.setItem(TAB_ID_KEY, id)
    return id
  } catch {
    return `tab-${uuid().slice(0, 8)}`
  }
}

// ---------------------------------------------------------------------------
// 跨标签页互斥锁
// ---------------------------------------------------------------------------

type LockTask<T> = () => T | Promise<T>

interface LocksCapableNavigator {
  locks?: {
    request: <T>(
      name: string,
      _options?: unknown,
      task?: LockTask<T>,
    ) => Promise<T>
  }
}

/** 在跨标签页锁内执行任务，保证同一时刻只有一个标签页在改台账 */
function withLedgerLock<T>(task: LockTask<T>): Promise<T> {
  const locks = (navigator as unknown as LocksCapableNavigator | undefined)?.locks
  if (locks?.request) {
    return locks.request<T>(LOCK_NAME, task)
  }
  return runWithLocalStorageLock(task)
}

/** 降级锁：localStorage 占座 + TTL 防死锁 +  storage 事件自然唤醒等待者 */
function runWithLocalStorageLock<T>(task: LockTask<T>): Promise<T> {
  const holder = getClientId()
  const storage = safeStorage()

  const writeStamp = (until: number): boolean => {
    try {
      storage?.setItem(LOCK_KEY, JSON.stringify({ holder, until }))
      return true
    } catch {
      return false
    }
  }

  /**
   * 返回值：
   * - 'acquired' 已占座
   * - 'busy'     锁在别的标签页手里
   * - 'unusable' 存储连锁戳都写不下（如配额已满/隐私模式），此时台账写入必然失败，
   *              直接放行让任务去产生并返回明确的失败结果，避免死等
   */
  const tryAcquire = (): 'acquired' | 'busy' | 'unusable' => {
    if (!storage) return 'unusable'
    const raw = storage.getItem(LOCK_KEY)
    if (raw) {
      try {
        const stamp = JSON.parse(raw) as { holder: string; until: number }
        if (stamp.until > Date.now() && stamp.holder !== holder) return 'busy'
      } catch {
        // 锁戳损坏，视为过期可抢占
      }
    }
    if (!writeStamp(Date.now() + FALLBACK_LOCK_TTL_MS)) return 'unusable'
    // 回读确认，避免两个标签页同时抢占
    const check = storage.getItem(LOCK_KEY)
    try {
      return (JSON.parse(check as string) as { holder: string }).holder === holder
        ? 'acquired'
        : 'busy'
    } catch {
      return 'busy'
    }
  }

  const release = () => {
    if (!storage) return
    try {
      const raw = storage.getItem(LOCK_KEY)
      if (raw && (JSON.parse(raw) as { holder: string }).holder === holder) {
        storage.removeItem(LOCK_KEY)
      }
    } catch {
      /* ignore */
    }
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false
    let renewTimer: number | undefined
    const attempt = () => {
      if (settled) return
      const state = tryAcquire()
      if (state === 'busy') {
        setTimeout(attempt, 50)
        return
      }
      if (state === 'acquired') {
        renewTimer = window.setInterval(() => {
          if (!settled) writeStamp(Date.now() + FALLBACK_LOCK_TTL_MS)
        }, FALLBACK_LOCK_TTL_MS / 2)
      }
      const finish = () => {
        settled = true
        if (renewTimer !== undefined) window.clearInterval(renewTimer)
        release()
      }
      Promise.resolve()
        .then(task)
        .then(
          (value) => {
            finish()
            resolve(value)
          },
          (err) => {
            finish()
            reject(err)
          },
        )
    }
    attempt()
  })
}

// ---------------------------------------------------------------------------
// 键的计算：幂等键与冲突键
// ---------------------------------------------------------------------------

function norm(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

function timeBucket(timestamp: string, sizeMs: number): string {
  const t = new Date(timestamp).getTime()
  if (Number.isNaN(t)) return 'unknown-time'
  return String(Math.floor(t / sizeMs))
}

function djb2(input: string): string {
  let hash = 5381
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(36)
}

function contentFingerprint(data: SceneFormData): string {
  return djb2(
    JSON.stringify([
      data.weather,
      data.seatDirection,
      norm(data.signText),
      data.treeDensity,
      data.pedestrianStatus,
      norm(data.note),
    ]),
  )
}

function computeConflictKey(data: Pick<SceneFormData, 'routeName' | 'segment'>, timestamp: string): string {
  return `${norm(data.routeName)}|${norm(data.segment)}|${timeBucket(timestamp, CONFLICT_BUCKET_MS)}`
}

function computeIdemKey(origin: string, data: SceneFormData, timestamp: string): string {
  return [
    origin,
    norm(data.routeName),
    norm(data.segment),
    timeBucket(timestamp, IDEM_BUCKET_MS),
    contentFingerprint(data),
  ].join('|')
}

// ---------------------------------------------------------------------------
// 台账读取 / 备份恢复
// ---------------------------------------------------------------------------

function createEmptyLedger(): Ledger {
  return {
    version: 1,
    seq: 0,
    ops: [],
    migration: { status: 'idle', cursor: 0, total: 0, updatedAt: new Date(0).toISOString() },
  }
}

function parseLedger(raw: string): Ledger | null {
  try {
    const parsed = JSON.parse(raw) as Ledger
    if (
      parsed &&
      parsed.version === 1 &&
      Array.isArray(parsed.ops) &&
      typeof parsed.seq === 'number' &&
      parsed.migration
    ) {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

export interface LoadedLedger {
  ledger: Ledger
  /** 非致命情况说明（例如已从备份恢复） */
  notice: string | null
}

/** 读取台账；主副本损坏时回退到上一份备份并尽量回写 */
function loadLedger(): LoadedLedger {
  const storage = safeStorage()
  if (!storage) return { ledger: createEmptyLedger(), notice: null }

  const main = storage.getItem(LEDGER_KEY)
  if (main !== null) {
    const parsed = parseLedger(main)
    if (parsed) return { ledger: parsed, notice: null }
  }

  const backup = storage.getItem(BACKUP_KEY)
  if (backup !== null) {
    const parsedBackup = parseLedger(backup)
    if (parsedBackup) {
      try {
        storage.setItem(LEDGER_KEY, backup)
      } catch {
        /* 回写失败不影响本次使用内存副本 */
      }
      return { ledger: parsedBackup, notice: '台账文件曾损坏，已从最近一次自动备份恢复' }
    }
  }

  if (main !== null) {
    return { ledger: createEmptyLedger(), notice: '台账无法读取且无可用备份，已重建空台账' }
  }
  return { ledger: createEmptyLedger(), notice: null }
}

/** 供 storage 事件回调使用：只读取，不修复、不弹提示 */
export function peekLedger(): Ledger | null {
  const storage = safeStorage()
  const raw = storage?.getItem(LEDGER_KEY)
  return raw ? parseLedger(raw) : null
}

// ---------------------------------------------------------------------------
// 提交：备份 -> 写入 -> 回读校验 -> 失败回滚
// ---------------------------------------------------------------------------

function classifyError(err: unknown): SaveFailReason {
  if (typeof DOMException !== 'undefined' && err instanceof DOMException) {
    if (err.name === 'QuotaExceededError' || err.name === 'WasmQuotaExceededError' || err.code === 22) {
      return 'quota'
    }
    if (err.name === 'SyntaxError') return 'parse'
  }
  return 'unknown'
}

function describeFailure(reason: SaveFailReason): string {
  switch (reason) {
    case 'quota':
      return '本地存储空间不足，保存未生效，原内容已保留。可在时间线撤销一些旧记录后重试。'
    case 'write':
      return '浏览器拒绝了本地写入（可能处于隐私模式或存储被禁用），原内容已保留。'
    case 'parse':
      return '台账数据解析失败，已恢复到保存前的内容。'
    default:
      return '保存失败（未知原因），已恢复到保存前的内容。'
  }
}

/** 原子提交：成功返回 true；任何失败都把主副本恢复到提交前 */
function commitLedger(ledger: Ledger): SaveResult {
  const storage = safeStorage()
  if (!storage) {
    return { ok: false, reason: 'write', message: describeFailure('write') }
  }

  const previous = storage.getItem(LEDGER_KEY)
  // 1) 先把当前主副本存为备份（备份本身失败不阻断，但主写入大概率也会失败）
  if (previous !== null) {
    try {
      storage.setItem(BACKUP_KEY, previous)
    } catch {
      /* 空间紧张时备份可能写不下；继续尝试主写入并以回读校验为准 */
    }
  }

  const payload = JSON.stringify(ledger)
  try {
    storage.setItem(LEDGER_KEY, payload)
  } catch (err) {
    // 规范保证失败时原值保留；个别实现可能半写，下面统一校验+回滚
    if (previous !== null && storage.getItem(LEDGER_KEY) !== previous) {
      try {
        storage.setItem(LEDGER_KEY, previous)
      } catch {
        /* 连回滚都失败时，下次启动仍可从备份恢复 */
      }
    }
    const reason = classifyError(err)
    return { ok: false, reason, message: describeFailure(reason) }
  }

  // 2) 回读校验，防止“写了但没写全 / 被截断”却提示成功
  if (storage.getItem(LEDGER_KEY) !== payload) {
    if (previous !== null) {
      try {
        storage.setItem(LEDGER_KEY, previous)
      } catch {
        /* ignore */
      }
    }
    return { ok: false, reason: 'write', message: describeFailure('write') }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// 操作日志归并
// ---------------------------------------------------------------------------

function sortByTimeDesc(scenes: LedgerScene[]): LedgerScene[] {
  return [...scenes].sort((a, b) => {
    const diff = new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    return diff !== 0 ? diff : b.opSeq - a.opSeq
  })
}

/** 把操作日志折叠成当前状态 */
export function reduceLedger(ledger: Ledger): LedgerView {
  const live = new Map<string, LedgerScene>()
  for (const op of ledger.ops) {
    if (op.type === 'add' && op.scene) {
      live.set(op.scene.versionId, op.scene)
    } else if (op.type === 'undo' && op.targetVersionIds) {
      for (const versionId of op.targetVersionIds) live.delete(versionId)
    }
  }

  const groups = new Map<string, LedgerScene[]>()
  for (const scene of live.values()) {
    const list = groups.get(scene.conflictKey)
    if (list) list.push(scene)
    else groups.set(scene.conflictKey, [scene])
  }

  const conflicts: LedgerConflicts['groups'] = []
  const conflictVersionIds = new Set<string>()
  const byKey = new Map<string, { versions: LedgerScene[]; merged: LedgerScene }>()
  const droppedByMerge = new Set<string>()

  for (const [conflictKey, versions] of groups) {
    const origins = new Set(versions.map((v) => v.origin))
    if (origins.size < 2) continue
    const sorted = sortByTimeDesc(versions)
    const merged = sorted[0]
    conflicts.push({ conflictKey, versions: sorted, merged })
    byKey.set(conflictKey, { versions: sorted, merged })
    sorted.forEach((v) => conflictVersionIds.add(v.versionId))
    sorted.slice(1).forEach((v) => droppedByMerge.add(v.versionId))
  }

  const scenes = sortByTimeDesc([...live.values()])
  const mergedScenes = scenes.filter((s) => !droppedByMerge.has(s.versionId))

  return {
    scenes,
    mergedScenes,
    conflicts: { groups: conflicts, byKey, versionIds: conflictVersionIds },
  }
}

// ---------------------------------------------------------------------------
// 追加操作（add / undo），全部在锁内完成
// ---------------------------------------------------------------------------

type AppendOutcome = SaveResult & { ledger?: Ledger; duplicate?: boolean }

function appendOp(build: (ledger: Ledger) => SceneOp | null): Promise<AppendOutcome> {
  return withLedgerLock(() => {
    const { ledger } = loadLedger()

    const op = build(ledger)
    if (!op) {
      return { ok: true, duplicate: true, ledger } satisfies AppendOutcome
    }
    if (ledger.ops.some((existing) => existing.opId === op.opId)) {
      return { ok: true, duplicate: true, ledger } satisfies AppendOutcome
    }
    if (op.idemKey && ledger.ops.some((existing) => existing.idemKey === op.idemKey)) {
      return { ok: true, duplicate: true, ledger } satisfies AppendOutcome
    }

    ledger.seq += 1
    op.at = op.at || new Date().toISOString()
    ledger.ops.push(op)

    const result = commitLedger(ledger)
    if (!result.ok) {
      return { ...result, opId: op.opId, timestamp: op.at } satisfies AppendOutcome
    }
    return { ok: true, ledger }
  })
}

function buildScene(
  data: SceneFormData,
  origin: string,
  timestamp: string,
  opSeq: number,
  versionId: string,
): LedgerScene {
  return {
    id: versionId,
    ...data,
    timestamp,
    origin,
    opSeq,
    conflictKey: computeConflictKey(data, timestamp),
    versionId,
  }
}

export interface CommitAddOptions {
  opId?: string
  timestamp?: string
  origin?: string
  migrated?: boolean
}

/** 新增一段窗景。重复提交（opId / idemKey 命中）只保留一份 */
export function commitAdd(data: SceneFormData, options: CommitAddOptions = {}): Promise<AppendOutcome> {
  const origin = options.origin ?? getClientId()
  const timestamp = options.timestamp ?? new Date().toISOString()
  const opId = options.opId ?? uuid()
  const idemKey = options.migrated ? undefined : computeIdemKey(origin, data, timestamp)

  return appendOp((ledger) => {
    const opSeq = ledger.seq + 1
    const scene = buildScene(data, origin, timestamp, opSeq, opId)
    return {
      type: 'add',
      opId,
      origin,
      at: timestamp,
      idemKey,
      scene,
      migrated: options.migrated,
    }
  })
}

/** 撤销一段窗景（删除以 undo 日志留痕，可追溯） */
export function commitUndo(versionId: string): Promise<AppendOutcome> {
  const origin = getClientId()
  return appendOp((ledger) => {
    // 已撤销过：幂等返回成功，不重复记日志
    const alreadyUndone = ledger.ops.some(
      (op) => op.type === 'undo' && op.targetVersionIds?.includes(versionId),
    )
    if (alreadyUndone) return null
    const stillLive = ledger.ops.some(
      (op) => op.type === 'add' && op.scene?.versionId === versionId,
    )
    if (!stillLive) return null
    return {
      type: 'undo',
      opId: uuid(),
      origin,
      at: new Date().toISOString(),
      targetVersionIds: [versionId],
    }
  })
}

// ---------------------------------------------------------------------------
// 旧格式迁移：分批 + 游标落盘，中断后继续补齐
// ---------------------------------------------------------------------------

export interface MigrationProgress {
  done: number
  total: number
}

export interface MigrationResult {
  ledger: Ledger
  migrated: number
  total: number
  resumed: boolean
  notice: string | null
}

function readLegacyScenes(): WindowScene[] | null {
  const storage = safeStorage()
  const raw = storage?.getItem(LEGACY_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as WindowScene[]) : null
  } catch {
    return null
  }
}

const yieldToUI = () => new Promise((resolve) => setTimeout(resolve, 0))

/** 迁移旧的 bus_window_scenes 数组。每批一个事务，进度随批次持久化 */
export function runMigration(
  onProgress?: (progress: MigrationProgress) => void,
): Promise<MigrationResult> {
  return withLedgerLock(async () => {
    const loaded = loadLedger()
    const ledger = loaded.ledger
    const notice = loaded.notice
    let migrated = 0
    const resumed = ledger.migration.cursor > 0 && ledger.migration.status !== 'done'

    const legacy = readLegacyScenes()
    if (legacy === null) {
      // 旧数据本身已损坏，无法迁移，标记完成避免反复尝试
      ledger.migration = {
        status: 'done',
        cursor: ledger.migration.cursor,
        total: ledger.migration.total,
        updatedAt: new Date().toISOString(),
      }
      const result = commitLedger(ledger)
      if (!result.ok) {
        throw Object.assign(new Error(result.message), { saveResult: result })
      }
      return { ledger, migrated: 0, total: ledger.migration.total, resumed, notice }
    }

    if (ledger.migration.status !== 'done') {
      ledger.migration.total = legacy.length
      ledger.migration.updatedAt = new Date().toISOString()
    }

    while (ledger.migration.status !== 'done') {
      const start = ledger.migration.cursor
      const batch = legacy.slice(start, start + MIGRATION_BATCH)
      if (batch.length === 0) {
        ledger.migration.status = 'done'
        ledger.migration.updatedAt = new Date().toISOString()
      } else {
        for (let i = 0; i < batch.length; i++) {
          const legacyIndex = start + i
          const old = batch[i]
          // 确定性 id：即使某批“写成功但校验失败”重试，也不会产生重复版本
          const opId = `mig-${legacyIndex}-${djb2(old.id || JSON.stringify(old))}`
          if (ledger.ops.some((op) => op.opId === opId)) continue
          ledger.seq += 1
          const data: SceneFormData = {
            routeName: old.routeName ?? '',
            segment: old.segment ?? '',
            seatDirection: old.seatDirection ?? '左',
            weather: old.weather ?? '晴',
            signText: old.signText ?? '',
            treeDensity: old.treeDensity ?? '适中',
            pedestrianStatus: old.pedestrianStatus ?? '稀少',
            note: old.note ?? '',
          }
          const timestamp = old.timestamp || new Date().toISOString()
          const scene = buildScene(data, MIGRATION_ORIGIN, timestamp, ledger.seq, opId)
          ledger.ops.push({
            type: 'add',
            opId,
            origin: MIGRATION_ORIGIN,
            at: timestamp,
            scene,
            migrated: true,
          })
          migrated++
        }
        ledger.migration.cursor = start + batch.length
        ledger.migration.updatedAt = new Date().toISOString()
      }

      const result = commitLedger(ledger)
      if (!result.ok) {
        throw Object.assign(new Error(result.message), { saveResult: result })
      }
      onProgress?.({ done: ledger.migration.cursor, total: legacy.length })
      if (ledger.migration.status !== 'done') await yieldToUI()
    }

    // 迁移确认完成后再移除旧数组（失败也不影响，台账已标记 done）
    if (legacy.length > 0) {
      try {
        safeStorage()?.removeItem(LEGACY_KEY)
      } catch {
        /* ignore */
      }
    }
    return { ledger, migrated, total: legacy.length, resumed, notice }
  })
}
