/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from 'react';
import { PDFDocument } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist';
import { 
  Upload, 
  ChevronLeft, 
  ChevronRight, 
  Download, 
  FileText, 
  CheckCircle2,
  Loader2,
  X
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// Configure PDF.js worker
const setWorker = () => {
  if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;
  }
};
setWorker();

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface PagePreviewProps {
  pdfDoc: pdfjsLib.PDFDocumentProxy | null;
  pageNumber: number;
}

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
        
        // Use a higher scale for high-quality rendering (2.0 is usually enough for clear text)
        const scale = 2.0;
        const viewport = page.getViewport({ scale });
        
        const canvas = canvasRef.current;
        const context = canvas.getContext('2d');

        if (context && isMounted) {
          canvas.height = viewport.height;
          canvas.width = viewport.width;

          // Clear canvas before rendering
          context.clearRect(0, 0, canvas.width, canvas.height);

          await page.render({
            canvasContext: context,
            viewport: viewport,
          }).promise;
        }
      } catch (err) {
        console.error('Error rendering page:', err);
        if (isMounted) setError('Không thể hiển thị trang');
      } finally {
        if (isMounted) setIsLoading(false);
      }
    };

    renderPage();
    return () => { isMounted = false; };
  }, [pdfDoc, pageNumber]);

  return (
    <div className="relative border border-zinc-200 rounded-xl overflow-hidden bg-white shadow-md flex flex-col items-center justify-center min-h-[400px] w-full flex-1 transition-all hover:shadow-lg">
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-zinc-50/80 z-10">
          <Loader2 className="w-8 h-8 animate-spin text-zinc-900" />
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-red-50 z-10 p-4 text-center">
          <p className="text-sm text-red-500 font-medium">{error}</p>
        </div>
      )}
      <canvas 
        ref={canvasRef} 
        className="w-full h-auto object-contain"
        style={{ imageRendering: 'auto' }}
      />
      <div className="py-3 text-sm font-bold text-zinc-600 bg-zinc-50 w-full text-center border-t border-zinc-100 uppercase tracking-tighter">
        Trang {pageNumber}
      </div>
    </div>
  );
};

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [totalPages, setTotalPages] = useState(0);
  const [currentIndex, setCurrentIndex] = useState(0); // Index of the first page in the pair (0-based)
  const [fileName, setFileName] = useState('');
  const [isExporting, setIsExporting] = useState(false);
  const [isParsing, setIsParsing] = useState(false);
  const [completedPairs, setCompletedPairs] = useState<Set<number>>(new Set());

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const uploadedFile = event.target.files?.[0];
    if (uploadedFile && uploadedFile.type === 'application/pdf') {
      setIsParsing(true);
      try {
        setFile(uploadedFile);
        const arrayBuffer = await uploadedFile.arrayBuffer();
        
        // Ensure worker is set before loading
        if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
          pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;
        }

        const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
        
        const pdf = await loadingTask.promise;
        console.log('PDF loaded successfully:', pdf.numPages, 'pages');
        setPdfDoc(pdf);
        setTotalPages(pdf.numPages);
        setCurrentIndex(0);
        setFileName(uploadedFile.name.replace('.pdf', '') + `_trang_1-2`);
        setCompletedPairs(new Set());
      } catch (error) {
        console.error('Error parsing PDF:', error);
        alert('Không thể đọc file PDF này. Vui lòng thử lại.');
        setFile(null);
      } finally {
        setIsParsing(false);
      }
    }
  };

  const handleExport = async () => {
    if (!file) return;
    setIsExporting(true);

    try {
      const arrayBuffer = await file.arrayBuffer();
      const originalPdf = await PDFDocument.load(arrayBuffer);
      const newPdf = await PDFDocument.create();

      // Extract current 2 pages
      const pagesToExtract = [currentIndex, currentIndex + 1].filter(idx => idx < totalPages);
      const copiedPages = await newPdf.copyPages(originalPdf, pagesToExtract);
      copiedPages.forEach(page => newPdf.addPage(page));

      const pdfBytes = await newPdf.save();
      const blob = new Blob([pdfBytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      
      const link = document.createElement('a');
      link.href = url;
      link.download = `${fileName || 'document'}.pdf`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      setCompletedPairs(prev => new Set(prev).add(currentIndex));
      
      // Auto move to next pair if available
      if (currentIndex + 2 < totalPages) {
        handleNext();
      }
    } catch (error) {
      console.error('Export failed:', error);
    } finally {
      setIsExporting(false);
    }
  };

  const handleNext = () => {
    if (currentIndex + 2 < totalPages) {
      const nextIdx = currentIndex + 2;
      setCurrentIndex(nextIdx);
    }
  };

  const handlePrev = () => {
    if (currentIndex - 2 >= 0) {
      const prevIdx = currentIndex - 2;
      setCurrentIndex(prevIdx);
    }
  };

  const reset = () => {
    setFile(null);
    setPdfDoc(null);
    setTotalPages(0);
    setCurrentIndex(0);
    setFileName('');
    setCompletedPairs(new Set());
  };

  return (
    <div className="min-h-screen bg-[#FDFDFC] text-zinc-900 font-sans selection:bg-zinc-200">
      {/* Header */}
      <header className="border-b border-zinc-200/60 bg-white/80 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-5xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-zinc-900 rounded-lg flex items-center justify-center">
              <FileText className="w-5 h-5 text-white" />
            </div>
            <h1 className="font-semibold tracking-tight text-lg">PDF Splitter</h1>
          </div>
          {file && (
            <button 
              onClick={reset}
              className="text-sm font-medium text-zinc-500 hover:text-zinc-900 transition-colors flex items-center gap-2"
            >
              <X className="w-4 h-4" />
              Hủy bỏ
            </button>
          )}
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-12">
        <AnimatePresence mode="wait">
          {isParsing ? (
            <motion.div
              key="parsing"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center justify-center py-24 gap-4"
            >
              <Loader2 className="w-12 h-12 animate-spin text-zinc-900" />
              <p className="text-zinc-500 font-medium">Đang phân tích tài liệu PDF...</p>
            </motion.div>
          ) : !file ? (
            <motion.div
              key="upload"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="max-w-xl mx-auto"
            >
              <div 
                onClick={() => fileInputRef.current?.click()}
                className="group relative border-2 border-dashed border-zinc-200 rounded-3xl p-12 flex flex-col items-center justify-center gap-6 hover:border-zinc-900 hover:bg-zinc-50 transition-all cursor-pointer"
              >
                <div className="w-16 h-16 bg-zinc-100 rounded-2xl flex items-center justify-center group-hover:scale-110 transition-transform">
                  <Upload className="w-8 h-8 text-zinc-400 group-hover:text-zinc-900" />
                </div>
                <div className="text-center">
                  <h2 className="text-xl font-semibold mb-2">Tải lên tài liệu PDF</h2>
                  <p className="text-zinc-500 text-sm">Kéo và thả file hoặc click để chọn từ máy tính</p>
                </div>
                <input 
                  type="file" 
                  ref={fileInputRef}
                  onChange={handleFileUpload}
                  accept="application/pdf"
                  className="hidden"
                />
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="editor"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="grid grid-cols-1 lg:grid-cols-12 gap-12"
            >
              {/* Left Column: Preview */}
              <div className="lg:col-span-7 space-y-8">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-2xl font-bold tracking-tight">Xem trước trang</h2>
                    <p className="text-zinc-500 text-sm mt-1">
                      Đang xem trang {currentIndex + 1} - {Math.min(currentIndex + 2, totalPages)} trên tổng số {totalPages} trang
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button 
                      onClick={handlePrev}
                      disabled={currentIndex === 0}
                      className="p-2 rounded-full hover:bg-zinc-100 disabled:opacity-30 transition-colors"
                    >
                      <ChevronLeft className="w-6 h-6" />
                    </button>
                    <button 
                      onClick={handleNext}
                      disabled={currentIndex + 2 >= totalPages}
                      className="p-2 rounded-full hover:bg-zinc-100 disabled:opacity-30 transition-colors"
                    >
                      <ChevronRight className="w-6 h-6" />
                    </button>
                  </div>
                </div>

                <div className="flex flex-row gap-4 justify-center p-6 bg-zinc-100/50 rounded-[32px] border border-zinc-200/60 min-h-[500px] items-start">
                  <PagePreview pdfDoc={pdfDoc} pageNumber={currentIndex + 1} />
                  {currentIndex + 1 < totalPages && (
                    <PagePreview pdfDoc={pdfDoc} pageNumber={currentIndex + 2} />
                  )}
                </div>
              </div>

              {/* Right Column: Actions */}
              <div className="lg:col-span-5 space-y-8 lg:sticky lg:top-28 h-fit">
                <div className="bg-white p-8 rounded-3xl border border-zinc-200 shadow-sm space-y-6">
                  <div className="space-y-2">
                    <label className="text-xs font-bold uppercase tracking-widest text-zinc-400">
                      Tên file xuất ra
                    </label>
                    <input 
                      type="text"
                      value={fileName}
                      onChange={(e) => setFileName(e.target.value)}
                      placeholder="Nhập tên file..."
                      className="w-full px-4 py-3 bg-zinc-50 border border-zinc-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900/5 focus:border-zinc-900 transition-all font-medium"
                    />
                  </div>

                  <button 
                    onClick={handleExport}
                    disabled={isExporting}
                    className="w-full bg-zinc-900 text-white py-4 rounded-2xl font-semibold flex items-center justify-center gap-3 hover:bg-zinc-800 active:scale-[0.98] transition-all disabled:opacity-50"
                  >
                    {isExporting ? (
                      <Loader2 className="w-5 h-5 animate-spin" />
                    ) : (
                      <Download className="w-5 h-5" />
                    )}
                    {isExporting ? 'Đang xuất...' : 'Tách và Tải về'}
                  </button>

                  <div className="pt-4 border-t border-zinc-100">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-zinc-500">Tiến độ tách file</span>
                      <span className="font-bold">{completedPairs.size} / {Math.ceil(totalPages / 2)}</span>
                    </div>
                    <div className="w-full h-1.5 bg-zinc-100 rounded-full mt-3 overflow-hidden">
                      <motion.div 
                        initial={{ width: 0 }}
                        animate={{ width: `${(completedPairs.size / Math.ceil(totalPages / 2)) * 100}%` }}
                        className="h-full bg-zinc-900 rounded-full"
                      />
                    </div>
                  </div>
                </div>

                {completedPairs.has(currentIndex) && (
                  <motion.div 
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="flex items-center gap-3 p-4 bg-emerald-50 text-emerald-700 rounded-2xl border border-emerald-100"
                  >
                    <CheckCircle2 className="w-5 h-5" />
                    <span className="text-sm font-medium">Cặp trang này đã được tải về!</span>
                  </motion.div>
                )}

                <div className="p-6 bg-zinc-50 rounded-2xl border border-zinc-200/60">
                  <h3 className="text-sm font-bold mb-3 uppercase tracking-wider text-zinc-400">Hướng dẫn</h3>
                  <ul className="space-y-3 text-sm text-zinc-600">
                    <li className="flex gap-3">
                      <span className="w-5 h-5 rounded-full bg-zinc-200 flex items-center justify-center text-[10px] font-bold shrink-0">1</span>
                      Xem trước 2 trang hiện tại ở khung bên trái.
                    </li>
                    <li className="flex gap-3">
                      <span className="w-5 h-5 rounded-full bg-zinc-200 flex items-center justify-center text-[10px] font-bold shrink-0">2</span>
                      Đặt tên cho file mới và nhấn "Tách và Tải về".
                    </li>
                    <li className="flex gap-3">
                      <span className="w-5 h-5 rounded-full bg-zinc-200 flex items-center justify-center text-[10px] font-bold shrink-0">3</span>
                      Hệ thống sẽ tự động chuyển sang 2 trang tiếp theo.
                    </li>
                  </ul>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}
