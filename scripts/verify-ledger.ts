/**
 * 台账端到端验证（不依赖浏览器）：
 *   node --experimental-strip-types scripts/verify-ledger.ts
 *
 * 用内存版 localStorage 模拟多标签页环境，并依次验证：
 * 1. 旧数组迁移 + 中断续传（配额中途打满再恢复）
 * 2. 重复提交只留一份（同内容 / 同 opId 重试）
 * 3. 两标签页同段窗景 -> 两版保留、时间线可标冲突、灵感页只用合并版
 * 4. 保存失败回滚 + 原因，且不留半截数据
 * 5. 撤销按日志合并，撤销后冲突消失
 * 6. 主副本损坏 -> 从备份恢复
 */

// ---- 最小 localStorage mock（支持 storage 事件暂不需要） ----
class MemoryStorage {
  private map = new Map<string, string>()
  public quota = Infinity

  get length() {
    return this.map.size
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null
  }
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null
  }
  setItem(key: string, value: string) {
    const incoming = this.estimate(key, value)
    const current = this.map.has(key) ? this.estimate(key, this.map.get(key)!) : 0
    if (this.used - current + incoming > this.quota) {
      throw new DOMException('Storage quota exceeded', 'QuotaExceededError')
    }
    this.map.set(key, value)
  }
  removeItem(key: string) {
    this.map.delete(key)
  }
  clear() {
    this.map.clear()
  }
  private estimate(key: string, value: string) {
    return key.length + value.length
  }
  get used() {
    let n = 0
    for (const [k, v] of this.map) n += k.length + v.length
    return n
  }
}

const storage = new MemoryStorage()

// sessionStorage：不同标签页给不同实例
const sessionStorages: MemoryStorage[] = []

// ---- 全局环境装配（须在 import ledger 之前完成） ----
;(globalThis as unknown as Record<string, unknown>).window = globalThis
;(globalThis as unknown as Record<string, unknown>).localStorage = storage
Object.defineProperty(globalThis, 'sessionStorage', {
  value: null,
  writable: true,
  configurable: true,
})
Object.defineProperty(globalThis, 'navigator', {
  value: {}, // 强制走 localStorage 降级锁路径
  writable: true,
  configurable: true,
})

let assertions = 0
let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  assertions++
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    failures++
    console.error(`  ✗ ${name}`, detail ?? '')
  }
}
async function section(title: string, fn: () => Promise<void> | void) {
  console.log(`\n[${title}]`)
  await fn()
}

// ---- 模拟“另一个标签页”：独立 sessionStorage，共享 localStorage ----
async function inOtherTab<T>(fn: () => Promise<T>): Promise<T> {
  const ownSession = new MemoryStorage()
  sessionStorages.push(ownSession)
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: ownSession,
    configurable: true,
  })
  const mod = await import('../src/services/ledger.ts')
  return fn(mod)
}

async function loadLedgerModule() {
  const ownSession = new MemoryStorage()
  sessionStorages.push(ownSession)
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: ownSession,
    configurable: true,
  })
  return import('../src/services/ledger.ts')
}

// ---- 造数据 ----
function sceneOverrides(partial: Record<string, unknown> = {}) {
  return {
    routeName: '71路',
    segment: '外滩—延安东路',
    seatDirection: '左' as const,
    weather: '晴' as const,
    signText: '和平饭店',
    treeDensity: '适中' as const,
    pedestrianStatus: '零星' as const,
    note: '晨光打在江面上',
    ...partial,
  }
}

const LEGACY_KEY = 'bus_window_scenes'
const LEDGER_KEY = 'bus_window_scenes_ledger_v1'
const BACKUP_KEY = `${LEDGER_KEY}__backup`

