# 测试说明 / Test guide

## 自动回归 / Automated regression

在仓库根目录运行 / Run from the repository root:

```sh
npm ci
npm test
```

11 套测试涵盖 / The 11 suites cover:

| 范围 / Area | 验证内容 / Evidence |
| --- | --- |
| 扫描 / Scan | 1、7、137 Modules，分页、循环链接、重复分页、部分结果保留、讨论附件无 ID、Quiz、ExternalTool；429/5xx、Retry-After、超时、坏 JSON、权限与登录页 / Pagination, cycles, partial results, resources and API failures |
| 原生下载 / Native download | 当前页大清单、三任务并发、多个助手去重、持久化 ID/控制意图、重建 worker VM、迟到事件、精确失败副本重试 / Large uncached lists, concurrency, persisted state, recreated workers, late events, exact failed-copy retries |
| 直接写盘 / Folder writes | 实际嵌套目录、冲突编号、写入进度、暂停停止、最终提交竞态 / Real directories, conflict suffixes, progress and final-commit controls |
| ZIP | 内容与来源清单、401/断流跳过、单文件原子加入、阶段进度、保存失败、最终提交、临时租约 / Archive contents, manifests, skipped failures, progress, save races and temporary leases |
| 网络 / Network | 本地真实 HTTP 挂起响应头/正文、断流、重试上限、取消旧响应、暂停冻结时限、停止退避 / Local HTTP stalls, broken streams, bounded retries, cancelled response bodies, paused clocks |
| 空间 / Storage | 2 MiB/3 课程/30 天、100 条结束记录、配额创建/写入/提交故障、清理 / Cache bounds, quota fault injection and cleanup |
| 界面 / UI | 仅重试失败项、外链额外勾选、路径保留、ZIP 命名、282 条中英键与插值、过期清单提示 / Exact retries, external opt-in, paths, filenames, locale parity and expired-list diagnostics |

## 真实 Chrome 本地验收 / Local tests in real Chrome

```sh
npm run test:browser
```

终端显示本机测试网址。该服务仅用于开发测试，监听 `127.0.0.1`；插件运行和安装包均不依赖它。按 Ctrl+C 停止。/ The printed URLs are local development fixtures only. The extension and its package do not require this server. Stop it with Ctrl+C.

- `/checks` → **Run checks**：真实 fetch、OPFS 和生产 ZIP 代码。验证 16 MiB 内容、HTTP 跳转、未知长度、401/登录页、暂停恢复、停止、超时后继续与 4 GB 预检查。运行后删除测试临时文件，不创建 Chrome 下载记录。/ Tests real streaming and browser storage, verifies archive bytes, and removes its temporary files.
- `/layout?width=390&lang=en`、`/layout?width=768&lang=zh-CN`：独立 iframe 视口检查页面横向溢出。点 **Focus first checkbox and expand sources**，按空格勾选，再点 **Refresh task progress**，检查焦点、勾选和展开状态保持。/ Checks responsive overflow and keyboard state across progress refreshes.

2026-10-22：Windows Chrome 156 的 5 组下载/存储验收通过；英文 390px 与中文 768px 布局和英文键盘勾选刷新通过。界面使用模拟课程和 Chrome 任务；下载/存储组使用真实本地 HTTP 与浏览器 OPFS。

2026-10-22: Five download/storage groups passed in Windows Chrome 156. English 390px, Chinese 768px layout and English keyboard-selection refresh checks passed. UI course/task data is simulated; HTTP streaming and OPFS are real.

## 仍需实际课程验收 / Remaining environment checks

这些属于实际平台差异，不能用模拟结果代替 / Simulated results do not establish these environment-specific behaviors:

- 学校 SSO、SameSite Cookie、CDN 跨站跳转及权限 / Institution SSO, cookies, CDN redirects and permissions.
- 真实扩展后台被 Chrome 终止、浏览器退出恢复，以及系统保存对话框 / Actual service-worker termination, browser restarts and native save dialogs. Worker lifecycle tests currently recreate VM instances with persisted state.
- 磁盘真正耗尽、接近 4 GB 的内存/磁盘峰值与长时间传输 / Actual disk exhaustion, near-4 GB peak resource use and long transfers. Quota failures are injected and the size boundary uses declared size without allocating 4 GB.
- LTI 外部平台内容需要原平台登录；只识别已暴露的文件或页面链接，不自动启动 LTI 应用 / External LTI content requires its platform login; only exposed file/page links are recognized.
