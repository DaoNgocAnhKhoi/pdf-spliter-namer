/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Requires: npm install jszip
 */

import React, { useEffect, useRef, useState } from "react";
import { PDFDocument } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist";
import JSZip from "jszip";
import {
  AlertTriangle,
  Archive,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Download,
  FileText,
  Files,
  Loader2,
  Maximize2,
  RotateCcw,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

const PDF_MIME_TYPE = "application/pdf";
const A4_PORTRAIT: [number, number] = [595.28, 841.89];
const A4_LANDSCAPE: [number, number] = [841.89, 595.28];
const ACCEPT_PDF = "application/pdf,.pdf";
const ACCEPT_MERGE_FILES =
  "application/pdf,.pdf,image/jpeg,.jpg,.jpeg,image/png,.png";

type AppMode = "home" | "split" | "batch-split" | "batch-merge" | "merge-all";

type BatchMergeResult = {
  successCount: number;
  failedFiles: string[];
};

type MergeAllResult = {
  successCount: number;
  totalPages: number;
  failedFiles: string[];
};

type BatchSplitResult = {
  successFileCount: number;
  generatedFileCount: number;
  failedFiles: string[];
};

type WorkProgress = {
  completed: number;
  total: number;
};

// Thay các đường dẫn dưới đây bằng ảnh landscape của bạn.
// Nên dùng ảnh tỉ lệ 16:9 hoặc 3:2, đặt trong thư mục public/images/pdf-toolkit/.
const HOME_IMAGES = {
  hero: "/images/tap_vo.jpg",
  workflow: "/images/hanh_quan.jpg",
  ordering: "/images/a7_khoc.jpg",
  closing: "/images/tet.jpg",
};

interface PagePreviewProps {
  pdfDoc: pdfjsLib.PDFDocumentProxy | null;
  pageNumber: number;
}

interface SelectedFileListProps {
  files: File[];
  emptyText?: string;
  onMove?: (fromIndex: number, toIndex: number) => void;
  disabled?: boolean;
}

type SplitRange = {
  startIndex: number;
  endIndexExclusive: number;
  pageIndices: number[];
};

/**
 * Trả về đúng tập trang đang xem và sẽ được xuất.
 * Mọi nơi (preview, tên file, export, điều hướng) đều dùng chung hàm này
 * để không còn tình trạng màn hình hiển thị một nhóm nhưng file tải về là nhóm khác.
 */
function getSplitRange(
  startIndex: number,
  totalPages: number,
  pagesPerBatch: number,
): SplitRange {
  const safeTotalPages = Math.max(0, totalPages);
  const safePagesPerBatch = Math.max(1, Math.floor(pagesPerBatch));
  const maxStartIndex = Math.max(0, safeTotalPages - 1);
  const safeStartIndex = Math.min(Math.max(0, startIndex), maxStartIndex);
  const endIndexExclusive = Math.min(
    safeStartIndex + safePagesPerBatch,
    safeTotalPages,
  );

  return {
    startIndex: safeStartIndex,
    endIndexExclusive,
    pageIndices: Array.from(
      { length: Math.max(0, endIndexExclusive - safeStartIndex) },
      (_, offset) => safeStartIndex + offset,
    ),
  };
}

function makeDefaultSplitFileName(
  sourceFileName: string,
  startIndex: number,
  endIndexExclusive: number,
) {
  return `${stripExtension(sourceFileName)}_trang_${startIndex + 1}-${endIndexExclusive}`;
}

const setWorker = () => {
  if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;
  }
};
setWorker();

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

function hasExtension(file: File, extensions: string[]) {
  const lowerName = file.name.toLowerCase();
  return extensions.some((extension) => lowerName.endsWith(extension));
}

function isPdfFile(file: File) {
  return file.type === PDF_MIME_TYPE || hasExtension(file, [".pdf"]);
}

function isPngFile(file: File) {
  return file.type === "image/png" || hasExtension(file, [".png"]);
}

function isJpegFile(file: File) {
  return (
    file.type === "image/jpeg" ||
    file.type === "image/jpg" ||
    hasExtension(file, [".jpg", ".jpeg"])
  );
}

function isSupportedMergeFile(file: File) {
  return isPdfFile(file) || isPngFile(file) || isJpegFile(file);
}

function stripExtension(fileName: string) {
  return fileName.replace(/\.[^/.]+$/, "");
}

function safeFileName(fileName: string) {
  return fileName.replace(/[\\/:*?"<>|]/g, "_").trim() || "tai_lieu";
}

function sortFilesNaturally(files: File[]) {
  return [...files].sort((a, b) =>
    a.name.localeCompare(b.name, "vi", {
      numeric: true,
      sensitivity: "base",
    }),
  );
}

function moveArrayItem<T>(items: T[], fromIndex: number, toIndex: number) {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    fromIndex >= items.length ||
    toIndex < 0 ||
    toIndex >= items.length
  ) {
    return items;
  }

  const nextItems = [...items];
  const [movedItem] = nextItems.splice(fromIndex, 1);
  nextItems.splice(toIndex, 0, movedItem);
  return nextItems;
}

function downloadBlob(blob: Blob, downloadName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = downloadName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function makeTimestamp() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");

  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(
    now.getDate(),
  )}_${pad(now.getHours())}${pad(now.getMinutes())}`;
}

function makeZipFileName(prefix: string) {
  return `${prefix}_${makeTimestamp()}.zip`;
}

function makeUniquePdfName(baseName: string, usedNames: Set<string>) {
  const cleanBaseName = safeFileName(baseName);
  let candidate = `${cleanBaseName}.pdf`;
  let suffix = 2;

  while (usedNames.has(candidate)) {
    candidate = `${cleanBaseName}_${suffix}.pdf`;
    suffix += 1;
  }

  usedNames.add(candidate);
  return candidate;
}

async function appendImageToPdf(targetPdf: PDFDocument, file: File) {
  const imageBytes = await file.arrayBuffer();
  const image = isPngFile(file)
    ? await targetPdf.embedPng(imageBytes)
    : await targetPdf.embedJpg(imageBytes);

  const lastPage =
    targetPdf.getPageCount() > 0
      ? targetPdf.getPage(targetPdf.getPageCount() - 1)
      : null;
  const defaultSize =
    image.width > image.height ? A4_LANDSCAPE : A4_PORTRAIT;
  const { width, height } = lastPage?.getSize() ?? {
    width: defaultSize[0],
    height: defaultSize[1],
  };

  const page = targetPdf.addPage([width, height]);
  const margin = 18;
  const dimensions = image.scaleToFit(width - margin * 2, height - margin * 2);

  page.drawImage(image, {
    x: (width - dimensions.width) / 2,
    y: (height - dimensions.height) / 2,
    width: dimensions.width,
    height: dimensions.height,
  });
}

async function appendFileToPdf(targetPdf: PDFDocument, file: File) {
  if (isPdfFile(file)) {
    const sourcePdf = await PDFDocument.load(await file.arrayBuffer());
    const copiedPages = await targetPdf.copyPages(
      sourcePdf,
      sourcePdf.getPageIndices(),
    );
    copiedPages.forEach((page) => targetPdf.addPage(page));
    return;
  }

  if (isPngFile(file) || isJpegFile(file)) {
    await appendImageToPdf(targetPdf, file);
    return;
  }

  throw new Error(`Định dạng không hỗ trợ: ${file.name}`);
}

async function createMergedPdf(frontFile: File, backFile: File) {
  const mergedPdf = await PDFDocument.create();
  await appendFileToPdf(mergedPdf, frontFile);
  await appendFileToPdf(mergedPdf, backFile);
  return mergedPdf.save();
}

const SelectedFileList: React.FC<SelectedFileListProps> = ({
  files,
  emptyText = "Chưa có file nào được chọn.",
  onMove,
  disabled = false,
}) => {
  const canReorder = Boolean(onMove);

  const moveToPosition = (fromIndex: number) => {
    if (!onMove || disabled) return;

    const input = window.prompt(
      `Chuyển "${files[fromIndex].name}" đến vị trí nào? (1–${files.length})`,
      String(fromIndex + 1),
    );

    if (input === null || input.trim() === "") return;

    const targetPosition = Number(input);
    if (
      !Number.isInteger(targetPosition) ||
      targetPosition < 1 ||
      targetPosition > files.length
    ) {
      alert(`Vị trí phải là số từ 1 đến ${files.length}.`);
      return;
    }

    onMove(fromIndex, targetPosition - 1);
  };

  if (files.length === 0) {
    return (
      <p className="rounded-xl bg-zinc-50 p-4 text-sm text-zinc-500">
        {emptyText}
      </p>
    );
  }

  return (
    <div>
      <div className="max-h-80 overflow-y-auto rounded-xl border border-zinc-100 bg-zinc-50 p-3">
        {files.map((selectedFile, index) => (
          <div
            key={`${selectedFile.name}-${selectedFile.lastModified}-${index}`}
            className="flex items-center gap-3 border-b border-zinc-100 px-2 py-2 last:border-b-0"
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-xs font-bold text-zinc-600">
              {index + 1}
            </span>
            <p
              className="min-w-0 flex-1 truncate text-sm font-medium"
              title={selectedFile.name}
            >
              {selectedFile.name}
            </p>

            {canReorder && (
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => onMove?.(index, index - 1)}
                  disabled={disabled || index === 0}
                  title="Đưa file lên một vị trí"
                  aria-label={`Đưa ${selectedFile.name} lên một vị trí`}
                  className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-zinc-200 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <ChevronUp className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => onMove?.(index, index + 1)}
                  disabled={disabled || index === files.length - 1}
                  title="Đưa file xuống một vị trí"
                  aria-label={`Đưa ${selectedFile.name} xuống một vị trí`}
                  className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-zinc-200 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <ChevronDown className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => moveToPosition(index)}
                  disabled={disabled}
                  title="Chuyển file đến vị trí bất kỳ"
                  aria-label={`Chuyển ${selectedFile.name} đến vị trí khác`}
                  className="rounded-lg border border-zinc-200 bg-white px-2 py-1 text-[11px] font-bold text-zinc-600 transition hover:border-zinc-400 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-30"
                >
                  Đến
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {canReorder && (
        <p className="mt-3 text-xs leading-5 text-zinc-500">
          Dùng nút ↑, ↓ để đổi thứ tự từng file; chọn “Đến” để chuyển nhanh đến một vị trí bất kỳ.
        </p>
      )}
    </div>
  );
};

const ProgressBar: React.FC<WorkProgress> = ({ completed, total }) => {
  const value = total > 0 ? Math.min(100, (completed / total) * 100) : 0;

  return (
    <div className="mt-5 rounded-2xl border border-zinc-200/70 bg-zinc-50 p-5">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium text-zinc-600">Tiến độ</span>
        <span className="font-bold">
          {completed} / {total}
        </span>
      </div>
      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-zinc-200">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${value}%` }}
          className="h-full rounded-full bg-zinc-900"
        />
      </div>
    </div>
  );
};

type ReaderPreviewProps = {
  pdfDoc: pdfjsLib.PDFDocumentProxy | null;
  pageNumber: number;
  onClose: () => void;
};

/**
 * Chế độ đọc rõ: không cố ép trang A4/A3 vào một ô nhỏ.
 * Trang được mở trên toàn bộ viewport và có thể zoom/scroll độc lập,
 * nên chữ vẫn rõ dù trang dọc, ngang hoặc khổ lớn.
 */