// ============ 1. 迁移 + 中断续传 ============
await section('迁移：12 条旧数据，第 7 条前后配额打满后恢复', async () => {
  const legacy = Array.from({ length: 12 }, (_, i) => ({
    id: `old-${i}`,
    routeName: i % 2 ? '71路' : '20路',
    segment: `区间${i}`,
    seatDirection: '右',
    timestamp: new Date(Date.now() - (12 - i) * 3600_000).toISOString(),
    weather: '多云',
    signText: `招牌${i}`,
    treeDensity: '稀疏',
    pedestrianStatus: '稀少',
    note: `旧记录 ${i}`,
  }))
  storage.setItem(LEGACY_KEY, JSON.stringify(legacy))

  const mod = await loadLedgerModule()

  // 给一个很小的配额：大约够迁移 7 条（含日志开销），随后触发 QuotaExceededError
  storage.quota = storage.used + 2600
  let interrupted = false
  let progressLast = -1
  try {
    await mod.runMigration(({ done }) => {
      progressLast = done
    })
  } catch (err) {
    interrupted = true
    check('迁移因配额不足而中断', (err as Error).message.includes('存储空间不足'))
  }
  check('迁移确已中断且至少完成一批', interrupted && progressLast >= 5, {
    interrupted,
    progressLast,
  })

  // 中断后旧数组仍在（尚未确认完成）
  check('中断后旧数组未被删除', storage.getItem(LEGACY_KEY) !== null)

  // 恢复配额，再次启动 -> 从游标补齐，不产生重复
  storage.quota = Infinity
  const result = await mod.runMigration()
  check('续传标记 resumed=true', result.resumed === true)
  const view = mod.reduceLedger(result.ledger)
  check('12 条全部迁移', view.scenes.length === 12, view.scenes.length)
  check('迁移无重复（确定性 opId 去重）', result.ledger.ops.filter((o) => o.migrated).length === 12)
  check('迁移完成后旧数组已清理', storage.getItem(LEGACY_KEY) === null)
})

// ============ 2. 重复提交只留一份 ============
await section('幂等：同内容重复提交、失败后同 opId 重试', async () => {
  const mod = await loadLedgerModule()
  const form = sceneOverrides({ segment: '幂等测试区间', note: '完全相同的内容' })
  const ts = new Date().toISOString()

  const r1 = await mod.commitAdd(form, { opId: 'op-A', timestamp: ts, origin: 'tab-A' })
  const r2 = await mod.commitAdd(form, { opId: 'op-B', timestamp: ts, origin: 'tab-A' })
  const r3 = await mod.commitAdd(form, { opId: 'op-A', timestamp: ts, origin: 'tab-A' })
  check('首次保存成功', r1.ok && !r1.duplicate)
  check('同内容同小时再提交 -> duplicate', r2.ok && r2.duplicate === true)
  check('同 opId 重放 -> duplicate', r3.ok && r3.duplicate === true)

  const view = mod.reduceLedger(r3.ledger!)
  check('台账中只有一份', view.scenes.filter((s) => s.segment === '幂等测试区间').length === 1)

  // 不同内容不应被误杀
  const r4 = await mod.commitAdd(
    sceneOverrides({ segment: '幂等测试区间', note: '不同的观察笔记' }),
    { opId: 'op-C', timestamp: ts, origin: 'tab-A' },
  )
  check('内容不同则正常保留', r4.ok && !r4.duplicate)
})

// ============ 3. 两标签页同段窗景：冲突两版保留，合并只取最新 ============
await section('冲突：两标签页同线路同区间时间槽内各写一版', async () => {
  const modA = await loadLedgerModule()
  const base = { routeName: '71路', segment: '冲突测试区间' }
  const ts = new Date().toISOString()

  const a = await modA.commitAdd(
    sceneOverrides({ ...base, note: 'A 标签页版本：先写' }),
    { origin: 'tab-A', timestamp: ts, opId: 'op-conf-A' },
  )

  const b = await inOtherTab(async (modB) => {
    return modB.commitAdd(
      sceneOverrides({ ...base, note: 'B 标签页版本：后写更新' }),
      { origin: 'tab-B', timestamp: new Date(new Date(ts).getTime() + 60_000).toISOString(), opId: 'op-conf-B' },
    )
  })

  check('两个标签页都保存成功', a.ok && b.ok)

  const view = modA.reduceLedger(b.ledger!)
  const conflictScenes = view.scenes.filter((s) => s.segment === '冲突测试区间')
  check('两版都保留', conflictScenes.length === 2, conflictScenes.length)
  check('识别出 1 个冲突组', view.conflicts.groups.length === 1, view.conflicts.groups)
  check('冲突组两版来自不同标签页', new Set(view.conflicts.groups[0].versions.map((v) => v.origin)).size === 2)
  check('合并版取时间最新（B 版）', view.conflicts.groups[0].merged.note.includes('B 标签页'))
  const mergedInConflict = view.mergedScenes.filter((s) => s.segment === '冲突测试区间')
  check('灵感页合并视图只有 B 版一版', mergedInConflict.length === 1 && mergedInConflict[0].note.includes('B'))
})

