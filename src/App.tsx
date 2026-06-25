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
  Upload,
  X,
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
  ordering: "/images/hanh_quan_2.jpg",
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

const PagePreview: React.FC<PagePreviewProps> = ({ pdfDoc, pageNumber }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    const renderPage = async () => {
      if (!pdfDoc || !canvasRef.current) return;

      setIsLoading(true);
      setError(null);

      try {
        const page = await pdfDoc.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 2 });
        const canvas = canvasRef.current;
        const context = canvas.getContext("2d");

        if (context && isMounted) {
          canvas.height = viewport.height;
          canvas.width = viewport.width;
          context.clearRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvasContext: context, viewport }).promise;
        }
      } catch (err) {
        console.error("Error rendering page:", err);
        if (isMounted) setError("Không thể hiển thị trang");
      } finally {
        if (isMounted) setIsLoading(false);
      }
    };

    void renderPage();

    return () => {
      isMounted = false;
    };
  }, [pdfDoc, pageNumber]);

  return (
    <div className="relative flex min-h-[400px] w-full flex-1 flex-col items-center justify-center overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-md transition-all hover:shadow-lg">
      {isLoading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-zinc-50/80">
          <Loader2 className="h-8 w-8 animate-spin text-zinc-900" />
        </div>
      )}
      {error && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-red-50 p-4 text-center">
          <p className="text-sm font-medium text-red-500">{error}</p>
        </div>
      )}
      <canvas
        ref={canvasRef}
        className="h-auto w-full object-contain"
        style={{ imageRendering: "auto" }}
      />
      <div className="w-full border-t border-zinc-100 bg-zinc-50 py-3 text-center text-sm font-bold uppercase tracking-tighter text-zinc-600">
        Trang {pageNumber}
      </div>
    </div>
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

  // Tách một PDF, có xem trước và tiến độ riêng theo số trang/lần tách.
  const [file, setFile] = useState<File | null>(null);
  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [totalPages, setTotalPages] = useState(0);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [fileName, setFileName] = useState("");
  const [isExporting, setIsExporting] = useState(false);
  const [isParsing, setIsParsing] = useState(false);
  const [pagesPerBatch, setPagesPerBatch] = useState(2);
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

  const totalBatches = totalPages > 0 ? Math.ceil(totalPages / pagesPerBatch) : 0;
  const completedBatches = completedBatchesBySize[pagesPerBatch];
  const completedCount = completedBatches?.size ?? 0;
  const currentBatchCompleted = completedBatches?.has(currentIndex) ?? false;
  const splitProgressPercent =
    totalBatches > 0 ? Math.min(100, (completedCount / totalBatches) * 100) : 0;

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
        `${stripExtension(uploadedFile.name)}_trang_1-${Math.min(
          pagesPerBatch,
          pdf.numPages,
        )}`,
      );
      setCompletedBatchesBySize({});
    } catch (error) {
      console.error("Error parsing PDF:", error);
      alert("Không thể đọc file PDF này. Vui lòng thử lại.");
      resetSplit();
    } finally {
      setIsParsing(false);
    }
  };

  const handleExport = async () => {
    if (!file || isExporting) return;

    setIsExporting(true);

    try {
      const originalPdf = await PDFDocument.load(await file.arrayBuffer());
      const newPdf = await PDFDocument.create();
      const pagesToExtract = Array.from(
        { length: pagesPerBatch },
        (_, index) => currentIndex + index,
      ).filter((index) => index < totalPages);
      const copiedPages = await newPdf.copyPages(originalPdf, pagesToExtract);
      copiedPages.forEach((page) => newPdf.addPage(page));

      const pageStart = currentIndex + 1;
      const pageEnd = Math.min(currentIndex + pagesPerBatch, totalPages);
      const outputName = safeFileName(
        fileName.trim() || `${stripExtension(file.name)}_trang_${pageStart}-${pageEnd}`,
      );

      downloadBlob(
        new Blob([await newPdf.save()], { type: PDF_MIME_TYPE }),
        `${outputName}.pdf`,
      );

      setCompletedBatchesBySize((previous) => {
        const completedForCurrentSize = new Set(previous[pagesPerBatch] ?? []);
        completedForCurrentSize.add(currentIndex);
        return { ...previous, [pagesPerBatch]: completedForCurrentSize };
      });

      if (currentIndex + pagesPerBatch < totalPages) {
        setCurrentIndex(currentIndex + pagesPerBatch);
      }
    } catch (error) {
      console.error("Export failed:", error);
      alert("Không thể tách file ở nhóm trang này.");
    } finally {
      setIsExporting(false);
    }
  };

  const handlePagesPerBatchChange = (nextPagesPerBatch: number) => {
    setPagesPerBatch(nextPagesPerBatch);
    setCurrentIndex((previousIndex) =>
      Math.floor(previousIndex / nextPagesPerBatch) * nextPagesPerBatch,
    );
  };

  const handleNext = () => {
    if (currentIndex + pagesPerBatch < totalPages) {
      setCurrentIndex(currentIndex + pagesPerBatch);
    }
  };

  const handlePrev = () => {
    if (currentIndex - pagesPerBatch >= 0) {
      setCurrentIndex(currentIndex - pagesPerBatch);
    }
  };

  const handleJumpPrompt = () => {
    const input = prompt("Nhập số trang muốn tới:");
    if (!input) return;

    const page = Number(input);
    if (!Number.isInteger(page) || page < 1 || page > totalPages) {
      alert("Trang không hợp lệ.");
      return;
    }

    setCurrentIndex(Math.floor((page - 1) / pagesPerBatch) * pagesPerBatch);
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

  return (
    <div className="min-h-screen overflow-x-hidden bg-[radial-gradient(circle_at_12%_0%,rgba(224,231,255,0.8),transparent_23%),radial-gradient(circle_at_92%_12%,rgba(207,250,254,0.72),transparent_24%),#fdfdfd] font-sans text-zinc-900 selection:bg-violet-200">
      <header className="sticky top-0 z-50 border-b border-white/70 bg-white/70 backdrop-blur-xl">
        <div className="mx-auto flex min-h-16 max-w-6xl items-center justify-between gap-4 px-5 py-2 sm:px-6">
          <button
            type="button"
            onClick={() => setMode("home")}
            className="group flex min-w-0 items-center gap-3 text-left"
            aria-label="Về trang chủ PDF Toolkit"
          >
            <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-600 via-indigo-600 to-cyan-500 shadow-lg shadow-indigo-200 transition-transform group-hover:scale-105">
              <FileText className="relative h-5 w-5 text-white" />
              <span className="absolute -right-1 -top-1 h-3 w-3 rounded-full border-2 border-white bg-cyan-300" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-base font-black tracking-[-0.025em] text-zinc-900 sm:text-lg">PDF Toolkit - Ban Chỉ huy Quân sự Phường Tân Sơn Nhì - Ban Quân lực</h1>
              <p className="hidden text-[11px] font-medium text-zinc-500 sm:block">Tách • ghép • sắp xếp hồ sơ</p>
            </div>
          </button>

          <div className="flex items-center gap-2">
            {mode !== "home" && (
              <button
                type="button"
                onClick={() => setMode("home")}
                className="hidden rounded-xl px-3 py-2 text-sm font-bold text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900 sm:inline-flex"
              >
                Trang chủ
              </button>
            )}
            {hasActiveFiles && (
              <button
                onClick={resetCurrentMode}
                className="inline-flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm font-bold text-zinc-600 transition-colors hover:border-rose-200 hover:bg-rose-50 hover:text-rose-700"
              >
                <X className="h-4 w-4" />
                <span className="hidden sm:inline">Hủy bỏ</span>
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-5 py-7 sm:px-6 sm:py-10">
        <div className="mb-7 flex flex-wrap gap-1.5 rounded-2xl border border-white/80 bg-white/75 p-1.5 shadow-[0_12px_30px_rgba(24,24,27,0.06)] backdrop-blur-sm sm:mb-10">
          <button
            onClick={() => setMode("home")}
            className={cn(
              "flex flex-1 items-center justify-center gap-2 rounded-xl px-3 py-3 text-sm font-semibold transition-all sm:flex-none",
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
              "flex flex-1 items-center justify-center gap-2 rounded-xl px-3 py-3 text-sm font-semibold transition-all sm:flex-none",
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
              "flex flex-1 items-center justify-center gap-2 rounded-xl px-3 py-3 text-sm font-semibold transition-all sm:flex-none",
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
              "flex flex-1 items-center justify-center gap-2 rounded-xl px-3 py-3 text-sm font-semibold transition-all sm:flex-none",
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
              "flex flex-1 items-center justify-center gap-2 rounded-xl px-3 py-3 text-sm font-semibold transition-all sm:flex-none",
              mode === "merge-all"
                ? "bg-zinc-900 text-white shadow-sm"
                : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900",
            )}
          >
            <Files className="h-4 w-4" />
            Gộp 1 PDF
          </button>
        </div>

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
                <div className="grid grid-cols-1 gap-12 lg:grid-cols-12">
                  <div className="space-y-8 lg:col-span-7">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <h2 className="text-2xl font-bold tracking-tight">Xem trước trang</h2>
                        <p className="mt-1 text-sm text-zinc-500">
                          Đang xem trang {currentIndex + 1} – {" "}
                          {Math.min(currentIndex + pagesPerBatch, totalPages)} trên tổng số {" "}
                          {totalPages} trang
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <button
                          onClick={handlePrev}
                          disabled={currentIndex === 0}
                          className="rounded-full p-2 transition-colors hover:bg-zinc-100 disabled:opacity-30"
                          aria-label="Nhóm trang trước"
                        >
                          <ChevronLeft className="h-6 w-6" />
                        </button>
                        <button
                          onClick={handleJumpPrompt}
                          className="rounded-lg border border-zinc-200 px-3 py-1.5 text-sm font-semibold transition hover:bg-zinc-100"
                        >
                          Tới trang
                        </button>
                        <button
                          onClick={handleNext}
                          disabled={currentIndex + pagesPerBatch >= totalPages}
                          className="rounded-full p-2 transition-colors hover:bg-zinc-100 disabled:opacity-30"
                          aria-label="Nhóm trang tiếp theo"
                        >
                          <ChevronRight className="h-6 w-6" />
                        </button>
                      </div>
                    </div>

                    <div className="flex min-h-[500px] flex-col gap-4 rounded-[32px] border border-zinc-200/60 bg-zinc-100/50 p-6">
                      {Array.from({ length: pagesPerBatch }).map((_, index) => {
                        const pageNumber = currentIndex + index + 1;
                        if (pageNumber > totalPages) return null;
                        return (
                          <PagePreview
                            key={pageNumber}
                            pdfDoc={pdfDoc}
                            pageNumber={pageNumber}
                          />
                        );
                      })}
                    </div>
                  </div>

                  <div className="h-fit space-y-8 lg:sticky lg:top-28 lg:col-span-5">
                    <div className="space-y-3">
                      <label className="text-xs font-bold uppercase tracking-widest text-zinc-400">
                        Số trang mỗi lần tách
                      </label>
                      <div className="grid grid-cols-5 gap-2">
                        {Array.from({ length: 10 }).map((_, index) => {
                          const value = index + 1;
                          const isActive = pagesPerBatch === value;
                          return (
                            <button
                              key={value}
                              onClick={() => handlePagesPerBatchChange(value)}
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
                      <p className="text-xs text-zinc-400">
                        Đang chọn: {" "}
                        <span className="font-semibold text-zinc-700">
                          {pagesPerBatch} trang
                        </span>
                      </p>
                    </div>

                    <div className="space-y-6 rounded-3xl border border-zinc-200 bg-white p-8 shadow-sm">
                      <div className="space-y-2">
                        <label className="text-xs font-bold uppercase tracking-widest text-zinc-400">
                          Tên file xuất ra
                        </label>
                        <input
                          type="text"
                          value={fileName}
                          onChange={(event) => setFileName(event.target.value)}
                          placeholder="Nhập tên file..."
                          className="w-full rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 font-medium transition-all focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/5"
                        />
                      </div>

                      <button
                        onClick={handleExport}
                        disabled={isExporting}
                        className="flex w-full items-center justify-center gap-3 rounded-2xl bg-zinc-900 py-4 font-semibold text-white transition-all hover:bg-zinc-800 active:scale-[0.98] disabled:opacity-50"
                      >
                        {isExporting ? (
                          <Loader2 className="h-5 w-5 animate-spin" />
                        ) : (
                          <Download className="h-5 w-5" />
                        )}
                        {isExporting ? "Đang xuất..." : "Tách và tải về"}
                      </button>

                      <div className="border-t border-zinc-100 pt-4">
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-zinc-500">Tiến độ tách file</span>
                          <span className="font-bold">
                            {completedCount} / {totalBatches}
                          </span>
                        </div>
                        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-zinc-100">
                          <motion.div
                            initial={{ width: 0 }}
                            animate={{ width: `${splitProgressPercent}%` }}
                            className="h-full rounded-full bg-zinc-900"
                          />
                        </div>
                      </div>
                    </div>

                    {currentBatchCompleted && (
                      <motion.div
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="flex items-center gap-3 rounded-2xl border border-emerald-100 bg-emerald-50 p-4 text-emerald-700"
                      >
                        <CheckCircle2 className="h-5 w-5" />
                        <span className="text-sm font-medium">
                          Nhóm trang này đã được tải về với lựa chọn hiện tại.
                        </span>
                      </motion.div>
                    )}

                    <div className="rounded-2xl border border-zinc-200/60 bg-zinc-50 p-6">
                      <h3 className="mb-3 text-sm font-bold uppercase tracking-wider text-zinc-400">
                        Hướng dẫn
                      </h3>
                      <ol className="space-y-3 text-sm text-zinc-600">
                        <li>1. Chọn số trang cần có trong mỗi file xuất ra.</li>
                        <li>2. Đặt tên file, sau đó nhấn “Tách và tải về”.</li>
                        <li>3. Tiến độ được tính riêng theo số trang/lần tách đang chọn.</li>
                      </ol>
                    </div>
                  </div>
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