const ReaderPreview: React.FC<ReaderPreviewProps> = ({
  pdfDoc,
  pageNumber,
  onClose,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const [viewerSize, setViewerSize] = useState({ width: 0, height: 0 });
  const [canvasCssSize, setCanvasCssSize] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(1);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const element = viewerRef.current;
    if (!element) return;

    const updateSize = () => {
      const rect = element.getBoundingClientRect();
      const nextSize = {
        width: Math.floor(rect.width),
        height: Math.floor(rect.height),
      };
      setViewerSize((previous) =>
        previous.width === nextSize.width && previous.height === nextSize.height
          ? previous
          : nextSize,
      );
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let disposed = false;
    let cancelRender: (() => void) | undefined;

    const renderPage = async () => {
      const canvas = canvasRef.current;
      if (!pdfDoc || !canvas || viewerSize.width <= 0 || viewerSize.height <= 0) {
        return;
      }

      setIsLoading(true);
      setError(null);

      try {
        const page = await pdfDoc.getPage(pageNumber);
        if (disposed) return;

        const baseViewport = page.getViewport({ scale: 1 });
        const fitScale = Math.max(
          0.05,
          Math.min(
            Math.max(1, viewerSize.width - 32) / baseViewport.width,
            Math.max(1, viewerSize.height - 32) / baseViewport.height,
          ),
        );
        const cssScale = fitScale * zoom;
        const outputScale = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2.5);
        const renderViewport = page.getViewport({ scale: cssScale * outputScale });
        const context = canvas.getContext("2d");
        if (!context || disposed) return;

        canvas.width = Math.ceil(renderViewport.width);
        canvas.height = Math.ceil(renderViewport.height);
        context.imageSmoothingEnabled = true;
        context.clearRect(0, 0, canvas.width, canvas.height);
        setCanvasCssSize({
          width: Math.round(baseViewport.width * cssScale),
          height: Math.round(baseViewport.height * cssScale),
        });

        const renderTask = page.render({ canvasContext: context, viewport: renderViewport });
        cancelRender = () => renderTask.cancel();
        await renderTask.promise;
      } catch (err) {
        const isCancelled =
          err instanceof Error && err.name === "RenderingCancelledException";
        if (!disposed && !isCancelled) {
          console.error("Error rendering reader preview:", err);
          setError("Không thể hiển thị trang");
        }
      } finally {
        if (!disposed) setIsLoading(false);
      }
    };

    void renderPage();

    return () => {
      disposed = true;
      cancelRender?.();
    };
  }, [pdfDoc, pageNumber, viewerSize.height, viewerSize.width, zoom]);

  const changeZoom = (delta: number) => {
    setZoom((previous) => Math.min(3, Math.max(0.75, Number((previous + delta).toFixed(2)))));
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex min-h-[100dvh] flex-col bg-zinc-950/90 p-2 backdrop-blur-sm sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Đọc rõ trang ${pageNumber}`}
    >
      <div className="mx-auto flex w-full max-w-[1700px] shrink-0 items-center justify-between gap-3 rounded-xl border border-white/15 bg-zinc-900 px-3 py-2 text-white shadow-xl">
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-white/45">Chế độ đọc rõ</p>
          <p className="truncate text-sm font-bold">Trang {pageNumber}</p>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => changeZoom(-0.25)}
            disabled={zoom <= 0.75}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/15 bg-white/5 text-white transition hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-35"
            aria-label="Thu nhỏ preview"
            title="Thu nhỏ"
          >
            <ZoomOut className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setZoom(1)}
            className="min-w-[58px] rounded-lg border border-white/15 bg-white/5 px-2 py-1.5 text-[11px] font-bold text-white transition hover:bg-white/15"
            title="Đưa về vừa khung"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            onClick={() => changeZoom(0.25)}
            disabled={zoom >= 3}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/15 bg-white/5 text-white transition hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-35"
            aria-label="Phóng to preview"
            title="Phóng to"
          >
            <ZoomIn className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setZoom(1)}
            className="hidden items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-2 py-1.5 text-[11px] font-bold text-white transition hover:bg-white/15 sm:inline-flex"
            title="Vừa khung"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Vừa khung
          </button>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-white px-2.5 text-[11px] font-bold text-zinc-900 transition hover:bg-zinc-100"
          >
            <X className="h-4 w-4" />
            Đóng
          </button>
        </div>
      </div>

      <div className="mx-auto mt-2 flex min-h-0 w-full max-w-[1700px] flex-1 overflow-hidden rounded-xl border border-white/15 bg-zinc-800 shadow-2xl">
        <div
          ref={viewerRef}
          className="relative h-full min-h-0 w-full overflow-auto p-3 sm:p-4"
        >
          {isLoading && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-zinc-900/45">
              <Loader2 className="h-7 w-7 animate-spin text-white" />
            </div>
          )}
          {error && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-red-950/85 p-4 text-center">
              <p className="text-sm font-medium text-red-100">{error}</p>
            </div>
          )}
          <div className="flex min-h-full min-w-full items-center justify-center">
            <canvas
              ref={canvasRef}
              className="block bg-white shadow-2xl"
              style={{
                width: `${canvasCssSize.width}px`,
                height: `${canvasCssSize.height}px`,
                imageRendering: "auto",
              }}
            />
          </div>
        </div>
      </div>

      <p className="mx-auto mt-2 w-full max-w-[1700px] text-center text-[11px] font-medium text-white/60">
        Dùng + / − để đọc rõ hơn; khi phóng to, cuộn ngay trong khung để xem phần còn lại của trang.
      </p>
    </div>
  );
};

const PagePreview: React.FC<PagePreviewProps> = ({ pdfDoc, pageNumber }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const [previewWidth, setPreviewWidth] = useState(0);
  const [canvasCssSize, setCanvasCssSize] = useState({ width: 0, height: 0 });
  const [pageOrientation, setPageOrientation] = useState<"portrait" | "landscape">("portrait");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isReaderOpen, setIsReaderOpen] = useState(false);

  useEffect(() => {
    const element = previewRef.current;
    if (!element) return;

    const updateWidth = () => {
      const nextWidth = Math.floor(element.getBoundingClientRect().width);
      setPreviewWidth((previous) =>
        previous === nextWidth ? previous : nextWidth,
      );
    };

    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let disposed = false;
    let cancelRender: (() => void) | undefined;

    const renderPage = async () => {
      const canvas = canvasRef.current;
      if (!pdfDoc || !canvas || previewWidth <= 0) return;

      setIsLoading(true);
      setError(null);

      try {
        const page = await pdfDoc.getPage(pageNumber);
        if (disposed) return;

        const baseViewport = page.getViewport({ scale: 1 });

        // Vẫn giữ tỷ lệ gốc và đọc theo chiều dọc, nhưng giới hạn chiều rộng
        // ở mức vừa phải: A4/A3 dọc không chiếm hết màn hình; giấy ngang có
        // không gian rộng hơn. Người dùng vẫn có thể mở Toàn màn khi cần soi kỹ.
        setPageOrientation(
          baseViewport.width > baseViewport.height ? "landscape" : "portrait",
        );
        const cssScale = Math.max(0.05, previewWidth / baseViewport.width);
        const outputScale = Math.min(
          Math.max(window.devicePixelRatio || 1, 1),
          2,
        );
        const renderViewport = page.getViewport({
          scale: cssScale * outputScale,
        });
        const context = canvas.getContext("2d");
        if (!context || disposed) return;

        canvas.width = Math.ceil(renderViewport.width);
        canvas.height = Math.ceil(renderViewport.height);
        context.imageSmoothingEnabled = true;
        context.clearRect(0, 0, canvas.width, canvas.height);
        setCanvasCssSize({
          width: Math.round(baseViewport.width * cssScale),
          height: Math.round(baseViewport.height * cssScale),
        });

        const renderTask = page.render({
          canvasContext: context,
          viewport: renderViewport,
        });
        cancelRender = () => renderTask.cancel();
        await renderTask.promise;
      } catch (err) {
        const isCancelled =
          err instanceof Error && err.name === "RenderingCancelledException";
        if (!disposed && !isCancelled) {
          console.error("Error rendering page:", err);
          setError("Không thể hiển thị trang");
        }
      } finally {
        if (!disposed) setIsLoading(false);
      }
    };

    void renderPage();

    return () => {
      disposed = true;
      cancelRender?.();
    };
  }, [pdfDoc, pageNumber, previewWidth]);

  return (
    <>
      <section
        className={cn(
          "group relative w-full shrink-0 overflow-hidden bg-zinc-200",
          canvasCssSize.height > 0 ? "" : "min-h-[160px]",
        )}
      >
        {isLoading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/70 backdrop-blur-[1px]">
            <Loader2 className="h-6 w-6 animate-spin text-zinc-900" />
          </div>
        )}
        {error && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-red-50 p-4 text-center">
            <p className="text-sm font-medium text-red-500">{error}</p>
          </div>
        )}

        <div
          ref={previewRef}
          className={cn(
            "relative mx-auto w-full bg-zinc-200",
            // Kích thước mặc định cân bằng: đủ rõ để đọc, không quá lớn khi cuộn.
            pageOrientation === "landscape"
              ? "max-w-[1120px]"
              : "max-w-[760px]",
          )}
          onDoubleClick={() => setIsReaderOpen(true)}
          title="Nhấp đúp để mở toàn màn hình"
        >
          <canvas
            ref={canvasRef}
            aria-label={`Xem trước trang ${pageNumber}`}
            className="block bg-white shadow-sm"
            style={{
              width: `${canvasCssSize.width}px`,
              height: `${canvasCssSize.height}px`,
              imageRendering: "auto",
            }}
          />
        </div>

        <button
          type="button"
          onClick={() => setIsReaderOpen(true)}
          className="absolute right-2 top-2 z-20 inline-flex items-center gap-1 rounded-md border border-zinc-950/10 bg-white/95 px-2 py-1 text-[10px] font-bold text-zinc-800 opacity-0 shadow-sm transition hover:bg-white focus:opacity-100 group-hover:opacity-100"
          title="Mở toàn màn hình để phóng to"
        >
          <Maximize2 className="h-3.5 w-3.5" />
          Toàn màn
        </button>
        <span className="pointer-events-none absolute bottom-2 right-2 z-20 rounded bg-zinc-950/80 px-1.5 py-0.5 text-[10px] font-bold text-white shadow-sm backdrop-blur-sm">
          Trang {pageNumber}
        </span>
      </section>

      {isReaderOpen && (
        <ReaderPreview
          pdfDoc={pdfDoc}
          pageNumber={pageNumber}
          onClose={() => setIsReaderOpen(false)}
        />
      )}
    </>
  );
};

type LandscapePanelProps = {
  src: string;
  alt: string;
  label: string;
  title?: string;
  className?: string;
  compact?: boolean;
};

const LandscapePanel: React.FC<LandscapePanelProps> = ({
  src,
  alt,
  label,
  title,
  className,
  compact = false,
}) => {
  const [showImage, setShowImage] = useState(true);

  return (
    <div
      className={cn(
        "relative isolate overflow-hidden rounded-[28px] bg-gradient-to-br from-slate-900 via-indigo-800 to-fuchsia-700 shadow-[0_18px_50px_rgba(79,70,229,0.24)]",
        compact ? "min-h-[168px]" : "min-h-[300px]",
        className,
      )}
    >
      {showImage && (
        <img
          src={src}
          alt={alt}
          onError={() => setShowImage(false)}
          className="absolute inset-0 h-full w-full object-cover opacity-75"
        />
      )}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_20%,rgba(255,255,255,0.36),transparent_28%),radial-gradient(circle_at_83%_18%,rgba(34,211,238,0.45),transparent_25%),linear-gradient(120deg,rgba(15,23,42,0.14),rgba(15,23,42,0.68))]" />
      <div className="absolute -bottom-16 -left-10 h-44 w-44 rounded-full bg-fuchsia-300/30 blur-2xl" />
      <div className="absolute -right-8 top-8 h-32 w-32 rounded-full bg-cyan-300/30 blur-2xl" />

      <div className="relative z-10 flex h-full flex-col justify-between p-5 text-white">
        <span className="w-fit rounded-full border border-white/25 bg-white/15 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.16em] text-white/90 backdrop-blur-sm">
          {label}
        </span>
        {title && (
          <p className={cn("max-w-lg font-semibold leading-tight", compact ? "text-xl" : "text-2xl md:text-3xl")}>
            {title}
          </p>
        )}
      </div>
    </div>
  );
};

type HomeToolCardProps = {
  title: string;
  description: string;
  action: string;
  mode: AppMode;
  icon: React.ReactNode;
  badge: string;
  tone: "violet" | "sky" | "amber" | "rose";
  onOpen: (mode: AppMode) => void;
};

const HomeToolCard: React.FC<HomeToolCardProps> = ({
  title,
  description,
  action,
  mode,
  icon,
  badge,
  tone,
  onOpen,
}) => {
  const toneClasses = {
    violet: {
      card: "from-violet-100 via-white to-indigo-50 border-violet-100",
      text: "text-violet-700",
      icon: "bg-violet-600",
    },
    sky: {
      card: "from-sky-100 via-white to-cyan-50 border-sky-100",
      text: "text-sky-700",
      icon: "bg-sky-600",
    },
    amber: {
      card: "from-amber-100 via-white to-orange-50 border-amber-100",
      text: "text-amber-700",
      icon: "bg-amber-600",
    },
    rose: {
      card: "from-rose-100 via-white to-pink-50 border-rose-100",
      text: "text-rose-700",
      icon: "bg-rose-600",
    },
  }[tone];

  return (
    <button
      type="button"
      onClick={() => onOpen(mode)}
      className={cn(
        "group relative flex min-h-[250px] flex-col overflow-hidden rounded-[28px] border p-6 text-left shadow-sm transition duration-300 hover:-translate-y-1 hover:shadow-xl",
        "bg-gradient-to-br",
        toneClasses.card,
      )}
    >
      <div className="absolute -right-8 -top-10 h-32 w-32 rounded-full bg-white/60 blur-2xl transition-transform duration-300 group-hover:scale-125" />
      <div className="relative flex items-start justify-between gap-4">
        <div className={cn("flex h-12 w-12 items-center justify-center rounded-2xl text-white shadow-lg", toneClasses.icon)}>
          {icon}
        </div>
        <span className={cn("rounded-full bg-white/80 px-3 py-1 text-[11px] font-bold uppercase tracking-wider", toneClasses.text)}>
          {badge}
        </span>
      </div>
      <div className="relative mt-auto pt-8">
        <h3 className="text-xl font-bold tracking-tight text-zinc-900">{title}</h3>
        <p className="mt-2 min-h-[44px] text-sm leading-6 text-zinc-600">{description}</p>
        <span className={cn("mt-5 inline-flex items-center gap-2 text-sm font-bold", toneClasses.text)}>
          {action}
          <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
        </span>
      </div>
    </button>
  );
};

type HomeLandingProps = {
  onOpenMode: (mode: AppMode) => void;
};

const HomeLanding: React.FC<HomeLandingProps> = ({ onOpenMode }) => {
  return (
    <motion.section
      key="home-mode"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      className="space-y-8 pb-6"
    >
      <section className="grid gap-5 lg:grid-cols-12">
        <div className="relative overflow-hidden rounded-[34px] bg-zinc-950 p-7 text-white shadow-[0_22px_60px_rgba(24,24,27,0.2)] lg:col-span-8 lg:p-10">
          <img
            src={HOME_IMAGES.hero}
            alt="Ảnh banner landscape cho PDF Toolkit"
            onError={(event) => {
              event.currentTarget.style.display = "none";
            }}
            className="absolute inset-0 h-full w-full object-cover opacity-45"
          />
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_16%_10%,rgba(34,211,238,0.30),transparent_25%),radial-gradient(circle_at_83%_15%,rgba(244,114,182,0.28),transparent_22%),linear-gradient(100deg,rgba(9,9,11,0.96),rgba(9,9,11,0.58),rgba(9,9,11,0.36))]" />
          <div className="absolute -bottom-20 -right-16 h-64 w-64 rounded-full bg-violet-500/30 blur-3xl" />

          <div className="relative z-10 flex min-h-[350px] max-w-2xl flex-col justify-between">
            <div>
              <span className="inline-flex rounded-full border border-white/20 bg-white/10 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.18em] text-white/85 backdrop-blur-sm">
                PDF Toolkit • làm gọn hồ sơ
              </span>
              <h2 className="mt-5 text-4xl font-black tracking-[-0.04em] sm:text-5xl">
                Tách đúng trang.
                <br />
                Ghép đúng thứ tự.
              </h2>
              <p className="mt-5 max-w-xl text-base leading-7 text-white/75 sm:text-lg">
                Một nơi để xử lý hồ sơ PDF nhanh hơn: tách từng file, tách hàng loạt,
                ghép mặt trước–mặt sau và gộp toàn bộ tài liệu.
              </p>
            </div>

            <div className="flex flex-wrap gap-3 pt-8">
              <button
                type="button"
                onClick={() => onOpenMode("split")}
                className="inline-flex items-center gap-2 rounded-2xl bg-white px-5 py-3.5 text-sm font-bold text-zinc-900 transition hover:bg-zinc-100 active:scale-[0.98]"
              >
                <FileText className="h-4 w-4" />
                Tách một PDF
                <ChevronRight className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => onOpenMode("batch-merge")}
                className="inline-flex items-center gap-2 rounded-2xl border border-white/25 bg-white/10 px-5 py-3.5 text-sm font-bold text-white backdrop-blur-sm transition hover:bg-white/20 active:scale-[0.98]"
              >
                <Files className="h-4 w-4" />
                Ghép mặt trước/sau
              </button>
            </div>
          </div>
        </div>

        <div className="grid gap-5 sm:grid-cols-2 lg:col-span-4 lg:grid-cols-1">
          <div className="relative overflow-hidden rounded-[30px] border border-white/60 bg-gradient-to-br from-cyan-100 via-sky-50 to-indigo-100 p-6 shadow-sm">
            <div className="absolute -right-8 -top-8 h-32 w-32 rounded-full bg-cyan-300/45 blur-2xl" />
            <div className="relative">
              <span className="text-xs font-bold uppercase tracking-[0.16em] text-sky-700">4 công cụ chính</span>
              <p className="mt-3 text-3xl font-black tracking-tight text-zinc-900">Một luồng làm việc gọn.</p>
              <p className="mt-3 text-sm leading-6 text-zinc-600">
                Chọn đúng công cụ, rà lại thứ tự file, rồi xuất ra PDF hoặc ZIP.
              </p>
              <div className="mt-5 grid grid-cols-2 gap-2 text-xs font-bold text-zinc-700">
                <span className="rounded-xl bg-white/70 px-3 py-2">Tách lẻ</span>
                <span className="rounded-xl bg-white/70 px-3 py-2">Tách hàng loạt</span>
                <span className="rounded-xl bg-white/70 px-3 py-2">Ghép cặp</span>
                <span className="rounded-xl bg-white/70 px-3 py-2">Gộp 1 file</span>
              </div>
            </div>
          </div>
          <LandscapePanel
            src={HOME_IMAGES.workflow}
            alt="Ảnh landscape minh họa quy trình xử lý PDF"
            label="“Không có gì quý hơn độc lập, tự do.”"
            title="Chủ tịch Hồ Chí Minh."
            compact
          />
        </div>
      </section>

      <section className="grid gap-5 lg:grid-cols-12 text-sm">
        <LandscapePanel
          src={HOME_IMAGES.ordering}
          alt="Ảnh landscape minh họa sắp xếp hồ sơ"
          label="“Thà hy sinh tất cả, chứ nhất định không chịu mất nước, nhất định không chịu làm nô lệ.”"
          title="Chủ tịch Hồ Chí Minh."
          className="lg:col-span-5"
        />
        <div className="rounded-[30px] border border-zinc-200 bg-white p-6 shadow-sm lg:col-span-7 lg:p-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <span className="text-xs font-bold uppercase tracking-[0.16em] text-zinc-400">Chọn công cụ</span>
              <h2 className="mt-2 text-3xl font-black tracking-[-0.035em] text-zinc-900">
                Bắt đầu từ việc bạn cần làm.
              </h2>
            </div>
            <p className="max-w-xs text-sm leading-6 text-zinc-500">
              Các công cụ giữ nguyên toàn bộ chức năng đã có trong app.
            </p>
          </div>

          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <HomeToolCard
              title="Tách một PDF"
              description="Xem trước từng nhóm trang, đặt tên file và theo dõi tiến độ theo số trang/lần tách."
              action="Mở tách PDF"
              mode="split"
              badge="Từng file"
              tone="violet"
              icon={<FileText className="h-6 w-6" />}
              onOpen={onOpenMode}
            />
            <HomeToolCard
              title="Tách hàng loạt"
              description="Nhiều PDF, một cấu hình số trang, xuất trọn bộ kết quả trong file ZIP."
              action="Mở tách hàng loạt"
              mode="batch-split"
              badge="ZIP kết quả"
              tone="sky"
              icon={<Archive className="h-6 w-6" />}
              onOpen={onOpenMode}
            />
            <HomeToolCard
              title="Ghép mặt trước / sau"
              description="Ghép theo cặp và đổi thứ tự từng danh sách trước khi chạy để tránh lệch hồ sơ."
              action="Mở ghép cặp"
              mode="batch-merge"
              badge="Theo cặp"
              tone="amber"
              icon={<Files className="h-6 w-6" />}
              onOpen={onOpenMode}
            />
            <HomeToolCard
              title="Gộp thành một PDF"
              description="Nối toàn bộ PDF và ảnh theo thứ tự tên file tự nhiên thành một tài liệu duy nhất."
              action="Mở gộp PDF"
              mode="merge-all"
              badge="Một file"
              tone="rose"
              icon={<Download className="h-6 w-6" />}
              onOpen={onOpenMode}
            />
          </div>
        </div>
      </section>

      <section className="relative overflow-hidden rounded-[32px] bg-zinc-900 px-6 py-8 text-white shadow-[0_18px_45px_rgba(24,24,27,0.16)] sm:px-8 md:py-10">
        <img
          src={HOME_IMAGES.closing}
          alt="Ảnh landscape trang trí cuối trang chủ"
          onError={(event) => {
            event.currentTarget.style.display = "none";
          }}
          className="absolute inset-0 h-full w-full object-cover opacity-30"
        />
        <div className="absolute inset-0 bg-gradient-to-r from-zinc-950 via-zinc-900/80 to-violet-900/65" />
        <div className="relative flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
          <div>
            <span className="rounded-full border border-white/20 bg-white/10 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.16em] text-white/80">
              Quyết chiến, quyết thắng!
            </span>
            <h2 className="mt-4 text-3xl font-black tracking-[-0.035em] sm:text-4xl">
              Xử lý nhiều hơn, nhưng không rối hơn.
            </h2>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-white/70">
             Khẩu hiệu truyền thống, cũng là tinh thần chiến đấu tiêu biểu của Quân đội nhân dân Việt Nam.
            </p>
          </div>
          <button
            type="button"
            onClick={() => onOpenMode("batch-split")}
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-2xl bg-white px-5 py-3.5 text-sm font-bold text-zinc-900 transition hover:bg-zinc-100 active:scale-[0.98]"
          >
            Xử lý hàng loạt
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </section>
    </motion.section>
  );
};

export default function App() {
  const [mode, setMode] = useState<AppMode>("home");
  // Khi đã vào một công cụ, ẩn thanh điều hướng lớn để dành chỗ cho vùng làm việc.
  const [isToolsMenuOpen, setIsToolsMenuOpen] = useState(false);
  const [isSplitControlsOpen, setIsSplitControlsOpen] = useState(true);
  const [isSplitDetailsOpen, setIsSplitDetailsOpen] = useState(false);

  // Tách một PDF, có xem trước và tiến độ riêng theo số trang/lần tách.
  const [file, setFile] = useState<File | null>(null);
  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [totalPages, setTotalPages] = useState(0);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [fileName, setFileName] = useState("");
  const [isExporting, setIsExporting] = useState(false);
  const [isParsing, setIsParsing] = useState(false);
  const [pagesPerBatch, setPagesPerBatch] = useState(2);
  const [isSplitFileNameAuto, setIsSplitFileNameAuto] = useState(true);
  const [completedBatchesBySize, setCompletedBatchesBySize] = useState<
    Record<number, Set<number>>
  >({});

  // Ghép từng cặp mặt trước + mặt sau.
  const [frontFiles, setFrontFiles] = useState<File[]>([]);
  const [backFiles, setBackFiles] = useState<File[]>([]);
  const [isBatchMerging, setIsBatchMerging] = useState(false);
  const [batchMergeProgress, setBatchMergeProgress] = useState<WorkProgress>({
    completed: 0,
    total: 0,
  });
  const [batchMergeResult, setBatchMergeResult] =
    useState<BatchMergeResult | null>(null);

  // Gộp toàn bộ file đã chọn thành một PDF duy nhất.
  const [mergeAllFiles, setMergeAllFiles] = useState<File[]>([]);
  const [mergeAllName, setMergeAllName] = useState("tai_lieu_da_gop");
  const [isMergingAll, setIsMergingAll] = useState(false);
  const [mergeAllProgress, setMergeAllProgress] = useState<WorkProgress>({
    completed: 0,
    total: 0,
  });
  const [mergeAllResult, setMergeAllResult] = useState<MergeAllResult | null>(
    null,
  );

  // Tách nhiều PDF cùng lúc; toàn bộ file con được nén vào một ZIP.
  const [batchSplitFiles, setBatchSplitFiles] = useState<File[]>([]);
  const [batchSplitPagesPerFile, setBatchSplitPagesPerFile] = useState(2);
  const [isBatchSplitting, setIsBatchSplitting] = useState(false);
  const [batchSplitProgress, setBatchSplitProgress] = useState<WorkProgress>({
    completed: 0,
    total: 0,
  });
  const [batchSplitResult, setBatchSplitResult] =
    useState<BatchSplitResult | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const frontInputRef = useRef<HTMLInputElement>(null);
  const backInputRef = useRef<HTMLInputElement>(null);
  const mergeAllInputRef = useRef<HTMLInputElement>(null);
  const batchSplitInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (mode !== "home") {
      setIsToolsMenuOpen(false);
    }
  }, [mode]);

  const currentSplitRange = getSplitRange(
    currentIndex,
    totalPages,
    pagesPerBatch,
  );
  const currentPageIndices = currentSplitRange.pageIndices;
  const currentPageStart = currentSplitRange.startIndex + 1;
  const currentPageEnd = currentSplitRange.endIndexExclusive;

  const totalBatches = totalPages > 0 ? Math.ceil(totalPages / pagesPerBatch) : 0;
  const completedBatches = completedBatchesBySize[pagesPerBatch];
  const completedCount = completedBatches?.size ?? 0;
  const currentBatchCompleted =
    completedBatches?.has(currentSplitRange.startIndex) ?? false;
  const splitProgressPercent =
    totalBatches > 0 ? Math.min(100, (completedCount / totalBatches) * 100) : 0;

  useEffect(() => {
    if (!file || !isSplitFileNameAuto || currentPageIndices.length === 0) return;

    setFileName(
      makeDefaultSplitFileName(
        file.name,
        currentSplitRange.startIndex,
        currentSplitRange.endIndexExclusive,
      ),
    );
  }, [
    file,
    isSplitFileNameAuto,
    currentPageIndices.length,
    currentSplitRange.startIndex,
    currentSplitRange.endIndexExclusive,
  ]);

  const pairCount = Math.min(frontFiles.length, backFiles.length);
  const batchPairs = Array.from({ length: pairCount }, (_, index) => ({
    front: frontFiles[index],
    back: backFiles[index],
  }));

  const handleFileUpload = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const uploadedFile = event.target.files?.[0];
    event.target.value = "";

    if (!uploadedFile) return;
    if (!isPdfFile(uploadedFile)) {
      alert("Vui lòng chọn một file PDF.");
      return;
    }

    setIsParsing(true);

    try {
      const arrayBuffer = await uploadedFile.arrayBuffer();
      const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
      const pdf = await loadingTask.promise;

      setFile(uploadedFile);
      setPdfDoc(pdf);
      setTotalPages(pdf.numPages);
      setCurrentIndex(0);
      setFileName(
        makeDefaultSplitFileName(
          uploadedFile.name,
          0,
          Math.min(pagesPerBatch, pdf.numPages),
        ),
      );
      setIsSplitFileNameAuto(true);
      setIsSplitDetailsOpen(false);
      setCompletedBatchesBySize({});
      setIsToolsMenuOpen(false);
    } catch (error) {
      console.error("Error parsing PDF:", error);
      alert("Không thể đọc file PDF này. Vui lòng thử lại.");
      resetSplit();
    } finally {
      setIsParsing(false);
    }
  };

  const handleExport = async () => {
    if (!file || isExporting || currentPageIndices.length === 0) return;

    setIsExporting(true);

    // Chụp lại nhóm trang hiện tại trước khi chạy bất đồng bộ để file tải về
    // luôn khớp chính xác với preview đang có trên màn hình.
    const pageIndicesToExtract = [...currentPageIndices];
    const pageStart = currentPageStart;
    const pageEnd = currentPageEnd;
    const currentRangeStartIndex = currentSplitRange.startIndex;

    try {
      const originalPdf = await PDFDocument.load(await file.arrayBuffer());
      const newPdf = await PDFDocument.create();
      const copiedPages = await newPdf.copyPages(
        originalPdf,
        pageIndicesToExtract,
      );
      copiedPages.forEach((page) => newPdf.addPage(page));

      const fallbackName = makeDefaultSplitFileName(
        file.name,
        currentRangeStartIndex,
        pageEnd,
      );
      const outputName = safeFileName(
        isSplitFileNameAuto ? fallbackName : fileName.trim() || fallbackName,
      );

      downloadBlob(
        new Blob([await newPdf.save()], { type: PDF_MIME_TYPE }),
        `${outputName}.pdf`,
      );

      setCompletedBatchesBySize((previous) => {
        const completedForCurrentSize = new Set(previous[pagesPerBatch] ?? []);
        completedForCurrentSize.add(currentRangeStartIndex);
        return { ...previous, [pagesPerBatch]: completedForCurrentSize };
      });

      // Chuyển chính xác sang trang ngay sau trang cuối vừa xuất.
      if (pageEnd < totalPages) {
        setCurrentIndex(pageEnd);
      }
    } catch (error) {
      console.error("Export failed:", error);
      alert("Không thể tách file ở nhóm trang này.");
    } finally {
      setIsExporting(false);
    }
  };

  const handlePagesPerBatchChange = (nextPagesPerBatch: number) => {
    const nextSize = Math.max(1, Math.floor(nextPagesPerBatch));
    if (nextSize === pagesPerBatch) return;

    // QUAN TRỌNG: Không gọi setCurrentIndex ở đây.
    // Ví dụ đang ở trang 5: đổi 2 → 4 trang phải hiển thị 5–8;
    // đổi 4 → 1 trang vẫn phải giữ ở trang 5, không tự nhảy sang trang khác.
    setPagesPerBatch(nextSize);
  };

  const handleNext = () => {
    if (currentPageEnd < totalPages) {
      setCurrentIndex(currentPageEnd);
    }
  };

  const handlePrev = () => {
    if (currentSplitRange.startIndex > 0) {
      setCurrentIndex(Math.max(0, currentSplitRange.startIndex - pagesPerBatch));
    }
  };

  const handleJumpPrompt = () => {
    const input = prompt(`Nhập trang bắt đầu muốn xem/tách (1–${totalPages}):`);
    if (input === null || input.trim() === "") return;

    const page = Number(input);
    if (!Number.isInteger(page) || page < 1 || page > totalPages) {
      alert("Trang không hợp lệ.");
      return;
    }

    // "Tới trang 5" luôn bắt đầu bằng trang 5, đúng với nội dung người dùng nhập.
    setCurrentIndex(page - 1);
  };

  const handleBatchFiles = (
    event: React.ChangeEvent<HTMLInputElement>,
    side: "front" | "back",
  ) => {
    const selectedFiles = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (selectedFiles.length === 0) return;

    const supportedFiles = selectedFiles.filter(isSupportedMergeFile);
    const unsupportedFiles = selectedFiles.filter(
      (selectedFile) => !isSupportedMergeFile(selectedFile),
    );

    if (unsupportedFiles.length > 0) {
      alert(
        `Bỏ qua ${unsupportedFiles.length} file không hỗ trợ. Chỉ nhận PDF, JPG, JPEG và PNG.`,
      );
    }
    if (supportedFiles.length === 0) return;

    if (side === "front") {
      setFrontFiles(sortFilesNaturally(supportedFiles));
    } else {
      setBackFiles(sortFilesNaturally(supportedFiles));
    }

    setBatchMergeResult(null);
    setBatchMergeProgress({ completed: 0, total: 0 });
  };

  const moveBatchMergeFile = (
    side: "front" | "back",
    fromIndex: number,
    toIndex: number,
  ) => {
    if (isBatchMerging || fromIndex === toIndex) return;

    if (side === "front") {
      setFrontFiles((previous) => moveArrayItem(previous, fromIndex, toIndex));
    } else {
      setBackFiles((previous) => moveArrayItem(previous, fromIndex, toIndex));
    }

    setBatchMergeResult(null);
    setBatchMergeProgress({ completed: 0, total: 0 });
  };

  const moveBatchSplitFile = (fromIndex: number, toIndex: number) => {
    if (isBatchSplitting || fromIndex === toIndex) return;

    setBatchSplitFiles((previous) => moveArrayItem(previous, fromIndex, toIndex));
    setBatchSplitResult(null);
    setBatchSplitProgress({ completed: 0, total: 0 });
  };

  const handleBatchMerge = async () => {
    if (batchPairs.length === 0 || isBatchMerging) return;

    setIsBatchMerging(true);
    setBatchMergeResult(null);
    setBatchMergeProgress({ completed: 0, total: batchPairs.length });

    const zip = new JSZip();
    const usedOutputNames = new Set<string>();
    const reportLines = [
      "KẾT QUẢ GHÉP MẶT TRƯỚC + MẶT SAU",
      "",
      "Ghép theo thứ tự danh sách đã được xác nhận trên màn hình.",
      "",
    ];
    const failedFiles: string[] = [];
    let successCount = 0;

    try {
      for (let index = 0; index < batchPairs.length; index += 1) {
        const pair = batchPairs[index];
        const pairNumber = index + 1;

        try {
          const pdfBytes = await createMergedPdf(pair.front, pair.back);
          const outputName = makeUniquePdfName(
            `${stripExtension(pair.front.name)}_co_mat_sau`,
            usedOutputNames,
          );
          zip.file(outputName, pdfBytes);
          reportLines.push(
            `${pairNumber}. OK | ${pair.front.name} + ${pair.back.name} -> ${outputName}`,
          );
          successCount += 1;
        } catch (error) {
          console.error(`Could not merge pair ${pairNumber}:`, error);
          const message = `${pairNumber}. LỖI | ${pair.front.name} + ${pair.back.name}`;
          failedFiles.push(message);
          reportLines.push(message);
        } finally {
          setBatchMergeProgress({
            completed: pairNumber,
            total: batchPairs.length,
          });
        }
      }

      reportLines.push("");
      reportLines.push(`Thành công: ${successCount}/${batchPairs.length}`);
      reportLines.push(`Lỗi: ${failedFiles.length}`);
      zip.file("README_KET_QUA_GHEP.txt", reportLines.join("\n"));

      if (successCount === 0) {
        throw new Error("Không có cặp file nào ghép thành công.");
      }

      const zipBlob = await zip.generateAsync({ type: "blob" });
      downloadBlob(zipBlob, makeZipFileName("PDF_ghep_mat_truoc_sau"));
      setBatchMergeResult({ successCount, failedFiles });
    } catch (error) {
      console.error("Batch merge failed:", error);
      alert(
        error instanceof Error
          ? error.message
          : "Không thể tạo file ZIP. Vui lòng thử lại.",
      );
      setBatchMergeResult({ successCount, failedFiles });
    } finally {
      setIsBatchMerging(false);
    }
  };

  const handleMergeAllFiles = (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (selectedFiles.length === 0) return;

    const supportedFiles = selectedFiles.filter(isSupportedMergeFile);
    const unsupportedFiles = selectedFiles.filter(
      (selectedFile) => !isSupportedMergeFile(selectedFile),
    );

    if (unsupportedFiles.length > 0) {
      alert(
        `Bỏ qua ${unsupportedFiles.length} file không hỗ trợ. Chỉ nhận PDF, JPG, JPEG và PNG.`,
      );
    }
    if (supportedFiles.length === 0) return;

    setMergeAllFiles(sortFilesNaturally(supportedFiles));
    setMergeAllResult(null);
    setMergeAllProgress({ completed: 0, total: 0 });
    setMergeAllName("tai_lieu_da_gop");
  };

  const handleMergeAll = async () => {
    if (mergeAllFiles.length === 0 || isMergingAll) return;

    setIsMergingAll(true);
    setMergeAllResult(null);
    setMergeAllProgress({ completed: 0, total: mergeAllFiles.length });

    const combinedPdf = await PDFDocument.create();
    const failedFiles: string[] = [];
    let successCount = 0;

    try {
      for (let index = 0; index < mergeAllFiles.length; index += 1) {
        const selectedFile = mergeAllFiles[index];
        try {
          await appendFileToPdf(combinedPdf, selectedFile);
          successCount += 1;
        } catch (error) {
          console.error(`Could not append ${selectedFile.name}:`, error);
          failedFiles.push(selectedFile.name);
        } finally {
          setMergeAllProgress({
            completed: index + 1,
            total: mergeAllFiles.length,
          });
        }
      }

      const totalOutputPages = combinedPdf.getPageCount();
      if (totalOutputPages === 0) {
        throw new Error("Không có file nào được gộp thành công.");
      }

      const outputName = safeFileName(mergeAllName.trim() || "tai_lieu_da_gop");
      downloadBlob(
        new Blob([await combinedPdf.save()], { type: PDF_MIME_TYPE }),
        `${outputName}.pdf`,
      );
      setMergeAllResult({
        successCount,
        totalPages: totalOutputPages,
        failedFiles,
      });
    } catch (error) {
      console.error("Merge all failed:", error);
      alert(
        error instanceof Error
          ? error.message
          : "Không thể gộp các file đã chọn.",
      );
      setMergeAllResult({ successCount, totalPages: 0, failedFiles });
    } finally {
      setIsMergingAll(false);
    }
  };

  const handleBatchSplitFiles = (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const selectedFiles = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (selectedFiles.length === 0) return;

    const pdfFiles = selectedFiles.filter(isPdfFile);
    const ignoredFiles = selectedFiles.filter((selectedFile) => !isPdfFile(selectedFile));

    if (ignoredFiles.length > 0) {
      alert(`Bỏ qua ${ignoredFiles.length} file không phải PDF.`);
    }
    if (pdfFiles.length === 0) return;

    setBatchSplitFiles(sortFilesNaturally(pdfFiles));
    setBatchSplitResult(null);
    setBatchSplitProgress({ completed: 0, total: 0 });
  };

  const handleBatchSplit = async () => {
    if (batchSplitFiles.length === 0 || isBatchSplitting) return;

    setIsBatchSplitting(true);
    setBatchSplitResult(null);
    setBatchSplitProgress({ completed: 0, total: batchSplitFiles.length });

    const zip = new JSZip();
    const usedOutputNames = new Set<string>();
    const reportLines = [
      "KẾT QUẢ TÁCH PDF HÀNG LOẠT",
      "",
      `Số trang mỗi file xuất: ${batchSplitPagesPerFile}`,
      "Thứ tự xử lý là thứ tự danh sách đã được xác nhận trên màn hình.",
      "",
    ];
    const failedFiles: string[] = [];
    let successFileCount = 0;
    let generatedFileCount = 0;

    try {
      for (let index = 0; index < batchSplitFiles.length; index += 1) {
        const sourceFile = batchSplitFiles[index];
        let chunksCreated = 0;

        try {
          const sourcePdf = await PDFDocument.load(await sourceFile.arrayBuffer());
          const pageCount = sourcePdf.getPageCount();

          if (pageCount === 0) {
            throw new Error("PDF không có trang nào.");
          }

          for (
            let startPageIndex = 0;
            startPageIndex < pageCount;
            startPageIndex += batchSplitPagesPerFile
          ) {
            const endPageIndex = Math.min(
              startPageIndex + batchSplitPagesPerFile,
              pageCount,
            );
            const outputPdf = await PDFDocument.create();
            const pageIndices = Array.from(
              { length: endPageIndex - startPageIndex },
              (_, pageOffset) => startPageIndex + pageOffset,
            );
            const copiedPages = await outputPdf.copyPages(sourcePdf, pageIndices);
            copiedPages.forEach((page) => outputPdf.addPage(page));

            const outputName = makeUniquePdfName(
              `${stripExtension(sourceFile.name)}_trang_${startPageIndex + 1}-${endPageIndex}`,
              usedOutputNames,
            );
            zip.file(outputName, await outputPdf.save());
            chunksCreated += 1;
            generatedFileCount += 1;
          }

          successFileCount += 1;
          reportLines.push(
            `${index + 1}. OK | ${sourceFile.name} -> ${chunksCreated} file PDF`,
          );
        } catch (error) {
          console.error(`Could not split ${sourceFile.name}:`, error);
          const message = `${index + 1}. LỖI | ${sourceFile.name}`;
          failedFiles.push(message);
          reportLines.push(message);
        } finally {
          setBatchSplitProgress({
            completed: index + 1,
            total: batchSplitFiles.length,
          });
        }
      }

      reportLines.push("");
      reportLines.push(`PDF xử lý thành công: ${successFileCount}/${batchSplitFiles.length}`);
      reportLines.push(`File PDF đầu ra: ${generatedFileCount}`);
      reportLines.push(`Lỗi: ${failedFiles.length}`);
      zip.file("README_KET_QUA_TACH.txt", reportLines.join("\n"));

      if (generatedFileCount === 0) {
        throw new Error("Không có PDF nào tách thành công.");
      }

      const zipBlob = await zip.generateAsync({ type: "blob" });
      downloadBlob(zipBlob, makeZipFileName("PDF_da_tach_hang_loat"));
      setBatchSplitResult({
        successFileCount,
        generatedFileCount,
        failedFiles,
      });
    } catch (error) {
      console.error("Batch split failed:", error);
      alert(
        error instanceof Error
          ? error.message
          : "Không thể tạo file ZIP. Vui lòng thử lại.",
      );
      setBatchSplitResult({
        successFileCount,
        generatedFileCount,
        failedFiles,
      });
    } finally {
      setIsBatchSplitting(false);
    }
  };

  const resetSplit = () => {
    setFile(null);
    setPdfDoc(null);
    setTotalPages(0);
    setCurrentIndex(0);
    setFileName("");
    setIsSplitFileNameAuto(true);
    setIsSplitDetailsOpen(false);
    setCompletedBatchesBySize({});
  };

  const resetBatchMerge = () => {
    setFrontFiles([]);
    setBackFiles([]);
    setBatchMergeProgress({ completed: 0, total: 0 });
    setBatchMergeResult(null);
  };

  const resetMergeAll = () => {
    setMergeAllFiles([]);
    setMergeAllName("tai_lieu_da_gop");
    setMergeAllProgress({ completed: 0, total: 0 });
    setMergeAllResult(null);
  };

  const resetBatchSplit = () => {
    setBatchSplitFiles([]);
    setBatchSplitProgress({ completed: 0, total: 0 });
    setBatchSplitResult(null);
  };

  const resetCurrentMode = () => {
    switch (mode) {
      case "home":
        break;
      case "split":
        resetSplit();
        break;
      case "batch-merge":
        resetBatchMerge();
        break;
      case "merge-all":
        resetMergeAll();
        break;
      case "batch-split":
        resetBatchSplit();
        break;
    }
  };

  const hasActiveFiles =
    (mode === "split" && Boolean(file)) ||
    (mode === "batch-merge" && (frontFiles.length > 0 || backFiles.length > 0)) ||
    (mode === "merge-all" && mergeAllFiles.length > 0) ||
    (mode === "batch-split" && batchSplitFiles.length > 0);

  const activeModeLabel: Record<AppMode, string> = {
    home: "Trang chủ",
    split: "Tách 1 PDF",
    "batch-split": "Tách hàng loạt",
    "batch-merge": "Ghép trước/sau",
    "merge-all": "Gộp 1 PDF",
  };

  return (
    <div className="min-h-screen overflow-x-hidden bg-[radial-gradient(circle_at_12%_0%,rgba(224,231,255,0.8),transparent_23%),radial-gradient(circle_at_92%_12%,rgba(207,250,254,0.72),transparent_24%),#fdfdfd] font-sans text-zinc-900 selection:bg-violet-200">
      <header className="sticky top-0 z-50 border-b border-white/70 bg-white/70 backdrop-blur-xl">
        <div
          className={cn(
            "mx-auto flex min-h-14 items-center justify-between gap-3 px-4 py-1.5 sm:px-5",
            mode === "split" && file ? "max-w-[1600px]" : "max-w-6xl",
          )}
        >
          <button
            type="button"
            onClick={() => setMode("home")}
            className="group flex min-w-0 items-center gap-3 text-left"
            aria-label="Về trang chủ PDF Toolkit"
          >
            <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-600 via-indigo-600 to-cyan-500 shadow-lg shadow-indigo-200 transition-transform group-hover:scale-105">
              <FileText className="relative h-4 w-4 text-white" />
              <span className="absolute -right-1 -top-1 h-3 w-3 rounded-full border-2 border-white bg-cyan-300" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-black tracking-[-0.025em] text-zinc-900 sm:text-base">
                PDF Toolkit
                <span className="hidden lg:inline"> • BCHQS P. Tân Sơn Nhì</span>
              </h1>
              <p className="hidden text-[10px] font-medium text-zinc-500 sm:block">Tách • ghép • sắp xếp hồ sơ</p>
            </div>
          </button>

          <div className="flex items-center gap-2">
            {mode !== "home" && (
              <button
                type="button"
                onClick={() => setMode("home")}
                className="hidden rounded-lg px-2.5 py-1.5 text-xs font-bold text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900 sm:inline-flex"
              >
                Trang chủ
              </button>
            )}
            {hasActiveFiles && (
              <button
                onClick={resetCurrentMode}
                className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-bold text-zinc-600 transition-colors hover:border-rose-200 hover:bg-rose-50 hover:text-rose-700"
              >
                <X className="h-4 w-4" />
                <span className="hidden sm:inline">Hủy bỏ</span>
              </button>
            )}
          </div>
        </div>
      </header>

      <main
        className={cn(
          "mx-auto px-5 sm:px-6",
          mode === "split" && file
            ? "max-w-[1600px] py-3 sm:py-3.5"
            : "max-w-6xl py-7 sm:py-10",
        )}
      >
        {mode === "home" || isToolsMenuOpen ? (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="mb-3 overflow-hidden rounded-xl border border-white/80 bg-white/75 p-1 shadow-[0_8px_20px_rgba(24,24,27,0.05)] backdrop-blur-sm"
          >
            <div className="flex flex-wrap gap-1.5">
              <button
                onClick={() => setMode("home")}
                className={cn(
                  "flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2.5 py-2 text-xs font-semibold transition-all sm:flex-none",
                  mode === "home"
                    ? "bg-gradient-to-r from-violet-600 to-indigo-600 text-white shadow-md shadow-indigo-200"
                    : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900",
                )}
              >
                <span className="hidden sm:inline">Trang chủ</span>
                <span className="sm:hidden">Home</span>
              </button>
              <button
                onClick={() => setMode("split")}
                className={cn(
                  "flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2.5 py-2 text-xs font-semibold transition-all sm:flex-none",
                  mode === "split"
                    ? "bg-zinc-900 text-white shadow-sm"
                    : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900",
                )}
              >
                <FileText className="h-4 w-4" />
                Tách 1 PDF
              </button>
              <button
                onClick={() => setMode("batch-split")}
                className={cn(
                  "flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2.5 py-2 text-xs font-semibold transition-all sm:flex-none",
                  mode === "batch-split"
                    ? "bg-zinc-900 text-white shadow-sm"
                    : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900",
                )}
              >
                <Archive className="h-4 w-4" />
                Tách hàng loạt
              </button>
              <button
                onClick={() => setMode("batch-merge")}
                className={cn(
                  "flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2.5 py-2 text-xs font-semibold transition-all sm:flex-none",
                  mode === "batch-merge"
                    ? "bg-zinc-900 text-white shadow-sm"
                    : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900",
                )}
              >
                <Files className="h-4 w-4" />
                Ghép trước/sau
              </button>
              <button
                onClick={() => setMode("merge-all")}
                className={cn(
                  "flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2.5 py-2 text-xs font-semibold transition-all sm:flex-none",
                  mode === "merge-all"
                    ? "bg-zinc-900 text-white shadow-sm"
                    : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900",
                )}
              >
                <Files className="h-4 w-4" />
                Gộp 1 PDF
              </button>
            </div>
          </motion.div>
        ) : (
          <div className="mb-3 flex items-center justify-between gap-2 rounded-xl border border-zinc-200 bg-white/90 px-3 py-2 shadow-sm">
            <div className="min-w-0">
              <p className="truncate text-xs font-bold text-zinc-700">{activeModeLabel[mode]}</p>
            </div>
            <button
              type="button"
              onClick={() => setIsToolsMenuOpen(true)}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-bold text-zinc-700 transition hover:border-zinc-400 hover:bg-zinc-50"
              aria-expanded={false}
            >
              Đổi
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        <AnimatePresence mode="wait">
          {mode === "home" && <HomeLanding onOpenMode={setMode} />}
          {mode === "split" && (
            <motion.div
              key="split-mode"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
            >
              {isParsing ? (
                <div className="flex flex-col items-center justify-center gap-4 py-24">
                  <Loader2 className="h-12 w-12 animate-spin text-zinc-900" />
                  <p className="font-medium text-zinc-500">
                    Đang phân tích tài liệu PDF...
                  </p>
                </div>
              ) : !file ? (
                <div className="mx-auto max-w-xl">
                  <div
                    onClick={() => fileInputRef.current?.click()}
                    className="group relative flex cursor-pointer flex-col items-center justify-center gap-6 rounded-3xl border-2 border-dashed border-zinc-200 p-12 transition-all hover:border-zinc-900 hover:bg-zinc-50"
                  >
                    <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-zinc-100 transition-transform group-hover:scale-110">
                      <Upload className="h-8 w-8 text-zinc-400 group-hover:text-zinc-900" />
                    </div>
                    <div className="text-center">
                      <h2 className="mb-2 text-xl font-semibold">Tải lên tài liệu PDF</h2>
                      <p className="text-sm text-zinc-500">
                        Kéo và thả file hoặc click để chọn từ máy tính
                      </p>
                    </div>
                    <input
                      type="file"
                      ref={fileInputRef}
                      onChange={handleFileUpload}
                      accept={ACCEPT_PDF}
                      className="hidden"
                    />
                  </div>
                </div>
              ) : (
                <div
                  className={cn(
                    "grid min-w-0 grid-cols-1 gap-3 lg:h-[calc(100dvh-134px)] lg:min-h-0 lg:max-h-[calc(100dvh-134px)] lg:items-stretch",
                    isSplitControlsOpen
                      ? "lg:grid-cols-[minmax(0,1fr)_300px]"
                      : "lg:grid-cols-[minmax(0,1fr)_118px]",
                  )}
                >
                  <section className="flex min-w-0 flex-col gap-2 lg:min-h-0">
                    <div className="flex shrink-0 flex-col gap-2 rounded-xl border border-zinc-200 bg-white px-3 py-2.5 shadow-sm sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-400">Tách PDF</p>
                        <h2 className="mt-0.5 text-lg font-black tracking-tight text-zinc-900 sm:text-xl">
                          Trang {currentPageStart} – {currentPageEnd}
                          <span className="font-medium text-zinc-400"> / {totalPages}</span>
                        </h2>
                        <p className="mt-0.5 truncate text-[11px] font-medium text-zinc-500" title={file.name}>
                          {file.name}
                        </p>
                      </div>

                      <div className="flex shrink-0 items-center gap-1.5">
                        <button
                          type="button"
                          onClick={handlePrev}
                          disabled={currentIndex === 0}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-700 transition hover:border-zinc-400 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-30"
                          aria-label="Nhóm trang trước"
                          title="Nhóm trang trước"
                        >
                          <ChevronLeft className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={handleJumpPrompt}
                          className="rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-bold text-zinc-700 transition hover:border-zinc-400 hover:bg-zinc-50"
                        >
                          Tới trang
                        </button>
                        <button
                          type="button"
                          onClick={handleNext}
                          disabled={currentPageEnd >= totalPages}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-700 transition hover:border-zinc-400 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-30"
                          aria-label="Nhóm trang tiếp theo"
                          title="Nhóm trang tiếp theo"
                        >
                          <ChevronRight className="h-4 w-4" />
                        </button>
                      </div>
                    </div>

                    {/* Chế độ đọc dọc với cỡ hiển thị vừa phải: giữ đúng tỷ lệ A4/A3,
                        nhưng không kéo trang dọc phủ kín cả chiều ngang. Khi cần soi chữ nhỏ,
                        dùng nút Toàn màn trên từng trang. */}
                    <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-zinc-200 bg-zinc-200 shadow-sm">
                      <div className="h-full min-h-0 overflow-x-auto overflow-y-auto bg-zinc-200">
                        <div className="mx-auto flex min-h-full w-full max-w-[1280px] flex-col gap-3 bg-zinc-200 p-1.5 sm:p-2">
                          {currentPageIndices.map((pageIndex) => (
                            <PagePreview
                              key={`${file.name}-${file.lastModified}-${pageIndex}`}
                              pdfDoc={pdfDoc}
                              pageNumber={pageIndex + 1}
                            />
                          ))}
                        </div>
                      </div>
                    </div>
                  </section>

                  <aside className="min-w-0 space-y-2 lg:max-h-full lg:overflow-y-auto">
                    {isSplitControlsOpen ? (
                      <section className="rounded-xl border border-zinc-200 bg-white p-3 shadow-sm">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-400">
                              Số trang / file
                            </p>
                            <p className="mt-0.5 text-xs font-medium leading-4 text-zinc-600">
                              Giữ trang {currentPageStart} làm trang đầu.
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => setIsSplitControlsOpen(false)}
                            className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-zinc-200 px-2 py-1 text-[10px] font-bold text-zinc-600 transition hover:border-zinc-400 hover:bg-zinc-50"
                            title="Thu gọn bảng điều khiển để mở rộng vùng xem trước"
                          >
                            Thu gọn
                            <ChevronRight className="h-3.5 w-3.5" />
                          </button>
                        </div>

                        <div className="mt-3 grid grid-cols-5 gap-1">
                          {Array.from({ length: 10 }).map((_, index) => {
                            const value = index + 1;
                            const isActive = pagesPerBatch === value;
                            return (
                              <button
                                key={value}
                                type="button"
                                onClick={() => handlePagesPerBatchChange(value)}
                                className={cn(
                                  "rounded-md border py-1.5 text-xs font-bold transition-all",
                                  isActive
                                    ? "border-zinc-900 bg-zinc-900 text-white shadow-sm"
                                    : "border-zinc-200 bg-white text-zinc-600 hover:border-zinc-400 hover:bg-zinc-50",
                                )}
                              >
                                {value}
                              </button>
                            );
                          })}
                        </div>

                        <button
                          type="button"
                          onClick={handleExport}
                          disabled={isExporting}
                          className="mt-3 flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-zinc-900 px-3 text-xs font-bold text-white transition hover:bg-zinc-800 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {isExporting ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Download className="h-4 w-4" />
                          )}
                          {isExporting ? "Đang xuất..." : `Tách ${currentPageStart}–${currentPageEnd}`}
                        </button>

                        <div className="mt-3 border-t border-zinc-100 pt-3">
                          <button
                            type="button"
                            onClick={() => setIsSplitDetailsOpen((previous) => !previous)}
                            className="flex w-full items-center justify-between gap-2 text-left"
                            aria-expanded={isSplitDetailsOpen}
                          >
                            <span>
                              <span className="block text-xs font-bold text-zinc-800">Tên file & tiến độ</span>
                              <span className="mt-0.5 block text-[10px] text-zinc-500">Mở khi cần chỉnh thêm.</span>
                            </span>
                            {isSplitDetailsOpen ? (
                              <ChevronUp className="h-4 w-4 shrink-0 text-zinc-500" />
                            ) : (
                              <ChevronDown className="h-4 w-4 shrink-0 text-zinc-500" />
                            )}
                          </button>

                          <AnimatePresence initial={false}>
                            {isSplitDetailsOpen && (
                              <motion.div
                                initial={{ opacity: 0, height: 0 }}
                                animate={{ opacity: 1, height: "auto" }}
                                exit={{ opacity: 0, height: 0 }}
                                className="overflow-hidden"
                              >
                                <div className="space-y-3 pt-3">
                                  <div className="space-y-1.5">
                                    <label className="text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-400">
                                      Tên file xuất ra
                                    </label>
                                    <input
                                      type="text"
                                      value={fileName}
                                      onChange={(event) => {
                                        setFileName(event.target.value);
                                        setIsSplitFileNameAuto(false);
                                      }}
                                      placeholder="Nhập tên file..."
                                      className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 py-2 text-xs font-medium transition focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/5"
                                    />
                                  </div>

                                  <div className="border-t border-zinc-100 pt-3">
                                    <div className="flex items-center justify-between text-xs">
                                      <span className="font-medium text-zinc-500">Tiến độ</span>
                                      <span className="font-black text-zinc-800">{completedCount} / {totalBatches}</span>
                                    </div>
                                    <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-zinc-100">
                                      <motion.div
                                        initial={{ width: 0 }}
                                        animate={{ width: `${splitProgressPercent}%` }}
                                        className="h-full rounded-full bg-zinc-900"
                                      />
                                    </div>
                                  </div>

                                  <p className="text-[10px] leading-4 text-zinc-500">
                                    Preview giữ đúng tỷ lệ A4/A3 với cỡ vừa phải; mở “Toàn màn” trên từng trang khi cần đọc kỹ.
                                  </p>
                                </div>
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>
                      </section>
                    ) : (
                      <section className="rounded-xl border border-zinc-200 bg-white p-2 shadow-sm">
                        <button
                          type="button"
                          onClick={() => setIsSplitControlsOpen(true)}
                          className="flex w-full items-center justify-between rounded-lg border border-zinc-200 bg-zinc-50 px-2 py-2 text-left transition hover:border-zinc-400"
                          title="Mở bảng điều khiển tách PDF"
                        >
                          <span>
                            <span className="block text-[10px] font-bold uppercase tracking-wide text-zinc-400">Tách</span>
                            <span className="block text-sm font-black text-zinc-800">{pagesPerBatch} tr</span>
                          </span>
                          <ChevronLeft className="h-4 w-4 text-zinc-600" />
                        </button>
                        <button
                          type="button"
                          onClick={handleExport}
                          disabled={isExporting}
                          className="mt-2 flex h-9 w-full items-center justify-center gap-1.5 rounded-lg bg-zinc-900 px-1.5 text-[11px] font-bold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
                          title={`Tách trang ${currentPageStart} đến ${currentPageEnd}`}
                        >
                          {isExporting ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Download className="h-4 w-4" />
                          )}
                          <span>{isExporting ? "..." : "Tách"}</span>
                        </button>
                      </section>
                    )}

                    {isSplitControlsOpen && currentBatchCompleted && (
                      <motion.div
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="flex items-center gap-2 rounded-lg border border-emerald-100 bg-emerald-50 px-2.5 py-2 text-emerald-700"
                      >
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                        <span className="text-[10px] font-semibold">Nhóm này đã tải về.</span>
                      </motion.div>
                    )}
                  </aside>
                </div>
              )}
            </motion.div>
          )}

          {mode === "batch-split" && (
            <motion.div
              key="batch-split-mode"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              className="space-y-8"
            >
              <div className="max-w-3xl">
                <h2 className="text-3xl font-bold tracking-tight">Tách nhiều PDF cùng lúc</h2>
                <p className="mt-3 text-zinc-500">
                  Chọn nhiều PDF, đặt số trang cho mỗi file con. Hệ thống tách từng PDF
                  theo thứ tự tên file rồi tải một file ZIP chứa tất cả kết quả.
                </p>
              </div>

              <section className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
                <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    <p className="text-xs font-bold uppercase tracking-widest text-zinc-400">
                      Bước 1
                    </p>
                    <h3 className="mt-1 text-xl font-bold">Chọn danh sách PDF</h3>
                    <p className="mt-1 text-sm text-zinc-500">
                      Mặc định sắp xếp: 1, 2, 10. Bạn có thể đổi lại thứ tự sau khi import.
                    </p>
                  </div>
                  <span className="w-fit rounded-full bg-zinc-100 px-3 py-1 text-sm font-bold text-zinc-700">
                    {batchSplitFiles.length} PDF
                  </span>
                </div>

                <button
                  onClick={() => batchSplitInputRef.current?.click()}
                  className="mt-6 flex w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-zinc-200 p-8 text-center transition hover:border-zinc-900 hover:bg-zinc-50"
                >
                  <Upload className="h-7 w-7 text-zinc-400" />
                  <span className="font-semibold">Chọn nhiều PDF để tách</span>
                  <span className="text-xs text-zinc-500">Chỉ nhận file PDF</span>
                </button>
                <input
                  ref={batchSplitInputRef}
                  type="file"
                  multiple
                  accept={ACCEPT_PDF}
                  onChange={handleBatchSplitFiles}
                  className="hidden"
                />

                <div className="mt-6">
                  <SelectedFileList
                    files={batchSplitFiles}
                    onMove={moveBatchSplitFile}
                    disabled={isBatchSplitting}
                    emptyText="Chọn một hoặc nhiều PDF để bắt đầu."
                  />
                </div>
              </section>

              {batchSplitFiles.length > 0 && (
                <section className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
                  <p className="text-xs font-bold uppercase tracking-widest text-zinc-400">
                    Bước 2
                  </p>
                  <h3 className="mt-1 text-xl font-bold">Thiết lập tách hàng loạt</h3>
                  <p className="mt-1 text-sm text-zinc-500">
                    Mỗi PDF sẽ được tách lại từ đầu theo cùng số trang bạn chọn, theo đúng thứ tự danh sách đã sắp xếp ở Bước 1.
                  </p>

                  <div className="mt-6 max-w-xl">
                    <label className="text-xs font-bold uppercase tracking-widest text-zinc-400">
                      Số trang mỗi file xuất
                    </label>
                    <div className="mt-3 grid grid-cols-5 gap-2">
                      {Array.from({ length: 10 }).map((_, index) => {
                        const value = index + 1;
                        const isActive = batchSplitPagesPerFile === value;
                        return (
                          <button
                            key={value}
                            onClick={() => setBatchSplitPagesPerFile(value)}
                            className={cn(
                              "rounded-xl border py-2 text-sm font-semibold transition-all",
                              isActive
                                ? "scale-105 border-zinc-900 bg-zinc-900 text-white shadow-md"
                                : "border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900",
                            )}
                          >
                            {value}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <ProgressBar
                    completed={batchSplitProgress.completed}
                    total={batchSplitProgress.total || batchSplitFiles.length}
                  />

                  <button
                    onClick={handleBatchSplit}
                    disabled={isBatchSplitting}
                    className="mt-6 flex w-full items-center justify-center gap-3 rounded-2xl bg-zinc-900 py-4 font-semibold text-white transition-all hover:bg-zinc-800 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isBatchSplitting ? (
                      <Loader2 className="h-5 w-5 animate-spin" />
                    ) : (
                      <Archive className="h-5 w-5" />
                    )}
                    {isBatchSplitting
                      ? `Đang tách ${batchSplitProgress.completed}/${batchSplitProgress.total}...`
                      : "Tách tất cả và tải ZIP"}
                  </button>
                </section>
              )}

              {batchSplitResult && (
                <div
                  className={cn(
                    "flex gap-3 rounded-2xl border p-5",
                    batchSplitResult.failedFiles.length === 0
                      ? "border-emerald-100 bg-emerald-50 text-emerald-700"
                      : "border-amber-200 bg-amber-50 text-amber-800",
                  )}
                >
                  {batchSplitResult.failedFiles.length === 0 ? (
                    <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />
                  ) : (
                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
                  )}
                  <div className="text-sm leading-6">
                    <p className="font-semibold">
                      Đã tách {batchSplitResult.successFileCount}/{batchSplitFiles.length} PDF,
                      tạo {batchSplitResult.generatedFileCount} file đầu ra.
                    </p>
                    {batchSplitResult.failedFiles.length > 0 && (
                      <p className="mt-1">
                        Có {batchSplitResult.failedFiles.length} PDF lỗi. Xem
                        {" "}README_KET_QUA_TACH.txt trong ZIP để biết file nào lỗi.
                      </p>
                    )}
                  </div>
                </div>
              )}
            </motion.div>
          )}

          {mode === "batch-merge" && (
            <motion.div
              key="batch-merge-mode"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              className="space-y-8"
            >
              <div className="max-w-3xl">
                <h2 className="text-3xl font-bold tracking-tight">
                  Ghép mặt trước và mặt sau hàng loạt
                </h2>
                <p className="mt-3 text-zinc-500">
                  Chọn hai danh sách PDF/JPG/PNG. Hệ thống tự sắp xếp lần đầu theo
                  tên file (1, 2, 10); sau đó bạn có thể đổi thứ tự ở mỗi danh sách trước
                  khi ghép từng cặp và xuất toàn bộ kết quả thành một file ZIP.
                </p>
              </div>

              <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                <section className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
                  <div className="mb-5 flex items-start justify-between gap-4">
                    <div>
                      <p className="text-xs font-bold uppercase tracking-widest text-zinc-400">
                        Bước 1
                      </p>
                      <h3 className="mt-1 text-xl font-bold">Danh sách mặt trước</h3>
                      <p className="mt-1 text-sm text-zinc-500">
                        PDF hoặc ảnh có sẵn mặt trước.
                      </p>
                    </div>
                    <span className="rounded-full bg-zinc-100 px-3 py-1 text-sm font-bold text-zinc-700">
                      {frontFiles.length} file
                    </span>
                  </div>

                  <button
                    onClick={() => frontInputRef.current?.click()}
                    className="flex w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-zinc-200 p-8 text-center transition hover:border-zinc-900 hover:bg-zinc-50"
                  >
                    <Upload className="h-7 w-7 text-zinc-400" />
                    <span className="font-semibold">Chọn các file mặt trước</span>
                    <span className="text-xs text-zinc-500">PDF, JPG, JPEG hoặc PNG</span>
                  </button>
                  <input
                    ref={frontInputRef}
                    type="file"
                    multiple
                    accept={ACCEPT_MERGE_FILES}
                    onChange={(event) => handleBatchFiles(event, "front")}
                    className="hidden"
                  />

                  <div className="mt-5">
                    <SelectedFileList
                      files={frontFiles}
                      onMove={(fromIndex, toIndex) =>
                        moveBatchMergeFile("front", fromIndex, toIndex)
                      }
                      disabled={isBatchMerging}
                      emptyText="Chọn danh sách file mặt trước."
                    />
                  </div>
                </section>

                <section className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
                  <div className="mb-5 flex items-start justify-between gap-4">
                    <div>
                      <p className="text-xs font-bold uppercase tracking-widest text-zinc-400">
                        Bước 2
                      </p>
                      <h3 className="mt-1 text-xl font-bold">Danh sách mặt sau</h3>
                      <p className="mt-1 text-sm text-zinc-500">
                        Ảnh hoặc PDF cần được thêm vào sau mặt trước.
                      </p>
                    </div>
                    <span className="rounded-full bg-zinc-100 px-3 py-1 text-sm font-bold text-zinc-700">
                      {backFiles.length} file
                    </span>
                  </div>

                  <button
                    onClick={() => backInputRef.current?.click()}
                    className="flex w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-zinc-200 p-8 text-center transition hover:border-zinc-900 hover:bg-zinc-50"
                  >
                    <Upload className="h-7 w-7 text-zinc-400" />
                    <span className="font-semibold">Chọn các file mặt sau</span>
                    <span className="text-xs text-zinc-500">PDF, JPG, JPEG hoặc PNG</span>
                  </button>
                  <input
                    ref={backInputRef}
                    type="file"
                    multiple
                    accept={ACCEPT_MERGE_FILES}
                    onChange={(event) => handleBatchFiles(event, "back")}
                    className="hidden"
                  />

                  <div className="mt-5">
                    <SelectedFileList
                      files={backFiles}
                      onMove={(fromIndex, toIndex) =>
                        moveBatchMergeFile("back", fromIndex, toIndex)
                      }
                      disabled={isBatchMerging}
                      emptyText="Chọn danh sách file mặt sau."
                    />
                  </div>
                </section>
              </div>

              {(frontFiles.length > 0 || backFiles.length > 0) && (
                <section className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-xs font-bold uppercase tracking-widest text-zinc-400">
                        Bước 3
                      </p>
                      <h3 className="mt-1 text-xl font-bold">Kiểm tra các cặp ghép</h3>
                      <p className="mt-1 text-sm text-zinc-500">
                        Đổi thứ tự mặt trước hoặc mặt sau ở hai danh sách phía trên; bảng này sẽ cập nhật ngay để bạn kiểm tra đúng cặp trước khi ghép.
                      </p>
                    </div>
                    <span className="w-fit rounded-full bg-zinc-900 px-3 py-1 text-sm font-bold text-white">
                      {pairCount} cặp sẽ được ghép
                    </span>
                  </div>

                  {frontFiles.length !== backFiles.length && (
                    <div className="mt-5 flex gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-amber-800">
                      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
                      <p className="text-sm leading-6">
                        Số lượng chưa bằng nhau. Hệ thống chỉ ghép {pairCount} cặp đầu tiên; {" "}
                        {frontFiles.length > pairCount
                          ? `${frontFiles.length - pairCount} file mặt trước`
                          : `${backFiles.length - pairCount} file mặt sau`} sẽ chưa được dùng.
                      </p>
                    </div>
                  )}

                  {pairCount > 0 ? (
                    <div className="mt-5 overflow-hidden rounded-2xl border border-zinc-200">
                      <div className="grid grid-cols-[48px_minmax(0,1fr)_28px_minmax(0,1fr)] gap-3 border-b border-zinc-200 bg-zinc-50 px-4 py-3 text-xs font-bold uppercase tracking-wider text-zinc-400">
                        <span>STT</span>
                        <span>Mặt trước</span>
                        <span />
                        <span>Mặt sau</span>
                      </div>
                      <div className="max-h-80 overflow-y-auto">
                        {batchPairs.map((pair, index) => (
                          <div
                            key={`${pair.front.name}-${pair.back.name}-${index}`}
                            className="grid grid-cols-[48px_minmax(0,1fr)_28px_minmax(0,1fr)] items-center gap-3 border-b border-zinc-100 px-4 py-3 text-sm last:border-b-0"
                          >
                            <span className="font-bold text-zinc-400">{index + 1}</span>
                            <span className="truncate font-medium" title={pair.front.name}>
                              {pair.front.name}
                            </span>
                            <ArrowRight className="h-4 w-4 text-zinc-400" />
                            <span className="truncate font-medium" title={pair.back.name}>
                              {pair.back.name}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <p className="mt-5 rounded-2xl bg-zinc-50 p-4 text-sm text-zinc-500">
                      Chọn tối thiểu một file ở mỗi danh sách để tạo cặp ghép.
                    </p>
                  )}

                  <ProgressBar
                    completed={batchMergeProgress.completed}
                    total={batchMergeProgress.total || pairCount}
                  />

                  <button
                    onClick={handleBatchMerge}
                    disabled={pairCount === 0 || isBatchMerging}
                    className="mt-6 flex w-full items-center justify-center gap-3 rounded-2xl bg-zinc-900 py-4 font-semibold text-white transition-all hover:bg-zinc-800 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isBatchMerging ? (
                      <Loader2 className="h-5 w-5 animate-spin" />
                    ) : (
                      <Archive className="h-5 w-5" />
                    )}
                    {isBatchMerging
                      ? `Đang ghép ${batchMergeProgress.completed}/${batchMergeProgress.total}...`
                      : "Ghép tất cả và tải file ZIP"}
                  </button>
                </section>
              )}

              {batchMergeResult && (
                <div
                  className={cn(
                    "flex gap-3 rounded-2xl border p-5",
                    batchMergeResult.failedFiles.length === 0
                      ? "border-emerald-100 bg-emerald-50 text-emerald-700"
                      : "border-amber-200 bg-amber-50 text-amber-800",
                  )}
                >
                  {batchMergeResult.failedFiles.length === 0 ? (
                    <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />
                  ) : (
                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
                  )}
                  <div className="text-sm leading-6">
                    <p className="font-semibold">
                      Đã ghép thành công {batchMergeResult.successCount}/{pairCount} cặp.
                    </p>
                    {batchMergeResult.failedFiles.length > 0 && (
                      <p className="mt-1">
                        Có {batchMergeResult.failedFiles.length} cặp lỗi. Xem file {" "}
                        README_KET_QUA_GHEP.txt trong ZIP để biết cặp nào không xuất được.
                      </p>
                    )}
                  </div>
                </div>
              )}
            </motion.div>
          )}

          {mode === "merge-all" && (
            <motion.div
              key="merge-all-mode"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              className="space-y-8"
            >
              <div className="max-w-3xl">
                <h2 className="text-3xl font-bold tracking-tight">Gộp tất cả thành một PDF</h2>
                <p className="mt-3 text-zinc-500">
                  Chọn một danh sách PDF hoặc ảnh. Hệ thống sắp xếp theo tên file tự nhiên
                  (1, 2, 10), sau đó nối toàn bộ vào một PDF duy nhất theo đúng thứ tự đó.
                </p>
              </div>

              <section className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
                <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    <p className="text-xs font-bold uppercase tracking-widest text-zinc-400">
                      Bước 1
                    </p>
                    <h3 className="mt-1 text-xl font-bold">Chọn toàn bộ file cần gộp</h3>
                    <p className="mt-1 text-sm text-zinc-500">
                      Hỗ trợ PDF, JPG, JPEG và PNG.
                    </p>
                  </div>
                  <span className="w-fit rounded-full bg-zinc-100 px-3 py-1 text-sm font-bold text-zinc-700">
                    {mergeAllFiles.length} file
                  </span>
                </div>

                <button
                  onClick={() => mergeAllInputRef.current?.click()}
                  className="mt-6 flex w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-zinc-200 p-8 text-center transition hover:border-zinc-900 hover:bg-zinc-50"
                >
                  <Upload className="h-7 w-7 text-zinc-400" />
                  <span className="font-semibold">Chọn tất cả file cần gộp</span>
                  <span className="text-xs text-zinc-500">PDF, JPG, JPEG hoặc PNG</span>
                </button>
                <input
                  ref={mergeAllInputRef}
                  type="file"
                  multiple
                  accept={ACCEPT_MERGE_FILES}
                  onChange={handleMergeAllFiles}
                  className="hidden"
                />

                <div className="mt-6">
                  <SelectedFileList
                    files={mergeAllFiles}
                    emptyText="Chọn ít nhất một file để gộp thành PDF."
                  />
                </div>
              </section>

              {mergeAllFiles.length > 0 && (
                <section className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
                  <p className="text-xs font-bold uppercase tracking-widest text-zinc-400">
                    Bước 2
                  </p>
                  <h3 className="mt-1 text-xl font-bold">Tạo một file PDF duy nhất</h3>
                  <p className="mt-1 text-sm text-zinc-500">
                    Thứ tự hiển thị trong danh sách chính là thứ tự trang được gộp.
                  </p>

                  <div className="mt-6 max-w-xl space-y-2">
                    <label className="text-xs font-bold uppercase tracking-widest text-zinc-400">
                      Tên file xuất ra
                    </label>
                    <input
                      type="text"
                      value={mergeAllName}
                      onChange={(event) => setMergeAllName(event.target.value)}
                      placeholder="tai_lieu_da_gop"
                      className="w-full rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 font-medium transition-all focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/5"
                    />
                  </div>

                  <ProgressBar
                    completed={mergeAllProgress.completed}
                    total={mergeAllProgress.total || mergeAllFiles.length}
                  />

                  <button
                    onClick={handleMergeAll}
                    disabled={isMergingAll}
                    className="mt-6 flex w-full items-center justify-center gap-3 rounded-2xl bg-zinc-900 py-4 font-semibold text-white transition-all hover:bg-zinc-800 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isMergingAll ? (
                      <Loader2 className="h-5 w-5 animate-spin" />
                    ) : (
                      <Download className="h-5 w-5" />
                    )}
                    {isMergingAll
                      ? `Đang gộp ${mergeAllProgress.completed}/${mergeAllProgress.total}...`
                      : "Gộp thành một PDF và tải về"}
                  </button>
                </section>
              )}

              {mergeAllResult && (
                <div
                  className={cn(
                    "flex gap-3 rounded-2xl border p-5",
                    mergeAllResult.failedFiles.length === 0
                      ? "border-emerald-100 bg-emerald-50 text-emerald-700"
                      : "border-amber-200 bg-amber-50 text-amber-800",
                  )}
                >
                  {mergeAllResult.failedFiles.length === 0 ? (
                    <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />
                  ) : (
                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
                  )}
                  <div className="text-sm leading-6">
                    <p className="font-semibold">
                      Đã gộp {mergeAllResult.successCount}/{mergeAllFiles.length} file thành {" "}
                      {mergeAllResult.totalPages} trang PDF.
                    </p>
                    {mergeAllResult.failedFiles.length > 0 && (
                      <p className="mt-1">
                        Có {mergeAllResult.failedFiles.length} file không gộp được (thường do
                        file bị khóa/mật khẩu hoặc hỏng). PDF đã tải về chỉ gồm các file hợp lệ.
                      </p>
                    )}
                  </div>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}
