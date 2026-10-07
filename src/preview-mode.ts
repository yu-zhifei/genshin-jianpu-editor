// 只读预览模式：供 ScoreFlow 侧边栏通过 iframe 内嵌，复用整套编辑器 App。
// 由 URL 查询参数驱动，并通过 postMessage 与父页面通信。
//   ?readonly=1&src=<musicxml|mid url>&mode=jianpu|staff&theme=light|dark
//
// 设计约定：不新增渲染逻辑，只做「隐藏编辑 UI + 装载文件 + 通信」。

import type { App } from "./editor/app";

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

  window.addEventListener("message", (event) => {
    const data = event.data as { type?: string; mode?: string; theme?: string } | null;
    if (!data || typeof data.type !== "string") return;
    if (data.type === "setMode" && (data.mode === "jianpu" || data.mode === "staff")) {
      void app.setViewMode(data.mode).then(postRendered);
    } else if (data.type === "setTheme" && (data.theme === "light" || data.theme === "dark")) {
      applyTheme(data.theme);
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
