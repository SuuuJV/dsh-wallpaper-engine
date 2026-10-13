# Wallpaper Engine Background for DeepSeek Harness

Browse your own **Wallpaper Engine** library and use it as the DeepSeek Harness
app background, with frosted translucent panels.

Unlike most theme plugins, this one reads your actual workshop library — and for
`scene` wallpapers it **renders the scene's texture layers** out of `scene.pkg`,
so you get the artwork itself rather than one layer of it or the ~768 px
`preview.jpg` thumbnail.

[中文说明](#中文说明)

---

## Features

- **Reads your real Wallpaper Engine library** — points at your Steam workshop
  folder and lists every subscribed wallpaper with its title.
- **Full-resolution artwork** — a `scene.pkg` holds the picture as a stack of
  texture layers (plus masks, sprite sheets and shaders) that Wallpaper Engine
  blends at runtime. This plugin parses the container, decodes the layers —
  stored PNG/JPEG streams, raw RGBA, DXT5/DXT1, LZ4-compressed or not — and
  composites them in scene order. That gets you the original 1920×1080 /
  3840×2160 art instead of one arbitrary layer or the small preview thumbnail.
- **Animated previews** — many wallpapers ship an animated `preview.gif`
  instead of a still. The picker marks those with a 动 badge, and a toggle lets
  you prefer the animation over the sharper composited still.
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

1. Open **Settings → Wallpaper Engine 壁纸**.
2. Click **Choose Wallpaper Engine folder** and select your workshop content
   directory:
   - Windows: `C:\Program Files (x86)\Steam\steamapps\workshop\content\431960`
     (or wherever your Steam library lives — the folder is named after
     Wallpaper Engine's Steam app id, `431960`)
   - Linux: `~/.steam/steam/steamapps/workshop/content/431960`
   - macOS: `~/Library/Application Support/Steam/steamapps/workshop/content/431960`
3. Pick a wallpaper from the grid, then tune the sliders.

> **New wallpapers.** There is no filesystem watcher — the browser exposes no
> directory-change event — so a wallpaper you download in Wallpaper Engine will
> not appear by itself. Press **Rescan** in the settings page (or reload), and it
> is picked up.
>
> **Across a browser restart.** The folder handle is stored in IndexedDB. When
> the browser still grants read access the library reloads by itself; when the
> grant has lapsed back to "prompt" (which needs a user gesture), a one-click
> **Grant access and scan** button appears instead. That is a browser security
> rule, not a bug.

## How it works

The whole plugin is client-side.

1. **Scan.** Reading the chosen directory gives you one subfolder per wallpaper,
   each with a `project.json` (which carries the title) and either a
   `preview.jpg` / `preview.gif` or a `scene.pkg`.

2. **List.** Titles and small thumbnails build the picker. Only the tiny preview
   files are read at this stage, so listing a large library stays cheap.

3. **Render.** When you select a `scene` wallpaper, its `scene.pkg` is parsed:
   the PKGV file table, `scene.json`'s object list, and each object's
   model → material → `.tex` chain. Textures are decoded (stored PNG/JPEG
   streams, raw RGBA, DXT5/DXT1, single channel masks — LZ4-compressed when the
   container says so) and composited bottom-up at 1920 px wide, which is the
   picture Wallpaper Engine would show. This happens only for the wallpaper you
   actually select.

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
  hundred pixels wide, so preferring it over the composited `scene.pkg` artwork
  is visibly softer. In the sampled library 36 of 86 wallpapers had an animated
  preview, and 21 of those also had a `scene.pkg` — meaning the toggle actually
  changes the result for them.
- **Some scenes fall back to their preview.** A scene whose subject is a puppet
  (a bone-deformed mesh, which is a rasteriser of its own) or a script-driven
  layer composites to a partial or flat picture. When that happens the preview
  image is used instead — blurry, but the actual artwork. In the sampled library
  this affected 2 of 63 scene packages.
- **Sprite sheets are skipped.** An animation atlas drawn whole would show every
  frame at once, so those objects are left out; they are the falling petals and
  sparks, never the picture.
- **Sharpness varies a lot between wallpapers**, and the settings page says so:
  it reports the composited size and layer count and flags anything under
  1280 px. Two reasons. First, the source itself: Wallpaper Engine's
  `preview.jpg` ranges from 160 px to 1080 px in the sampled library, and a
  `scene.pkg` whose artwork is a single small texture stays small. Second,
  `background-size: cover` scales by whichever axis needs more, so a *square*
  728×728 preview in a wide window is upscaled by its width — far more than a
  1920×1080 image would be. Raising **wallpaper blur** hides a low-resolution
  source rather well.
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

和大多数主题插件不同，这个插件读的是你**真实的创意工坊壁纸库**；对于 `scene` 类型的壁纸，它会把 `scene.pkg` 里的**图层合成成完整原画**，而不是只取其中一层、也不是将就那张约 768px 的 `preview.jpg` 缩略图。

### 特点

- **读取你真实的壁纸库** —— 指向你的 Steam 创意工坊目录，列出每一张订阅壁纸的名称。
- **全分辨率原图** —— `scene.pkg` 里的画面其实是**一堆贴图图层**（外加遮罩、精灵图集、着色器），由 Wallpaper Engine 在运行时按顺序混合而成。本插件解析 PKGV 容器，解码各图层（内嵌 PNG/JPEG 流、原始 RGBA、DXT5/DXT1、单通道遮罩，按标记决定是否 LZ4 解压），再按场景顺序合成。拿到的是原始 1920×1080 / 3840×2160 画面，而不是随便一层贴图或小预览图。
- **支持动态壁纸** —— 不少壁纸用的是会动的 `preview.gif` 而不是静态图。选择器会给这类壁纸打上「动」标记，并有开关让你在「动图」和「更清晰的合成原图」之间二选一。
- **带搜索的选择器** —— 缩略图网格，可按名称或创意工坊 ID 过滤。
- **四个实时滑块** —— 面板透明度、壁纸模糊、背景压暗、壁纸亮度。设置按浏览器保存。
- **适配明暗主题** —— 叠加色调跟随应用配色，两种模式下文字都清晰。

### 安装

在仓库目录下执行：

```sh
dsh plugin install /本仓库的绝对路径/dsh-wallpaper-engine
```

或者，在 DSH 会话里让 agent 调用 `plugin_manager`，`action: install_bundle`，`target` 指向本目录。

然后在 **设置 → 插件** 里确认「Wallpaper Engine 壁纸」已启用。

### 使用

1. 打开 **设置 → Wallpaper Engine 壁纸**。
2. 点 **选择文件夹…**，选中你的创意工坊内容目录：
   - Windows：`C:\Program Files (x86)\Steam\steamapps\workshop\content\431960`
     （或者你 Steam 库所在的位置；`431960` 是 Wallpaper Engine 的 Steam app id）
   - Linux：`~/.steam/steam/steamapps/workshop/content/431960`
   - macOS：`~/Library/Application Support/Steam/steamapps/workshop/content/431960`
3. 在网格里选一张壁纸，然后用滑块调整观感。

> **新下载的壁纸。** 没有文件系统监听 —— 浏览器不提供目录变更事件 —— 所以你在 Wallpaper Engine 里新下载的壁纸不会自己冒出来。在设置页点一下 **「重新扫描」**（或者刷新页面）就会读到。
>
> **浏览器重启后。** 文件夹句柄存在 IndexedDB 里。浏览器仍保留读取授权时，壁纸库会自动恢复；授权回退成"需要询问"时（这种情况必须要用户点一下），界面会显示一个 **「恢复授权并扫描」** 按钮，点一次即可。这是浏览器的安全规定，不是 bug。

### 工作原理

整个插件都在客户端运行。

1. **扫描**：读你选中的目录，每张壁纸是一个子文件夹，里面有 `project.json`（存标题），以及 `preview.jpg` / `preview.gif` 或 `scene.pkg`。
2. **列清单**：标题 + 小缩略图构成选择器。这一步只读很小的预览文件，所以即使壁纸库很大也很快。
3. **合成**：当你选中一张 `scene` 壁纸时，解析它的 `scene.pkg`：PKGV 文件表、`scene.json` 的对象列表，以及每个对象的 模型 → 材质 → `.tex` 链路。贴图被逐一解码（内嵌 PNG/JPEG 流、原始 RGBA、DXT5/DXT1、单通道遮罩，容器标记为 LZ4 时先解压），然后自下而上合成成 1920px 宽的整幅画面 —— 也就是 Wallpaper Engine 会显示的那张图。**只对你实际选中的那张做这件事。**
4. **应用**：原画变成一个 Blob URL，放在 `position: fixed; z-index: -1` 的层上。由于 CSS 绘制顺序里所有普通块级元素（`html`、`body`、`#root`、应用框架）都画在负层级元素**之上**，必须把框架背景清成透明，并用 `theme.overrideTokens()` 把面板 token 改成半透明 —— 这是唯一可行的办法，因为主题呈现器把这些 token 作为**内联样式写在 `<body>` 上**，CSS 规则（哪怕加了 `!important`）都盖不过它。

### 已知限制

- **视频类壁纸不会被播放。** `video` 类型的壁纸是 `.mp4` 而不是 `scene.pkg`。在界面背后持续解码视频会一直占用 CPU，所以这类壁纸用它们的预览文件 —— 而当预览文件是 `preview.gif` 时，它正好是动的，等于白捡了动态效果。
- **动态选项是拿清晰度换动作。** `preview.gif` 只有几百像素宽，所以优先用它会明显比合成的 `scene.pkg` 原图糊。在抽样的壁纸库里，86 张中有 36 张带动态预览，其中 21 张同时也有 `scene.pkg` —— 也就是说对它们而言这个开关是真的会改变效果的。
- **少数场景会回退到预览图。** 如果一张场景壁纸的主体是 puppet（骨骼形变网格，需要单独的网格光栅化器）或者位置由脚本驱动的图层，合成出来就会缺主体、或者是一片纯色；这时改用预览图 —— 糊，但至少是原画。抽样库里 63 个场景包中有 2 个属于这种情况。
- **精灵图集会被跳过。** 动画图集整张贴上去会把所有帧一次显示出来，所以这类对象不参与合成；它们都是飘落的花瓣、火星之类的点缀，从来不是画面主体。
- **不同壁纸的清晰度差别很大**，设置页也会如实告诉你：它会显示合成尺寸和图层数，低于 1280px 的会标黄提醒。原因有两个。一是**源图本身**：抽样库里 Wallpaper Engine 的 `preview.jpg` 从 160px 到 1080px 不等，而某些 `scene.pkg` 的原画本来就是一张小贴图。二是 `background-size: cover` 会按“需要放大更多的那条边”来缩放，所以一张**方形**的 728×728 预览图在宽窗口里是按宽度放大的，放大倍数远高于 1920×1080 的图。把**「壁纸模糊」调高**能相当有效地掩盖低分辨率源图。
- **刷新后可能需要重新选文件夹**，取决于浏览器对目录句柄的持久化行为。
- **Steam 的每张壁纸文件夹以创意工坊 ID 命名**，看不出画面内容；标题来自各自的 `project.json`。

### 许可

MIT。壁纸画面的版权属于各自的作者 —— 本插件只读取你自己机器上的文件，不附带任何壁纸。
