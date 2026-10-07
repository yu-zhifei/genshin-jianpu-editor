// 只读预览模式：供 ScoreFlow 侧边栏通过 iframe 内嵌，复用整套编辑器 App。
// 由 URL 查询参数驱动，并通过 postMessage 与父页面通信。
//   ?readonly=1&src=<musicxml|mid url>&mode=jianpu|staff&theme=light|dark
// 父页面可发 { type: "export", format } 触发导出（复用 editor/export.ts）。
// 预览模式下额外注入悬浮播放/停止按钮（仅简谱视图）：按钮在 iframe 内，点击即
// 真实用户手势，避免自动播放策略拦截音频。
//
// 设计约定：不新增渲染逻辑，只做「隐藏编辑 UI + 装载文件 + 通信」。

import type { App } from "./editor/app";
import { exportByFormat, type ExportFormat } from "./editor/export";
import type { PlayState } from "./editor/player";

type ViewMode = "jianpu" | "staff";

interface PreviewParams {
  readonly: boolean;
  src: string | null;
  fileName: string;
  mode: ViewMode;
  theme: "light" | "dark" | null;
}

function parseParams(): PreviewParams {
  const params = new URLSearchParams(window.location.search);
  const src = params.get("src");

  let fileName = "score.musicxml";
  if (src) {
    try {
      const last = new URL(src, window.location.href).pathname.split("/").filter(Boolean).pop();
      if (last) fileName = decodeURIComponent(last);
    } catch {
      // 相对/非法 URL：保留默认文件名
    }
  }

  const rawTheme = params.get("theme");
  return {
    readonly: params.get("readonly") === "1",
    src,
    fileName,
    mode: params.get("mode") === "staff" ? "staff" : "jianpu",
    theme: rawTheme === "dark" || rawTheme === "light" ? rawTheme : null,
  };
}

function postToParent(type: string, payload: Record<string, unknown> = {}): void {
  let embedded = false;
  try {
    embedded = window.parent !== window;
  } catch {
    embedded = true; // 跨源时访问 parent 可能抛错，视为已嵌入
  }
  if (!embedded) return;
  window.parent.postMessage({ source: "score-viewer", type, ...payload }, "*");
}

function applyTheme(theme: "light" | "dark"): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document
    .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "dark" ? "#101014" : "#FFFBFF");
}

function postRendered(): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      postToParent("rendered", { height: document.documentElement.scrollHeight });
    });
  });
}

const EXPORT_FORMATS: readonly ExportFormat[] = [
  "png",
  "pdf",
  "pptx",
  "midi",
  "musicxml",
  "keyboard",
  "number",
  "jpw",
];

function isExportFormat(value: unknown): value is ExportFormat {
  return typeof value === "string" && (EXPORT_FORMATS as readonly string[]).includes(value);
}

/**
 * 简谱模式的悬浮播放/停止按钮。按钮必须位于 iframe 内部，用户点击才算
 * 真实手势，否则跨源 postMessage 触发的 AudioContext 会被浏览器自动播放
 * 策略拦截（无法出声）。返回切换视图时用来显隐按钮的函数。
 */
function setupPlaybackControl(app: App): (mode: ViewMode) => void {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "preview-playback-toggle";
  btn.dataset.busy = "false";
  btn.textContent = "▶ 播放";
  btn.title = "从头播放";

  btn.addEventListener("click", () => app.togglePlayback());
  app.setPlaybackStateListener((state: PlayState) => {
    const busy = state === "playing" || state === "loading";
    btn.dataset.busy = String(busy);
    btn.disabled = state === "loading";
    btn.setAttribute("aria-pressed", String(busy));
    btn.textContent = state === "loading" ? "加载中…" : busy ? "■ 停止" : "▶ 播放";
    btn.title = busy ? "停止播放" : "从头播放";
  });
  document.body.append(btn);

  // 播放仅在简谱（jp）模式可用；五线谱/混排下隐藏按钮。
  return (mode) => {
    btn.hidden = mode !== "jianpu";
  };
}

/**
 * 在 App 启动完成后调用。仅当 URL 带有 read-only/src 参数时才生效，
 * 否则完全不改变普通编辑器行为。
 */
export async function setupPreviewMode(app: App): Promise<void> {
  const params = parseParams();
  if (!params.readonly && !params.src) return;

  if (params.theme) applyTheme(params.theme);
  // 与 index.html 的首屏内联脚本一致：挂在 <html> 上（此处为兜底/直接访问时补挂）。
  document.documentElement.classList.add("preview-mode");

  const syncPlaybackMode = setupPlaybackControl(app);
  syncPlaybackMode(params.mode);

  window.addEventListener("message", (event) => {
    const data = event.data as {
      type?: string;
      mode?: string;
      theme?: string;
      format?: string;
    } | null;
    if (!data || typeof data.type !== "string") return;
    if (data.type === "setMode" && (data.mode === "jianpu" || data.mode === "staff")) {
      syncPlaybackMode(data.mode);
      void app.setViewMode(data.mode).then(postRendered);
    } else if (data.type === "setTheme" && (data.theme === "light" || data.theme === "dark")) {
      applyTheme(data.theme);
    } else if (data.type === "export" && isExportFormat(data.format)) {
      const format = data.format;
      void exportByFormat(app, format)
        .then(() => postToParent("exported", { format }))
        .catch((error) =>
          postToParent("export-error", {
            format,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
    }
  });

  postToParent("ready");

  if (!params.src) return;
  try {
    const resp = await fetch(params.src);
    if (!resp.ok) throw new Error(`加载乐谱失败（HTTP ${resp.status}）`);
    const bytes = new Uint8Array(await resp.arrayBuffer());
    // 只读预览不做交互：MusicXML/MIDI 均跳过导入选项弹窗，直接用默认选项。
    await app.importBytes(bytes, params.fileName, {
      skipMusicXmlDialog: true,
      skipMidiDialog: true,
    });
    await app.setViewMode(params.mode);
    postRendered();
  } catch (error) {
    postToParent("error", { message: error instanceof Error ? error.message : String(error) });
  }
}
