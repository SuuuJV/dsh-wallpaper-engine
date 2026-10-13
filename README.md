# Wallpaper Engine Background for DeepSeek Harness

Browse your own **Wallpaper Engine** library and use it as the DeepSeek Harness
app background, with frosted translucent panels.

Unlike most theme plugins, this one reads your actual workshop library — and for
`scene` wallpapers it pulls the **full-resolution artwork straight out of
`scene.pkg`** instead of settling for the ~768 px `preview.jpg` thumbnail.

[中文说明](#中文说明)

---

## Features

- **Reads your real Wallpaper Engine library** — points at your Steam workshop
  folder and lists every subscribed wallpaper with its title.
- **Full-resolution artwork** — Wallpaper Engine's `scene.pkg` container stores
  its textures as plain JPEG/PNG streams, so they can be recovered by scanning
  for image magic bytes. This gets you the original 1920×1080 / 3840×2160 art
  rather than the small preview thumbnail.
- **Animated previews** — many wallpapers ship an animated `preview.gif`
  instead of a still. The picker marks those with a 动 badge, and a toggle lets
  you prefer the animation over the sharper extracted still.
- **Picker with search** — thumbnail grid, filter by title or workshop id.
- **Four live sliders** — panel opacity, wallpaper blur, background dim, and
  wallpaper brightness. Everything is persisted per browser.
- **Light and dark aware** — the overlay tint follows the app's colour scheme,
  so text stays readable in both.

## Requirements

- DeepSeek Harness with a Web GUI profile.
- Wallpaper Engine installed via Steam (any platform).
- A Chromium-based browser or the DSH desktop app (needs the directory picker
  and Blob URLs).

## Install

From a checkout of this repository:

```sh
dsh plugin install /absolute/path/to/dsh-wallpaper-engine
```

Or, from inside a DSH session, ask the agent to run `plugin_manager` with
`action: install_bundle` and `target` set to this directory.

Then enable **Wallpaper Engine Background** in *Settings → Plugins* if it is not
already on.

## Usage

1. Open **Settings → Wallpaper Engine Background**.
2. Click **Choose Wallpaper Engine folder** and select your workshop content
   directory:
   - Windows: `C:\Program Files (x86)\Steam\steamapps\workshop\content\431960`
     (or wherever your Steam library lives — the folder is named after
     Wallpaper Engine's Steam app id, `431960`)
   - Linux: `~/.steam/steam/steamapps/workshop/content/431960`
   - macOS: `~/Library/Application Support/Steam/steamapps/workshop/content/431960`
3. Pick a wallpaper from the grid, then tune the sliders.

> The folder selection is remembered when the browser allows it. If it is not
> remembered, you will be asked to re-select the folder after a reload — that is
> a browser security rule, not a bug.

## How it works

The whole plugin is client-side.

1. **Scan.** Reading the chosen directory gives you one subfolder per wallpaper,
   each with a `project.json` (which carries the title) and either a
   `preview.jpg` / `preview.gif` or a `scene.pkg`.

2. **List.** Titles and small thumbnails build the picker. Only the tiny preview
   files are read at this stage, so listing a large library stays cheap.

3. **Extract.** When you select a `scene` wallpaper, its `scene.pkg` is read as
   bytes and scanned for embedded JPEG (`FF D8 FF … FF D9`) and PNG
   (`89 50 4E 47 … IEND`) streams. The largest one at least 1280 px wide is the
   artwork. This happens only for the wallpaper you actually select.

4. **Apply.** The artwork becomes a Blob URL on a `position: fixed;
   z-index: -1` layer behind the app. Because every ancestor of that layer
   paints its own background *above* a negative-z-index child, the frame's
   background is cleared, and `theme.overrideTokens()` makes the panel tokens
   translucent — which is the only way to change them, since the theme
   presenter writes them as inline styles on `<body>`.

## Limitations

- **Video wallpapers are not played.** Wallpapers of type `video` carry an
  `.mp4` instead of a `scene.pkg`. Decoding video behind the UI would cost CPU
  continuously, so this plugin uses their preview file instead — which, when it
  is a `preview.gif`, happens to animate for free.
- **The animated option trades sharpness for motion.** A `preview.gif` is a few
  hundred pixels wide, so preferring it over the extracted `scene.pkg` artwork
  is visibly softer. In the sampled library 36 of 86 wallpapers had an animated
  preview, and 21 of those also had a `scene.pkg` — meaning the toggle actually
  changes the result for them.
- **`scene.pkg` extraction is heuristic.** It finds the largest embedded image.
  A few packages store nothing usable (their preview image is used instead), and
  theoretically a package could have a larger decorative texture than its
  artwork. Out of 86 sampled wallpapers, 58 extracted correctly.
- **A folder re-pick may be needed after reload**, depending on how the browser
  persists directory handles.
- **Steam's per-wallpaper folders are keyed by workshop id**, which says nothing
  about the artwork; titles come from each `project.json`.

## License

MIT. Wallpaper artwork belongs to its respective authors — this plugin reads the
files on your own machine and ships none of them.

---

<a id="中文说明"></a>
## 中文说明

把你自己的 **Wallpaper Engine** 壁纸库用作 DeepSeek Harness 的应用背景，面板半透明磨砂。

和大多数主题插件不同，这个插件读的是你**真实的创意工坊壁纸库**；对于 `scene` 类型的壁纸，它会**直接从 `scene.pkg` 里取出全分辨率原图**，而不是将就那张约 768px 的 `preview.jpg` 缩略图。

### 特点

- **读取你真实的壁纸库** —— 指向你的 Steam 创意工坊目录，列出每一张订阅壁纸的名称。
- **全分辨率原图** —— Wallpaper Engine 的 `scene.pkg` 内部以明文 JPEG/PNG 流存放贴图，通过扫描图片魔数即可提取。拿到的是原始 1920×1080 / 3840×2160 画面，而不是小预览图。
- **支持动态壁纸** —— 不少壁纸用的是会动的 `preview.gif` 而不是静态图。选择器会给这类壁纸打上「动」标记，并有开关让你在「动图」和「更清晰的 pkg 原图」之间二选一。
- **带搜索的选择器** —— 缩略图网格，可按名称或创意工坊 ID 过滤。
- **四个实时滑块** —— 面板透明度、壁纸模糊、背景压暗、壁纸亮度。设置按浏览器保存。
- **适配明暗主题** —— 叠加色调跟随应用配色，两种模式下文字都清晰。

### 安装

在仓库目录下执行：

```sh
dsh plugin install /本仓库的绝对路径/dsh-wallpaper-engine
```

或者，在 DSH 会话里让 agent 调用 `plugin_manager`，`action: install_bundle`，`target` 指向本目录。

然后在 **设置 → 插件** 里确认「Wallpaper Engine 壁纸背景」已启用。

### 使用

1. 打开 **设置 → Wallpaper Engine 壁纸背景**。
2. 点 **选择文件夹…**，选中你的创意工坊内容目录：
   - Windows：`C:\Program Files (x86)\Steam\steamapps\workshop\content\431960`
     （或者你 Steam 库所在的位置；`431960` 是 Wallpaper Engine 的 Steam app id）
   - Linux：`~/.steam/steam/steamapps/workshop/content/431960`
   - macOS：`~/Library/Application Support/Steam/steamapps/workshop/content/431960`
3. 在网格里选一张壁纸，然后用滑块调整观感。

> 文件夹选择在浏览器允许的情况下会被记住。如果没有记住，刷新后需要重新选一次 —— 这是浏览器的安全规定，不是 bug。

### 工作原理

整个插件都在客户端运行。

1. **扫描**：读你选中的目录，每张壁纸是一个子文件夹，里面有 `project.json`（存标题），以及 `preview.jpg` / `preview.gif` 或 `scene.pkg`。
2. **列清单**：标题 + 小缩略图构成选择器。这一步只读很小的预览文件，所以即使壁纸库很大也很快。
3. **提取**：当你选中一张 `scene` 壁纸时，读取它的 `scene.pkg` 字节流，扫描其中内嵌的 JPEG（`FF D8 FF … FF D9`）和 PNG（`89 50 4E 47 … IEND`）流，取其中宽度至少 1280px 的最大一张，即为原画。**只对你实际选中的那张做这件事。**
4. **应用**：原画变成一个 Blob URL，放在 `position: fixed; z-index: -1` 的层上。由于 CSS 绘制顺序里所有普通块级元素（`html`、`body`、`#root`、应用框架）都画在负层级元素**之上**，必须把框架背景清成透明，并用 `theme.overrideTokens()` 把面板 token 改成半透明 —— 这是唯一可行的办法，因为主题呈现器把这些 token 作为**内联样式写在 `<body>` 上**，CSS 规则（哪怕加了 `!important`）都盖不过它。

### 已知限制

- **视频类壁纸不会被播放。** `video` 类型的壁纸是 `.mp4` 而不是 `scene.pkg`。在界面背后持续解码视频会一直占用 CPU，所以这类壁纸用它们的预览文件 —— 而当预览文件是 `preview.gif` 时，它正好是动的，等于白捡了动态效果。
- **动态选项是拿清晰度换动作。** `preview.gif` 只有几百像素宽，所以优先用它会明显比抠出来的 `scene.pkg` 原图糊。在抽样的壁纸库里，86 张中有 36 张带动态预览，其中 21 张同时也有 `scene.pkg` —— 也就是说对它们而言这个开关是真的会改变效果的。
- **`scene.pkg` 提取是启发式的。** 它取内嵌图片里最大的一张。少数包没有可用图片（则回退到预览图），理论上也可能存在比原画更大的装饰性贴图。抽样的 86 张壁纸里，58 张提取正确。
- **刷新后可能需要重新选文件夹**，取决于浏览器对目录句柄的持久化行为。
- **Steam 的每张壁纸文件夹以创意工坊 ID 命名**，看不出画面内容；标题来自各自的 `project.json`。

### 许可

MIT。壁纸画面的版权属于各自的作者 —— 本插件只读取你自己机器上的文件，不附带任何壁纸。
