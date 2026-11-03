import { useState } from 'react';

// 컬럼 전체를 파일 드롭 영역으로 쓰는 반복 패턴(Collections/Documents/JsonLevelColumn)에서 공용으로 사용
export function useFileDrop(onFile: (file: File) => void) {
  const [isDragOver, setIsDragOver] = useState(false);

  return {
    isDragOver,
    dragHandlers: {
      onDragOver: (e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setIsDragOver(true);
      },
      onDragLeave: (e: React.DragEvent) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setIsDragOver(false);
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragOver(false);
        const file = e.dataTransfer.files?.[0];
        if (file) onFile(file);
      },
    },
  };
}
