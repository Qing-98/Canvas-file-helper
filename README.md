# Canvas File Helper · Canvas 文件助手

[中文](#中文) · [English](#english)

把 Canvas 课程全部 Modules 中的附件整理成文件列表，按格式筛选、保留章节和来源页面，再勾选批量下载或打包为一个 ZIP。

A Chrome extension for collecting Canvas course files across all Modules, organizing them by file type and source, and downloading selected files individually or as one ZIP.

## 中文

### 功能

- 遍历当前课程的全部 Modules 和分页，读取章节文件及课程页面、作业、讨论、测验说明中的附件。
- 按 PDF、PPT、Word、Excel、音视频、压缩包、图片、PSIM 等格式分类，支持按章节和关键词筛选。
- 相同 Canvas 文件合并显示，保留全部章节与来源页面，例如 `Week 1 / Week 1 - Lectorial`。
- 外部文件直链单独列出，默认不选中，需要额外勾选。
- 支持 ZIP 打包、逐个文件下载、自选本地文件夹，以及下载进度、暂停、继续和停止。
- 支持中文和 English；所有操作在浏览器内完成，无需独立后端或 IDM。

### 安装到 Chrome

1. 点击本仓库上方 **Code → Download ZIP**，下载并解压到一个固定位置。
2. 在 Chrome 地址栏输入 `chrome://extensions`，打开右上角的**开发者模式**。
3. 点击**加载已解压的扩展程序**，选择解压目录里的 **`canvas-module-files` 文件夹**，该文件夹内应能看到 `manifest.json`。不要选择仓库最外层目录。
4. 在 Chrome 工具栏的扩展程序菜单中找到 **Canvas 文件助手**，可以将它固定到工具栏。

安装后请保留这个文件夹，Chrome 会从该位置读取插件文件。使用插件不需要安装 Node.js 或运行任何服务。

### 使用步骤

1. 在 Chrome 中登录学校的 Canvas，打开需要整理的课程。
2. 点击工具栏中的 **Canvas 文件助手**，进入文件助手页。
3. 点击**扫描全部 Modules**，等待扫描完成。扫描期间保持课程页和助手页打开。
4. 按文件格式、章节或关键词筛选，勾选需要的附件。外部直链在单独区域，需要另外勾选。
5. 在下载区设置保存位置和目录结构，选择下载方式，再点击**下载所选文件**。

顶部语言菜单可以切换中文和 English，课程名、章节名和文件名保留原文。

#### 下载方式和保存位置

| 选项 | 行为 |
| --- | --- |
| 打包为一个 ZIP（默认） | 收集所选文件后生成一个 ZIP，Chrome 只增加一条最终 ZIP 下载记录。 |
| 逐个文件下载 | 每份文件单独保存；使用 Chrome 默认目录时，会产生对应的下载记录。 |
| Chrome 默认目录 | ZIP 打包完成后弹出保存位置窗口；逐个文件下载使用 Chrome 的下载设置。 |
| 选择本地文件夹… | 通过系统窗口选择并允许写入目录，插件直接将 ZIP 或各个文件写入该位置。每次打开助手页需重新选择。 |

首次使用 ZIP 或自选目录下载时，Chrome 可能会请求读取所选文件来源网站的权限。允许后，插件使用浏览器现有的登录会话获取文件。

ZIP 默认命名为 `课程名_资料_YYYY-MM-DD_HH-mm-ss.zip`，使用本地日期时间；英文界面使用 `Course name_Files_YYYY-MM-DD_HH-mm-ss.zip`。例如 `Switched Mode Power Supplies (2650)_资料_2026-10-22_22-15-30.zip`。保存到 Chrome 或自选文件夹时都使用该名称，同名文件自动编号。

#### 按章节和来源页面整理

开启**按 Module 创建文件夹**和**保留来源页面目录**后，目录结构如下；ZIP 内部使用相同结构：

```text
Canvas/
└── 课程名称/
    └── Week 1/
        └── Week 1 - Lectorial/
            └── PDF/
                └── lecture.pdf
```

同一文件属于多个章节时，列表只显示一行。下载时可以选择仅保存一份，或在每个来源目录分别保存一份。同名冲突自动编号，不覆盖已有文件。

#### 进度与失败文件

- 使用进度区的**暂停全部 / 继续全部 / 停止全部**控制当前课程未完成任务；停止后如需重试，请重新勾选下载。
- ZIP 中单个文件失败会跳过并继续处理其他文件。压缩包附带 `文件来源清单.json`；有失败时另附 `下载失败清单.json`，记录原因、章节和来源页面。全部失败时不生成空 ZIP。
- ZIP 和自选文件夹模式运行期间，请保持助手页打开。暂停后少量在途数据可能仍由浏览器缓冲；停止会清理未完成文件，保留已完成文件。
- 单个 ZIP 限制为约 4 GB、最多 65533 个文件，较大的课程请分批选择。

### 常见问题

**为什么有些文件下载失败？**

Canvas 登录失效、文件锁定、外部平台权限或网络中断都可能导致失败。先在课程原页面打开该文件，确认当前浏览器能够访问，再重试。插件不会绕过文件访问权限。

**怎么更新插件？**

用新版本替换原来的插件文件夹，在 `chrome://extensions` 点击该插件的重新加载按钮，然后关闭旧助手页，从课程重新打开。

**会一直缓存附件，占用磁盘吗？**

不会持久缓存附件正文。课程清单最多保留 3 门、合计 2 MiB，30 天过期；已结束任务最多保留 100 条。ZIP 的临时数据在保存、取消或停止后清理；意外关闭页面留下的临时文件，超过 24 小时后在下次打开或清理时删除。页面提供**清理本地数据**，不会删除已下载文件。

### 开发与文档

源码位于 `canvas-module-files/`，测试位于 `tests/`。仅开发测试需要 Node.js：

```sh
npm ci
npm test
```

测试覆盖 Modules 遍历、去重分类、下载队列、暂停停止、ZIP 失败续打包、存储清理和中英界面。测试使用模拟接口和本地文件；实际学校的登录和跨站下载仍需在 Chrome 中验证。

- [详细行为与权限说明](canvas-module-files/README.md)
- [添加其他界面语言](canvas-module-files/LOCALIZATION.md)

项目采用 [MIT License](LICENSE)。ZIP 库 fflate 随插件附带，其许可见 [fflate-LICENSE.txt](canvas-module-files/vendor/fflate-LICENSE.txt)。

## English

### Features

- Scan every Module and all pagination in the current Canvas course, including file items and attachments in course pages, assignment descriptions, discussions, and quiz descriptions.
- Group files by type, including PDF, PowerPoint, Word, Excel, audio, video, archives, images, and PSIM. Filter by Module or search by keyword.
- Merge repeated references to the same Canvas file while retaining every Module and source page, such as `Week 1 / Week 1 - Lectorial`.
- List external direct file links separately. They are unchecked by default and must be selected explicitly.
- Download selected files individually or as one ZIP, choose a local destination folder, and monitor, pause, resume, or stop downloads.
- Switch between Chinese and English. Everything runs inside the browser; no separate backend or IDM is required.

### Install in Chrome

1. Click **Code → Download ZIP** above, then extract the repository to a permanent location.
2. Open `chrome://extensions` in Chrome and enable **Developer mode** in the top-right corner.
3. Click **Load unpacked** and select the **`canvas-module-files` folder** inside the extracted repository. This folder contains `manifest.json`; do not select the repository's outermost folder.
4. Find **Canvas 文件助手** in Chrome's extensions menu. You can pin it to the toolbar for easier access.

Keep the extracted folder in place because Chrome loads the extension from that location. You do not need Node.js or a running service to use the extension.

### Use the extension

1. Sign in to your institution's Canvas in Chrome and open the course you want to organize.
2. Click **Canvas 文件助手** in the toolbar to open the assistant tab.
3. Select **English** in the language menu, then click **Scan all Modules**. Keep both the course tab and assistant tab open during scanning.
4. Filter by file type, Module, or keyword, then select the attachments you want. External direct file links appear in a separate section and require separate selection.
5. Set the destination, folder layout, and download mode in the download panel, then click **Download selected files** or **Download ZIP**, depending on the selected mode.

The language menu switches between Chinese and English. Course names, Module names, source page titles, and filenames remain in their original language.

#### Download modes and destinations

| Option | Behavior |
| --- | --- |
| One ZIP archive (default) | Collects the selected files into one ZIP. Chrome creates only one download record for the final archive. |
| Individual files | Saves each file separately. With Chrome's default folder, each file creates its own download record. |
| Chrome default download folder | For ZIP downloads, a save dialog opens once the archive is ready. Individual downloads follow Chrome's download settings. |
| Choose local folder… | Opens the system folder picker. After you grant write access, the extension writes the ZIP or individual files directly to that folder. Choose it again each time you open the assistant. |

When you first use ZIP downloads or a custom folder, Chrome may ask for permission to read the selected files' source websites. Once granted, the extension uses the browser's existing signed-in session to retrieve them.

ZIP archives use `Course name_Files_YYYY-MM-DD_HH-mm-ss.zip`, based on your local date and time. The Chinese interface uses `资料` in place of `Files`. For example: `Switched Mode Power Supplies (2650)_Files_2026-10-22_22-15-30.zip`. Chrome downloads and custom folders use the same naming rule, with numbered suffixes for conflicts.

#### Organize by Module and source page

Enable **Create folders by Module** and the source page folder option to use this layout. The ZIP uses the same layout internally:

```text
Canvas/
└── Course name/
    └── Week 1/
        └── Week 1 - Lectorial/
            └── PDF/
                └── lecture.pdf
```

A file referenced by several Modules appears only once in the list. Choose to save one copy or a separate copy in each source folder. Filename conflicts receive a numbered suffix; existing files are not overwritten.

#### Progress and failed files

- Use **Pause all / Resume all / Stop all** to control unfinished tasks in the current course. To retry after stopping, select the files and start a new download.
- If an individual file fails during ZIP collection, the extension skips it and continues with the remaining files. The ZIP includes `文件来源清单.json` (file and source manifest). If any files fail, it also includes `下载失败清单.json` (failure report) with the reasons, Modules, and source pages. If every file fails, no empty ZIP is created.
- Keep the assistant tab open while using ZIP or custom folder downloads. A small amount of in-flight data may remain buffered after pausing. Stopping cleans up unfinished files and keeps completed files.
- Each ZIP must stay below approximately 4 GB and can contain at most 65,533 selected files. Split larger selections into smaller batches.

### FAQ

**Why do some files fail to download?**

An expired Canvas session, locked files, external platform permissions, or an interrupted connection can cause failures. Open the file from its original course page to confirm that your browser can access it, then retry. The extension does not bypass file access permissions.

**How do I update the extension?**

Replace the existing extension folder with the new files, open `chrome://extensions`, and click the extension's reload button. Close old assistant tabs and reopen the assistant from your course.

**Does it keep cached attachments and use up disk space?**

Attachment contents are not cached persistently. Saved course lists are limited to 3 courses, 2 MiB in total, and expire after 30 days. Up to 100 finished task records are retained. Temporary ZIP data is cleaned up after saving, cancellation, or stopping. If the assistant closes unexpectedly, leftover temporary files older than 24 hours are removed the next time it opens or cleanup runs. **Clear local data** removes saved lists and finished task records without deleting downloaded files.

### Development and documentation

Extension source is in `canvas-module-files/`; tests are in `tests/`. Node.js is needed only for development and testing:

```sh
npm ci
npm test
```

Tests cover Module traversal, deduplication, classification, download queues, pause and stop controls, ZIP collection with failed files, storage cleanup, and both interface languages. They use simulated APIs and local files; institution-specific sign-in and cross-site downloads still need verification in Chrome.

- [Detailed behavior and permissions (Chinese)](canvas-module-files/README.md)
- [Adding interface languages (Chinese)](canvas-module-files/LOCALIZATION.md)

This project is licensed under the [MIT License](LICENSE). The bundled fflate ZIP library has its own [MIT license notice](canvas-module-files/vendor/fflate-LICENSE.txt).