// ============ 4. 配额失败：回滚、报错、无半截数据 ============
await section('保存失败：配额不足时恢复原内容并说明原因', async () => {
  const mod = await loadLedgerModule()
  const beforeRaw = storage.getItem(LEDGER_KEY)
  const beforeView = mod.reduceLedger(JSON.parse(beforeRaw!))
  const beforeCount = beforeView.scenes.length

  storage.quota = storage.used // 任何写入都失败
  const fail = await mod.commitAdd(
    sceneOverrides({ segment: '不该存在的区间', note: '写不下的内容' }),
    { origin: 'tab-A', opId: 'op-fail' },
  )
  storage.quota = Infinity

  check('返回 ok=false', fail.ok === false)
  check('原因是 quota', fail.reason === 'quota', fail.reason)
  check('给出中文原因说明', typeof fail.message === 'string' && fail.message.includes('存储空间不足'))
  check('返回 opId 供重试', typeof fail.opId === 'string')

  const afterRaw = storage.getItem(LEDGER_KEY)
  check('主存储恢复为写入前的内容', afterRaw === beforeRaw)
  const afterView = mod.reduceLedger(JSON.parse(afterRaw!))
  check('台账记录数没有变化', afterView.scenes.length === beforeCount, {
    before: beforeCount,
    after: afterView.scenes.length,
  })

  // 放开空间后用原 opId 重试 -> 只落一份
  const retry = await mod.commitAdd(
    sceneOverrides({ segment: '不该存在的区间', note: '写不下的内容' }),
    { origin: 'tab-A', opId: fail.opId, timestamp: fail.timestamp },
  )
  check('重试成功', retry.ok)
  const retryView = mod.reduceLedger(retry.ledger!)
  check('重试后恰好一份', retryView.scenes.filter((s) => s.segment === '不该存在的区间').length === 1)
})

// ============ 5. 撤销按日志合并，撤一版后冲突消失 ============
await section('撤销：undo 日志合并，撤销冲突旧版后冲突解除', async () => {
  const mod = await loadLedgerModule()
  const ledger0 = mod.peekLedger()!
  const view0 = mod.reduceLedger(ledger0)
  const conflictGroup = view0.conflicts.groups.find((g) =>
    g.versions.some((v) => v.segment === '冲突测试区间'),
  )
  check('撤销前冲突仍在', Boolean(conflictGroup))

  // 撤销非采用版（A 版）
  const oldVersion = conflictGroup!.versions.find((v) => v.note.includes('A 标签页'))!
  const undo = await mod.commitUndo(oldVersion.versionId)
  check('撤销成功', undo.ok)

  const view1 = mod.reduceLedger(undo.ledger!)
  check('撤销后该冲突消失', !view1.conflicts.groups.some((g) => g.versions[0].segment === '冲突测试区间'))
  check('B 版仍在', view1.scenes.some((s) => s.note.includes('B 标签页版本')))
  check('撤销以日志留痕（含 undo op）', undo.ledger!.ops.some((o) => o.type === 'undo'))

  // 重复撤销幂等
  const undoAgain = await mod.commitUndo(oldVersion.versionId)
  const undoOps = undoAgain.ledger!.ops.filter(
    (o) => o.type === 'undo' && o.targetVersionIds?.includes(oldVersion.versionId),
  )
  check('重复撤销只产生一条 undo 日志', undoOps.length === 1, undoOps.length)
})

