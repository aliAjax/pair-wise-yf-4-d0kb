# 窗景采样器

公交车窗景观察笔记应用。本地台账部分见下文「本地台账」一节。

## 本地台账（多标签页安全）

窗景记录不再是“读全量数组→改→整体写回”，而是一份**操作日志台账**（`src/services/ledger.ts`）：

- **操作日志合并**：新增 `add`、撤销 `undo` 都只追加操作，读取时归并；跨标签页写入经
  Web Locks 串行化（不支持时降级为带 TTL 的 localStorage 锁），并发保存互不覆盖。
- **可恢复**：每次提交前把当前主副本写入 `…__backup`，写后回读校验；
  失败立即回滚到提交前，主副本损坏则在下次启动时从备份恢复并提示。
- **不谎报成功**：`setItem` 抛 `QuotaExceededError`（空间不足）等错误时返回明确原因，
  页面保留表单原文，可用原 `opId/时间戳` 重试，重试不会产生第二条记录。
- **重复提交去重**：同 `opId` 重放、或同标签页一小时桶内同内容（`idemKey`）都只保留一份。
- **冲突保留两版**：两个标签页在同一线路/区间/30 分钟槽内各存一版时，两版都保留，
  时间线页用琥珀色标出冲突并可逐版撤销；灵感页的随机采集只取合并视图（每组最新版）。
- **旧数据迁移可续传**：旧 `bus_window_scenes` 数组按每批 5 条迁移，游标随批次落盘；
  中途配额不足/崩溃后再次启动（或点“继续补齐”）从断点继续，确定性 `opId` 保证不重复。

存储键：`bus_window_scenes_ledger_v1`（主）、`…__backup`（备份）。

可用 `npm run verify` 运行端到端脚本（迁移中断续传、幂等、并发 40 条不丢、
冲突合并、配额失败回滚、备份恢复，共 45 项断言）。

---

## Vite 模板说明

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Babel](https://babeljs.io/) for Fast Refresh
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default tseslint.config({
  extends: [
    // Remove ...tseslint.configs.recommended and replace with this
    ...tseslint.configs.recommendedTypeChecked,
    // Alternatively, use this for stricter rules
    ...tseslint.configs.strictTypeChecked,
    // Optionally, add this for stylistic rules
    ...tseslint.configs.stylisticTypeChecked,
  ],
  languageOptions: {
    // other options...
    parserOptions: {
      project: ['./tsconfig.node.json', './tsconfig.app.json'],
      tsconfigRootDir: import.meta.dirname,
    },
  },
})
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default tseslint.config({
  extends: [
    // other configs...
    // Enable lint rules for React
    reactX.configs['recommended-typescript'],
    // Enable lint rules for React DOM
    reactDom.configs.recommended,
  ],
  languageOptions: {
    // other options...
    parserOptions: {
      project: ['./tsconfig.node.json', './tsconfig.app.json'],
      tsconfigRootDir: import.meta.dirname,
    },
  },
})
```
