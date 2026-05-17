import { useRef, useState } from "react";
import { Upload } from "lucide-react";
import clsx from "clsx";

interface Props {
  onFileSelected: (file: File) => void;
  disabled?: boolean;
}

/**
 * Drag-and-drop / click-to-browse PDF picker.
 *
 * Files never leave the browser. We hand the ``File`` object straight to
 * the caller, which streams it through PDF.js.
 */
export function PdfUploader({ onFileSelected, disabled }: Props) {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleFile(file: File | undefined) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      alert("Please select a PDF file.");
      return;
    }
    onFileSelected(file);
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragging(false);
        if (disabled) return;
        handleFile(e.dataTransfer.files[0]);
      }}
      onClick={() => !disabled && inputRef.current?.click()}
      className={clsx(
        "rounded-lg border-2 border-dashed p-10 text-center transition select-none",
        disabled
          ? "cursor-not-allowed opacity-50 border-zinc-700"
          : "cursor-pointer",
        !disabled && isDragging && "border-blue-400 bg-blue-500/10",
        !disabled && !isDragging && "border-zinc-700 hover:border-zinc-500",
      )}
    >
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        onChange={(e) => handleFile(e.target.files?.[0])}
      />
      <div className="flex flex-col items-center gap-3">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-zinc-800">
          <Upload className="h-7 w-7 text-zinc-300" />
        </div>
        <div className="text-base font-medium text-zinc-200">
          Drop a chapter PDF here, or click to browse
        </div>
        <div className="text-xs text-zinc-500">
          PDFs only. All processing stays on your device — nothing is uploaded.
        </div>
      </div>
    </div>
  );
}