// ============ 6. 损坏恢复 ============
await section('可恢复：主副本损坏时从备份恢复', async () => {
  const mod = await loadLedgerModule()
  // 连续两次写入：备份策略是“上一版健康副本”，第二次写入后备份即包含第一次的内容
  await mod.commitAdd(sceneOverrides({ segment: '备份健康点-1', note: '第一版' }), {
    origin: 'tab-A',
    opId: 'op-backup-1',
  })
  const second = await mod.commitAdd(
    sceneOverrides({ segment: '备份健康点-2', note: '第二版' }),
    { origin: 'tab-A', opId: 'op-backup-2' },
  )
  const healthyCount = mod.reduceLedger(second.ledger!).scenes.length

  // 模拟主副本被写坏（半写 / 被外部截断）
  storage.setItem(LEDGER_KEY, '{ corrupted json !!! ')
  const loaded = await mod.runMigration()
  const restoredCount = mod.reduceLedger(loaded.ledger).scenes.length
  // 备份只比主副本旧一版：第一版内容必然在，第二版理论上也在（备份于其写入前更新）
  check('损坏后从备份恢复，记录基本不丢（至多差最后一次写入）', restoredCount >= healthyCount - 1, {
    restoredCount,
    healthyCount,
  })
  check('恢复的台账包含此前已确认的内容', mod
    .reduceLedger(loaded.ledger)
    .scenes.some((s) => s.segment === '备份健康点-1'))
  check('主副本已被修复为可解析台账', JSON.parse(storage.getItem(LEDGER_KEY)!).version === 1)
  check('恢复时给出提示', loaded.notice !== null && loaded.notice.includes('备份'))
  check('备份副本仍然保留', storage.getItem(BACKUP_KEY) !== null)
})

// ============ 7. 真并发：两标签页同时提交，锁串行化后一条不丢 ============
await section('并发：两标签页同时各提交 20 条，无一被覆盖', async () => {
  storage.clear()
  for (const s of sessionStorages) s.clear()

  const modA = await loadLedgerModule()
  // 空存储首次启动等价于 hydrate：迁移流程负责建立空台账
  const init = await modA.runMigration()
  const baseCount = modA.reduceLedger(init.ledger).scenes.length
  check('从空台账开始', baseCount === 0)

  const N = 20
  const ownP = Promise.all(
    Array.from({ length: N }, (_, i) =>
      modA.commitAdd(sceneOverrides({ segment: `并发A-${i}`, note: `A${i}` }), {
        origin: 'tab-A',
        opId: `op-A${i}`,
      }),
    ),
  )
  const otherP = inOtherTab((modB) =>
    Promise.all(
      Array.from({ length: N }, (_, i) =>
        modB.commitAdd(sceneOverrides({ segment: `并发B-${i}`, note: `B${i}` }), {
          origin: 'tab-B',
          opId: `op-B${i}`,
        }),
      ),
    ),
  )

  const [own, other] = await Promise.all([ownP, otherP])
  check('40 次提交全部成功', [...own, ...other].every((r) => r.ok))

  // 两边各自读到的是自己视角的最后快照，以磁盘最终台账为准
  const finalLedger = modA.peekLedger()!
  const view = modA.reduceLedger(finalLedger)
  check('最终台账恰有 40 条（无互相覆盖）', view.scenes.length === 2 * N, view.scenes.length)
  check('A 的 20 条都在', view.scenes.filter((s) => s.origin === 'tab-A').length === N)
  check('B 的 20 条都在', view.scenes.filter((s) => s.origin === 'tab-B').length === N)
  check('seq 连续无跳号', finalLedger.seq === 2 * N, finalLedger.seq)

  // 同段同时刻的跨标签页写入应被标为冲突（不同区间互不干扰）
  const ts = new Date().toISOString()
  await Promise.all([
    modA.commitAdd(sceneOverrides({ segment: '同段并发', note: 'A 版' }), {
      origin: 'tab-A',
      opId: 'op-parallel-conf-A',
      timestamp: ts,
    }),
    inOtherTab((modB) =>
      modB.commitAdd(sceneOverrides({ segment: '同段并发', note: 'B 版' }), {
        origin: 'tab-B',
        opId: 'op-parallel-conf-B',
        timestamp: new Date(new Date(ts).getTime() + 1000).toISOString(),
      }),
    ),
  ])
  const finalView = modA.reduceLedger(modA.peekLedger()!)
  check('同段并发两版都保留', finalView.scenes.filter((s) => s.segment === '同段并发').length === 2)
  check('同段并发被识别为冲突', finalView.conflicts.groups.some((g) =>
    g.versions.some((v) => v.segment === '同段并发'),
  ))
})

console.log(`\n${failures === 0 ? '✅ 全部通过' : '❌ 有失败'}：${assertions - failures}/${assertions}`)
process.exit(failures === 0 ? 0 : 1)
