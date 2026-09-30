export type SeatDirection = '左' | '右'

export type Weather = '晴' | '多云' | '阴' | '小雨' | '大雨' | '雪' | '雾'

export type TreeDensity = '稀疏' | '适中' | '茂密'

export type PedestrianStatus = '稀少' | '零星' | '密集'

export interface WindowScene {
  id: string
  routeName: string
  segment: string
  seatDirection: SeatDirection
  timestamp: string
  weather: Weather
  signText: string
  treeDensity: TreeDensity
  pedestrianStatus: PedestrianStatus
  note: string
}

export interface SceneFormData {
  routeName: string
  segment: string
  seatDirection: SeatDirection
  weather: Weather
  signText: string
  treeDensity: TreeDensity
  pedestrianStatus: PedestrianStatus
  note: string
}

/** 台账内的窗景记录：在原始结构上补充合并来源信息 */
export interface LedgerScene extends WindowScene {
  /** 产生该版本的标签页，用于区分“两个标签页各写一版”的冲突 */
  origin: string
  /** 写入台账的操作序号（同一操作内为同一序号） */
  opSeq: number
  /** 冲突分组键：线路|区间|日期|时段，同键且来自不同标签页即冲突 */
  conflictKey: string
  /** 台账内唯一版本 id（同 opId 重放保持不变） */
  versionId: string
}

/** 台账操作类型：新增 / 撤销（撤销即删除，以日志形式留下痕迹） */
export type OpType = 'add' | 'undo'

export interface SceneOp {
  type: OpType
  /** 操作唯一 id，用于跨标签页重放去重 */
  opId: string
  /** 客户端（标签页）id，用于冲突判定 */
  origin: string
  /** 操作发生时间（ISO） */
  at: string
  /** 幂等键：相同内容重复提交只保留一版 */
  idemKey?: string
  /** add：记录内容；undo：要撤销的 versionId 列表 */
  scene?: LedgerScene
  targetVersionIds?: string[]
  /** 迁移产生的操作带此标记 */
  migrated?: boolean
}

/** 本地台账：操作日志 + 元数据 */
export interface Ledger {
  version: 1
  /** 单调递增的操作序号 */
  seq: number
  /** 操作日志（事实来源，新增/撤销都追加于此） */
  ops: SceneOp[]
  /** 旧格式数据迁移进度 */
  migration: {
    status: 'idle' | 'done'
    cursor: number
    total: number
    updatedAt: string
  }
}

export interface ConflictInfo {
  conflictKey: string
  versions: LedgerScene[]
  /** 合并结果：该冲突组中最新的一版 */
  merged: LedgerScene
}

/** 冲突分组（versions 按时间倒序，merged 为最新一版） */
export interface ConflictGroup {
  conflictKey: string
  versions: LedgerScene[]
  merged: LedgerScene
}

export interface LedgerConflicts {
  groups: ConflictGroup[]
  byKey: Map<string, { versions: LedgerScene[]; merged: LedgerScene }>
  versionIds: Set<string>
}

export interface LedgerView {
  /** 归并后的全部存活版本（冲突时两个版本都在） */
  scenes: LedgerScene[]
  /** 冲突信息，时间线据此标冲突 */
  conflicts: LedgerConflicts
  /** 去冲突后的合并结果，每个冲突组只保留最新版 —— 灵感页使用 */
  mergedScenes: LedgerScene[]
}

export type SaveFailReason = 'quota' | 'write' | 'parse' | 'unknown'

export interface SaveResult {
  ok: boolean
  /** 命中幂等（重复提交），台账中没有新增内容 */
  duplicate?: boolean
  /** 本次操作 id，失败重试时复用，保证只落一份 */
  opId?: string
  /** 本次提交时间戳，失败重试时复用，保证与原内容同槽 */
  timestamp?: string
  reason?: SaveFailReason
  message?: string
}

export type MigrationStatus = 'idle' | 'running' | 'done' | 'failed'

export interface HydrateState {
  loaded: boolean
  migration: {
    status: MigrationStatus
    done: number
    total: number
  } | null
  /** 台账损坏并已从备份恢复等非致命提示 */
  notice: string | null
}
