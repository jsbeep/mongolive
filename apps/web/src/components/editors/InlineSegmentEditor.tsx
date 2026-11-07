import { useState, useRef, useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, X, Trash2, ChevronRight, ToggleLeft, Hash, Type, Braces, List, Link, KeyRound, Zap, RefreshCw, ClipboardPaste, Upload, CopyPlus, Download, ClipboardCopy, CircleSlash, Calendar, Sigma, Binary } from 'lucide-react';
import { cn } from '../../utils/cn';
import { SPRING_SHARP } from '../../utils/motionPresets';
import {
  collectionKey,
  dateMs,
  displayValue,
  isOid,
  makeDate,
  makeDecimal,
  makeInt32,
  makeLong,
  makeOid,
  parseNumberInput,
  toCanonical,
  toRelaxed,
  valueKind,
  type FieldValueCandidate,
  type JsonValue,
  type ReferenceInfo,
} from '../../types/explorer';
import { api } from '../../services/api';
import { generateObjectId } from '../../utils/objectId';
import { copyToClipboard } from '../../utils/clipboard';
import { getPreferences } from '../../services/preferences';
import { dateInputZone, fromDateInput, toDateInput } from '../../utils/formatValue';

// ── 타입 정의 ─────────────────────────────────────────────────────────────────

type FieldType =
  | 'String' | 'Number' | 'Boolean' | 'Null' | 'Object' | 'Array' | 'ObjectID'
  | 'Date' | 'Decimal128' | 'Long';

interface TypeMeta {
  label: string;
  icon: React.ReactNode;
}

const TYPE_META: Record<FieldType, TypeMeta> = {
  String: { label: 'String', icon: <Type size={12} /> },
  Number: { label: 'Number', icon: <Hash size={12} /> },
  Boolean: { label: 'Boolean', icon: <ToggleLeft size={12} /> },
  Null: { label: 'Null', icon: <CircleSlash size={12} /> },
  Object: { label: 'Object', icon: <Braces size={12} /> },
  Array: { label: 'Array', icon: <List size={12} /> },
  ObjectID: { label: 'ObjectID', icon: <KeyRound size={12} /> },
  Date: { label: 'Date', icon: <Calendar size={12} /> },
  Decimal128: { label: 'Decimal128', icon: <Sigma size={12} /> },
  Long: { label: 'Long', icon: <Binary size={12} /> },
};

// JSON 네이티브 6타입 + ObjectID(이 앱 참조 시스템 핵심이라 EJSON 모드와 무관하게 항상 노출)
const JSON_TYPES: FieldType[] = ['String', 'Number', 'Boolean', 'Null', 'Object', 'Array', 'ObjectID'];
// EJSON 모드일 때(또는 edit 시 항상)만 추가로 노출하는 BSON 확장 타입
const EJSON_EXTRA_TYPES: FieldType[] = ['Date', 'Decimal128', 'Long'];

const isInvalidJson = (text: string): boolean => {
  try { JSON.parse(text); return false; } catch { return true; }
};

// String 값 편집 textarea: 내용에 맞춰 1줄에서 최대 4줄까지 자라고 그 이상은 스크롤.
// 4줄 높이는 실제 computed lineHeight + 세로 패딩으로 계산해 폰트/패딩 변화에 강건하게.
const MAX_STRING_EDITOR_LINES = 4;
const autoResizeStringEditor = (el: HTMLTextAreaElement | null): void => {
  if (!el) return;
  el.style.height = 'auto';
  const cs = getComputedStyle(el);
  const line = parseFloat(cs.lineHeight) || 20;
  const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  const max = line * MAX_STRING_EDITOR_LINES + padY;
  el.style.height = `${Math.min(el.scrollHeight, max)}px`;
  el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
};

// ── Props ─────────────────────────────────────────────────────────────────────

export interface InlineSegmentEditorSubmitData {
  key: string;
  label?: string;
  type?: FieldType;
  value?: JsonValue;
  objectIdMode?: 'generate' | 'pick';
  importedJson?: JsonValue;
}

interface InlineSegmentEditorProps {
  mode: 'add' | 'edit';
  level: 'collection' | 'document' | 'field';
  initialKey?: string;
  // array에 새 항목을 추가할 때만 true — key가 다음 인덱스로 고정되므로 입력을 잠근다.
  // (예전엔 keyValue가 숫자인지로 추론했는데, 숫자로 시작하는 일반 이름에도 번져서 버그가 됐음)
  lockKey?: boolean;
  initialType?: FieldType;
  initialValue?: JsonValue;
  siblingKeys: string[];
  activeDatabaseName?: string | null;
  currentRefInfo?: ReferenceInfo | null;
  // 이 필드가 컬렉션 설정(referenceFields)에 FK로 선언돼 있으면 — 선언 자체는 여기서
  // 바꾸지 않고(ReferenceFieldsManager 전용), 값 입력만 타겟의 후보값으로 보조한다
  referenceFieldConfig?: { targetCollection: string; targetKey: string } | null;
  // true면 Date/Decimal128/Long 같은 BSON 확장 타입도 Add 시 타입 선택지에 노출 (edit 시엔 항상 노출)
  ejsonMode?: boolean;
  // edit 모드(collection/document)에서 Export 시 내보낼 전체 JSON을 비동기로 가져옴
  onExportRequest?: () => Promise<JsonValue>;
  // 부모 컬럼 전체에 파일을 드래그&드롭했을 때 전달되는 파일 — 마운트된 이 에디터의
  // 업로드 input을 누른 것과 동일하게 처리한다
  pendingImportFile?: File | null;
  onPendingImportFileConsumed?: () => void;
  onSubmit: (data: InlineSegmentEditorSubmitData) => Promise<void>;
  onCancel: () => void;
  onDelete?: () => void;
  onDuplicate?: () => void;
}

// ── 스타일 ────────────────────────────────────────────────────────────────────

const styles = {
  container: 'mx-1 my-1 z-10 rounded-2xl bg-white ring-1 shadow-panel',
  containerAdd: 'ring-emerald-200/70 bg-emerald-50/30',
  containerEdit: 'ring-slate-200/70',
  inner: 'p-3 flex flex-col gap-2.5',
  row: 'flex items-center gap-2 w-full',
  input: 'flex w-full min-w-0 text-md px-3 py-2 rounded-xl bg-slate-100/80 text-slate-700 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-400/60 focus:bg-white transition-all',
  inputWithIcons: 'pr-16',
  inputWithThreeIcons: 'pr-24',
  inputError: 'ring-2 ring-red-300 bg-red-50/70',
  inputWrap: 'relative min-w-0 w-full',
  inputIcons: 'absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-0.5',
  inputIconBtn: 'p-1.5 rounded-lg text-slate-400 hover:bg-slate-200/70 hover:text-slate-600 transition-colors',
  errorMsg: 'text-xs text-red-500 px-0.5',
  // 타입 선택기
  typeBtn: 'shrink-0 flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200/70 transition-colors font-medium text-slate-600 whitespace-nowrap',
  typeAccordion: 'flex items-center gap-1 overflow-x-auto',
  typeTab: 'shrink-0 flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200/70 transition-colors font-medium text-slate-500 cursor-pointer whitespace-nowrap',
  typeTabActive: 'bg-emerald-100 text-emerald-700 font-semibold hover:bg-emerald-100',
  // 값 입력
  valueInput: 'w-full text-md px-3 py-2 rounded-xl bg-slate-100/80 text-slate-700 focus:outline-none focus:ring-2 focus:ring-emerald-400/60 focus:bg-white transition-all',
  oidDisplay: 'flex-1 min-w-0 text-[12px] font-mono text-slate-500 px-3 py-2 rounded-xl bg-slate-100/80 truncate',
  textarea: 'w-full text-md px-3 py-2 rounded-xl bg-slate-100/80 text-slate-700 focus:outline-none focus:ring-2 focus:ring-emerald-400/60 focus:bg-white transition-all font-mono resize-y',
  toggle: 'relative w-10 h-5 rounded-full transition-colors cursor-pointer shrink-0',
  toggleThumb: 'absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow-sm transition-transform',
  // 액션 버튼
  actions: 'flex items-center ml-auto',
  actionBtn: 'p-2 rounded-xl transition-colors',
  deleteBtn: 'hover:bg-red-50 text-red-400',
  submitBtn: 'text-emerald-500 hover:bg-emerald-100 disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none',
  cancelBtn: 'hover:bg-slate-100 text-slate-400 hover:text-slate-600',
} as const;

// ── 컴포넌트 ──────────────────────────────────────────────────────────────────

// 위험 영역(의도적으로 더 쪼개지 않음): 이 컴포넌트는 ObjectID 피커/Import/
// Export/타입 아코디언 4개의 하위 기능을 키 상태 대부분 독립적으로 갖고
// 있어 훅으로 분리하기 쉬워 보이지만, handleSubmit(아래)이 그 4개의 상태를
// 전부 한 번에 읽어 제출 payload를 구성하는 통합 지점이다. 훅으로 쪼개도
// 그 결과값을 결국 handleSubmit까지 다시 끌어올려야 해서 복잡도가 줄지
// 않고, 각 훅의 의존성 배열을 옮기다 하나라도 놓치면 제출 데이터가 조용히
// 빠지는 버그가 생긴다 — 테스트가 없어 타입체커도 못 잡는다. 그래서 그대로
// 두었다. 수정이 꼭 필요하면 Export 쪽(handleExportCopy/Download,
// exportCopied)이 다른 상태에 가장 적게 의존하므로 그 부분부터 볼 것.
export function InlineSegmentEditor({
  mode,
  level,
  initialKey = '',
  lockKey = false,
  initialType = 'String',
  initialValue,
  siblingKeys,
  activeDatabaseName,
  currentRefInfo,
  referenceFieldConfig,
  ejsonMode = false,
  onExportRequest,
  pendingImportFile,
  onPendingImportFileConsumed,
  onSubmit,
  onCancel,
  onDelete,
  onDuplicate,
}: InlineSegmentEditorProps) {
  const [keyValue, setKeyValue] = useState(initialKey);
  const [selectedType, setSelectedType] = useState<FieldType>(initialType);
  const [typeAccordionOpen, setTypeAccordionOpen] = useState(false);
  // 편집 전 값의 정확한 BSON 타입 — 숫자를 고쳐도 원래 타입(Int32/Double)을 유지하는 데 쓴다
  const initialKind = initialValue === undefined ? undefined : valueKind(initialValue);
  const [rawValue, setRawValue] = useState(() => {
    if (initialValue === undefined) return '';
    switch (initialKind) {
      case 'boolean':
      case 'string':
      case 'int32':
      case 'double':
      case 'long':
      case 'decimal128':
        return displayValue(initialValue);
      default:
        // 컨테이너/해석 안 되는 BSON 타입은 Canonical 그대로 보여준다 — 손실 없이 왕복된다
        return JSON.stringify(initialValue, null, 2);
    }
  });
  const [boolValue, setBoolValue] = useState(
    typeof initialValue === 'boolean' ? initialValue : false,
  );
  // Date 입력은 '값 표시' 설정과 같은 시간대로(로컬 / UTC) — 화면에 보이는 시각과 편집기 시각이 같게.
  // 밀리초까지 다룬다(예전엔 분까지라 열었다 저장만 해도 초·밀리초가 지워졌다). 편집을 여는 순간의 설정으로 고정.
  const [dateMode] = useState(() => getPreferences().dateDisplay);
  // 밀리초를 안 보이면 초까지만 입력한다(저장할 때 원래 밀리초를 이어 붙인다 — fromDateInput)
  const [dateWithMs] = useState(() => getPreferences().showMs);
  const [initialDateInput] = useState(() => {
    const ms = dateMs(initialValue);
    return ms === undefined ? '' : toDateInput(ms, dateMode, dateWithMs);
  });
  const [dateValue, setDateValue] = useState(initialDateInput);
  // ObjectID 타입: 새로 생성 vs 기존 문서 참조 선택
  const [objectIdMode, setObjectIdMode] = useState<'generate' | 'pick'>('generate');
  const [generatedOid, setGeneratedOid] = useState<string>(() => {
    if (isOid(initialValue)) {
      return initialValue.$oid;
    }
    return generateObjectId();
  });
  const [refCollections, setRefCollections] = useState<{ name: string; label: string }[]>([]);
  const [refCollectionName, setRefCollectionName] = useState('');
  const [refDocs, setRefDocs] = useState<{ id: string; title: string }[]>([]);
  const [refDocId, setRefDocId] = useState<string>(() => {
    if (isOid(initialValue)) {
      return initialValue.$oid;
    }
    return '';
  });
  const [isPending, setIsPending] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const stringInputRef = useRef<HTMLTextAreaElement>(null);
  const refPrefilledRef = useRef(false);

  // Import (collection/document 추가 시 붙여넣기/파일 업로드)
  const [importText, setImportText] = useState('');
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Export (collection/document 수정 시 복사/다운로드) — 기본은 Canonical(손실 없음),
  // 다른 도구에 붙여넣을 땐 Relaxed로 전환
  const [exportCopied, setExportCopied] = useState(false);
  const [exportFormat, setExportFormat] = useState<'canonical' | 'relaxed'>('canonical');
  const formatExport = (json: JsonValue): string =>
    JSON.stringify(exportFormat === 'relaxed' ? toRelaxed(json) : json, null, 2);

  // 기존 REF 필드를 수정할 때, 어떤 컬렉션을 참조 중이었는지 한 번만 미리 채워줌
  useEffect(() => {
    if (currentRefInfo && !refPrefilledRef.current) {
      refPrefilledRef.current = true;
      setRefCollectionName(currentRefInfo.collectionName);
      setObjectIdMode('pick');
    }
  }, [currentRefInfo]);
  const keyInputRef = useRef<HTMLInputElement>(null);
  // 값 입력 영역 — 타입마다 입력 요소가 달라서(textarea/input/스위치/select) 영역 안의 첫 입력에 포커스한다
  const valueAreaRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selectedType !== 'ObjectID' || objectIdMode !== 'pick' || !activeDatabaseName) return;
    api.getCollections(activeDatabaseName).then(setRefCollections).catch(() => setRefCollections([]));
  }, [selectedType, objectIdMode, activeDatabaseName]);

  useEffect(() => {
    if (!refCollectionName || !activeDatabaseName) { setRefDocs([]); return; }
    // 드롭다운으로 고르는 용도라 한 페이지가 아니라 넉넉히(서버 상한 500) 받는다
    api.getDocuments(collectionKey(activeDatabaseName, refCollectionName), { pageSize: 500 })
      .then((page) => setRefDocs(page.items.map((d) => ({ id: d.id, title: d.title }))))
      .catch(() => setRefDocs([]));
  }, [refCollectionName, activeDatabaseName]);

  // 필드 기반 참조(FK)로 선언된 필드 — 값 입력 보조용 후보 목록
  const [fieldRefCandidates, setFieldRefCandidates] = useState<FieldValueCandidate[]>([]);
  useEffect(() => {
    if (!referenceFieldConfig || !activeDatabaseName) { setFieldRefCandidates([]); return; }
    api.getFieldValueCandidates(activeDatabaseName, referenceFieldConfig.targetCollection, referenceFieldConfig.targetKey)
      .then(setFieldRefCandidates)
      .catch(() => setFieldRefCandidates([]));
  }, [referenceFieldConfig?.targetCollection, referenceFieldConfig?.targetKey, activeDatabaseName]);

  // 처음 포커스: 필드 '수정'은 값(대개 고치려는 건 값이라서), 그 밖(추가, 컬렉션·문서 이름 바꾸기)은 key.
  // 값에 입력할 게 없으면(Null 등) key로. 글자 입력이면 커서를 끝에 둔다.
  useEffect(() => {
    if (mode === 'edit' && level === 'field') {
      const target = valueAreaRef.current?.querySelector<HTMLElement>('textarea, input, select, button');
      if (target) {
        target.focus();
        if (target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && target.type === 'text')) {
          const end = target.value.length;
          target.setSelectionRange(end, end);
        }
        return;
      }
    }
    keyInputRef.current?.focus();
  }, []);

  // String 편집 textarea가 마운트되거나 타입이 String으로 바뀔 때, 초기값 길이에 맞춰
  // 높이를 한 번 맞춰준다(이후 타이핑은 onChange에서 즉시 리사이즈).
  useEffect(() => {
    if (selectedType === 'String') autoResizeStringEditor(stringInputRef.current);
  }, [selectedType]);

  useEffect(() => {
    if (mode === 'add') {
      containerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [mode]);

  // ── 유효성 검사 ──────────────────────────────────────────────────────────────

  const isDuplicate =
    keyValue.trim() !== '' &&
    keyValue.trim() !== initialKey &&
    siblingKeys.includes(keyValue.trim());

  const isObjectOrArray = selectedType === 'Object' || selectedType === 'Array';
  const isContainerEditMode = mode === 'edit' && isObjectOrArray;

  // collection/document 레벨은 key+label만 있음
  const isSimpleLevel = level === 'collection' || level === 'document';

  // add 모드 + EJSON 모드가 꺼져 있으면 BSON 확장 타입을 숨김 — edit 모드는 이미 그
  // 타입으로 저장된 필드를 만났을 수 있으므로 항상 전체 목록을 보여준다
  const availableTypes: FieldType[] = mode === 'add' && !ejsonMode ? JSON_TYPES : [...JSON_TYPES, ...EJSON_EXTRA_TYPES];

  // 파일 붙여넣기/업로드(import) UI를 보여줄지 — collection/document는 항상,
  // field는 추가(add) 모드에서만 (드롭한 파일을 새 필드 값으로 쓸 수 있게)
  const canImport = isSimpleLevel || (level === 'field' && mode === 'add');

  // container(object/array) 수정 모드에서 raw JSON 붙여넣기 검증 — 비어있으면 기존 값 유지로 간주
  const containerJsonError = isContainerEditMode && rawValue.trim() !== '' && isInvalidJson(rawValue);

  // Import 미리보기 textarea의 JSON 유효성 — 비어있으면 import 없이 그냥 제출
  const importJsonError = isImportOpen && importText.trim() !== '' && isInvalidJson(importText);

  // Decimal128/Long은 number 캐스팅으로 정밀도가 깨지면 안 되므로 텍스트 입력 + 정규식 검증
  const decimalError = selectedType === 'Decimal128' && !/^-?\d+(\.\d+)?$/.test(rawValue.trim());
  const longError = selectedType === 'Long' && !/^-?\d+$/.test(rawValue.trim());

  const canSubmit =
    keyValue.trim() !== '' &&
    !isDuplicate &&
    !isPending &&
    !containerJsonError &&
    !importJsonError &&
    !decimalError &&
    !longError &&
    !(selectedType === 'ObjectID' && objectIdMode === 'pick' && !refDocId);

  // ── Import 헬퍼 ──────────────────────────────────────────────────────────────

  // textarea의 JSON에서 name(또는 title) 값을 읽어옴 — 파싱 실패 시 null
  const extractNameFromImportJson = (text: string): string | null => {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const candidate = (parsed as Record<string, unknown>).name ?? (parsed as Record<string, unknown>).title;
        if (typeof candidate === 'string') return candidate;
      }
    } catch {
      // 파싱 실패는 textarea 쪽 에러 메시지로 표시되므로 여기선 무시
    }
    return null;
  };

  // textarea JSON 변경 → input(keyValue) 동기화. JSON에 name/title이 없으면
  // fallbackName(파일 업로드 시 파일명)으로 대신 채운다.
  const syncKeyFromImportText = (text: string, fallbackName?: string) => {
    const name = extractNameFromImportJson(text) ?? fallbackName ?? null;
    if (name !== null) setKeyValue(name);
  };

  // input(keyValue) 변경 → textarea JSON의 name(또는 title) 필드 동기화
  const syncImportTextFromKey = (newKey: string) => {
    if (importText.trim() === '') return;
    try {
      const parsed = JSON.parse(importText) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        const field = 'title' in obj && !('name' in obj) ? 'title' : 'name';
        obj[field] = newKey;
        setImportText(JSON.stringify(obj, null, 2));
      }
    } catch {
      // textarea의 JSON이 깨져 있으면 동기화하지 않음
    }
  };

  // field 레벨은 collection/document처럼 별도 import 미리보기를 쓰지 않고, 이미 있는
  // 타입 선택기의 Object 텍스트영역(rawValue)으로 바로 채워서 같은 값 입력 UI를 재사용한다
  const applyImportedText = (text: string, fallbackName?: string) => {
    if (level === 'field') {
      setSelectedType('Object');
      setRawValue(text);
      syncKeyFromImportText(text, fallbackName);
      return;
    }
    setImportText(text);
    syncKeyFromImportText(text, fallbackName);
    setIsImportOpen(true);
  };

  const handlePasteImport = async () => {
    try {
      const text = await navigator.clipboard.readText();
      applyImportedText(text);
    } catch {
      // 클립보드 읽기 실패 시에도 collection/document는 빈 미리보기를 열어 직접 입력할 수 있게 한다
      if (level !== 'field') setIsImportOpen(true);
    }
  };

  const handleImportFile = (file: File) => {
    const reader = new FileReader();
    const baseName = file.name.replace(/\.[^./]+$/, '');
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      applyImportedText(text, baseName);
    };
    reader.readAsText(file);
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleImportFile(file);
    e.target.value = '';
  };

  const handleInputDrop = (e: React.DragEvent<HTMLInputElement>) => {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleImportFile(file);
  };

  // 부모 컬럼 전체에 드롭한 파일 — 이 input의 업로드 버튼을 누른 것과 동일하게 처리
  useEffect(() => {
    if (!pendingImportFile) return;
    handleImportFile(pendingImportFile);
    onPendingImportFileConsumed?.();
  }, [pendingImportFile]);

  // ── Export 헬퍼 ──────────────────────────────────────────────────────────────

  const handleExportCopy = async () => {
    if (!onExportRequest) return;
    const json = await onExportRequest();
    await copyToClipboard(formatExport(json));
    setExportCopied(true);
    setTimeout(() => setExportCopied(false), 1500);
  };

  const handleExportDownload = async () => {
    if (!onExportRequest) return;
    const json = await onExportRequest();
    const blob = new Blob([formatExport(json)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(keyValue || initialKey || 'export').trim()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // ── 값 파싱 ──────────────────────────────────────────────────────────────────

  const parseValue = (): JsonValue => {
    if (selectedType === 'Boolean') return boolValue;
    if (selectedType === 'Null') return null;
    if (selectedType === 'Number') {
      // 원래 Double이던 필드는 "5"를 입력해도 Double로 남긴다. 새 값은 정수면 Int32, 아니면 Double.
      return parseNumberInput(rawValue, initialKind === 'double' ? 'double' : undefined) ?? makeInt32(0);
    }
    if (selectedType === 'Object') {
      try { return toCanonical(JSON.parse(rawValue)); } catch { return {}; }
    }
    if (selectedType === 'Array') {
      try { return toCanonical(JSON.parse(rawValue)); } catch { return []; }
    }
    if (selectedType === 'ObjectID') {
      return makeOid(objectIdMode === 'pick' ? refDocId : generatedOid);
    }
    if (selectedType === 'Date') {
      // 손대지 않았으면 원래 값 그대로(저장 형식까지 — $date의 문자열/숫자 표기)
      if (initialValue !== undefined && dateMs(initialValue) !== undefined && dateValue === initialDateInput) return initialValue;
      const ms = dateValue ? fromDateInput(dateValue, dateMode, dateWithMs ? undefined : dateMs(initialValue)) : Date.now();
      return makeDate(new Date(Number.isNaN(ms) ? Date.now() : ms));
    }
    if (selectedType === 'Decimal128') return makeDecimal(rawValue);
    if (selectedType === 'Long') return makeLong(rawValue.trim());
    return rawValue;
  };

  // ── 제출 ─────────────────────────────────────────────────────────────────────

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setIsPending(true);
    try {
      await onSubmit({
        key: keyValue.trim(),
        label: isSimpleLevel ? keyValue.trim() : undefined,
        type: isSimpleLevel ? undefined : selectedType,
        value: isSimpleLevel
          ? undefined
          : isContainerEditMode
            ? (rawValue.trim() !== '' ? toCanonical(JSON.parse(rawValue)) : undefined)
            : parseValue(),
        objectIdMode: selectedType === 'ObjectID' ? objectIdMode : undefined,
        importedJson: isSimpleLevel && mode === 'add' && importText.trim() !== '' && !importJsonError
          ? (JSON.parse(importText) as JsonValue)
          : undefined,
      });
    } finally {
      setIsPending(false);
    }
  };

  return (
    <motion.div
      ref={containerRef}
      layout="position"
      initial={{ opacity: 0, y: -10, }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={SPRING_SHARP}
      className={cn(
        styles.container,
        mode === 'add' ? styles.containerAdd : styles.containerEdit,
      )}
    >
      <div className={styles.inner}>
        {/* Key 입력 */}
        <div className={styles.row}>
          <div className={styles.inputWrap}>
            <input
              ref={keyInputRef}
              type="text"
              className={cn(
                styles.input,
                isSimpleLevel && mode === 'edit' && onExportRequest
                  ? styles.inputWithThreeIcons
                  : canImport && mode === 'add' ? styles.inputWithIcons : undefined,
                isDuplicate && styles.inputError,
                isDragOver && 'ring-2 ring-emerald-400/60 bg-emerald-50/40',
              )}
              placeholder={level === 'collection' ? 'Collection name (Drop file)' : level === 'document' ? 'Document name (Drop file)' : 'Key name'}
              value={keyValue}
              disabled={mode === 'add' && lockKey}
              onChange={(e) => {
                const v = e.target.value;
                setKeyValue(v);
                if (canImport && mode === 'add') syncImportTextFromKey(v);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleSubmit();
                if (e.key === 'Escape') onCancel();
                if (canImport && mode === 'add' && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
                  e.preventDefault();
                  void handlePasteImport();
                }
              }}
              onDragOver={canImport && mode === 'add' ? (e) => { e.preventDefault(); setIsDragOver(true); } : undefined}
              onDragLeave={canImport && mode === 'add' ? () => setIsDragOver(false) : undefined}
              onDrop={canImport && mode === 'add' ? handleInputDrop : undefined}
            />

            {/* Import: 붙여넣기 / 파일 업로드 — input 내부 아이콘 */}
            {canImport && mode === 'add' && (
              <div className={styles.inputIcons}>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={handleFileInputChange}
                />
                <button
                  type="button"
                  className={styles.inputIconBtn}
                  title="Paste from clipboard"
                  onClick={() => void handlePasteImport()}
                >
                  <ClipboardPaste size={16} />
                </button>
                <button
                  type="button"
                  className={styles.inputIconBtn}
                  title="Upload file"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload size={16} />
                </button>
              </div>
            )}

            {/* Export: 복사 / 다운로드 — input 내부 아이콘 */}
            {isSimpleLevel && mode === 'edit' && onExportRequest && (
              <div className={styles.inputIcons}>
                <button
                  type="button"
                  className={cn(styles.inputIconBtn, 'text-[10px] font-semibold font-mono w-7')}
                  title={exportFormat === 'canonical'
                    ? 'Format: Canonical EJSON (lossless) — click for Relaxed'
                    : 'Format: Relaxed EJSON (plain numbers/ISO dates) — click for Canonical'}
                  onClick={() => setExportFormat((f) => (f === 'canonical' ? 'relaxed' : 'canonical'))}
                >
                  {exportFormat === 'canonical' ? 'CAN' : 'REL'}
                </button>
                <button
                  type="button"
                  className={styles.inputIconBtn}
                  title="Copy JSON"
                  onClick={() => void handleExportCopy()}
                >
                  {exportCopied ? <Check size={16} className="text-emerald-500" /> : <ClipboardCopy size={16} />}
                </button>
                <button
                  type="button"
                  className={styles.inputIconBtn}
                  title="Download as file"
                  onClick={() => void handleExportDownload()}
                >
                  <Download size={16} />
                </button>
              </div>
            )}
          </div>

          {/* 액션 버튼 */}
          <div className={styles.actions}>
            {onDuplicate && (
              <button type="button" className={cn(styles.actionBtn, styles.cancelBtn)} title="Duplicate" onClick={onDuplicate}>
                <CopyPlus size={16} />
              </button>
            )}
            {onDelete && (
              <button type="button" className={cn(styles.actionBtn, styles.deleteBtn)} onClick={onDelete}>
                <Trash2 size={16} />
              </button>
            )}
            <button
              type="button"
              className={cn(styles.actionBtn, styles.submitBtn)}
              onClick={() => void handleSubmit()}
              disabled={!canSubmit}
            >
              <Check size={16} />
            </button>
            <button type="button" className={cn(styles.actionBtn, styles.cancelBtn)} onClick={onCancel}>
              <X size={16} />
            </button>
          </div>
        </div>

        {/* 중복 에러 */}
        {isDuplicate && (
          <p className={styles.errorMsg}>This name already exists.</p>
        )}

        {/* Import 미리보기 — 붙여넣기/파일 업로드한 JSON 확인 (collection/document 전용,
            field는 아래 타입 선택기의 Object 텍스트영역을 바로 채우므로 별도 미리보기가 없음) */}
        {isSimpleLevel && mode === 'add' && (
          <AnimatePresence>
            {isImportOpen && (
              <motion.div
                initial={{ opacity: 0, y: -10, }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={SPRING_SHARP}
                className="overflow-hidden"
              >
                <div className="flex flex-col gap-1">
                  <textarea
                    className={cn(styles.textarea, importJsonError && styles.inputError)}
                    rows={6}
                    placeholder={level === 'collection' ? '{ "name": "...", "documents": [...] }' : '{ "_id": { "$oid": "..." }, "name": "..." }'}
                    value={importText}
                    onChange={(e) => { setImportText(e.target.value); syncKeyFromImportText(e.target.value); }}
                  />
                  {importJsonError && <p className={styles.errorMsg}>Not valid JSON.</p>}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        )}

        {/* 필드 레벨: 타입 선택기 + 값 입력 */}
        {level === 'field' &&  (
          <>
            {/* 타입 선택기 — 아래로 펼쳐지는 Accordion */}
            <div className={styles.row}>
              <button
                type="button"
                className={styles.typeBtn}
                onClick={() => setTypeAccordionOpen((v) => !v)}
              >
                {TYPE_META[selectedType].icon}
                <span>{selectedType}</span>
                <ChevronRight
                  size={12}
                  className={cn('transition-transform', typeAccordionOpen && 'rotate-90')}
                />
              </button>
            </div>

            <AnimatePresence>
              {typeAccordionOpen && (
                <motion.div
                  initial={{ opacity: 0, y: -10, }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={SPRING_SHARP}
                  className="flex flex-1 overflow-hidden"
                >
                  <div className="flex flex-wrap gap-1 pb-1">
                    {availableTypes.map((t) => (
                      <button
                        key={t}
                        type="button"
                        className={cn(styles.typeTab, selectedType === t && styles.typeTabActive)}
                        onClick={() => setSelectedType(t)}
                      >
                        {TYPE_META[t].icon}
                        <span>{t}</span>
                      </button>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* 값 입력 */}
            <div ref={valueAreaRef} className="contents">
            {selectedType === 'Boolean' ? (
              <div className={styles.row}>
                <span className="text-xs text-slate-500">Value</span>
                <button
                  type="button"
                  className={cn(
                    styles.toggle,
                    boolValue ? 'bg-emerald-500' : 'bg-slate-200',
                  )}
                  onClick={() => setBoolValue((v) => !v)}
                  role="switch"
                  aria-checked={boolValue}
                >
                  <span
                    className={cn(styles.toggleThumb, boolValue && 'translate-x-5')}
                  />
                </button>
                <span className="text-xs text-slate-500">{boolValue ? 'true' : 'false'}</span>
              </div>
            ) : selectedType === 'Null' ? (
              <div className={styles.row}>
                <span className="text-xs text-slate-400 italic">Value is null</span>
              </div>
            ) : selectedType === 'Object' || selectedType === 'Array' ? (
              <textarea
                className={styles.textarea}
                rows={4}
                placeholder={selectedType === 'Object' ? '{ "key": "value" }' : '[ "item1", "item2" ]'}
                value={rawValue}
                onChange={(e) => setRawValue(e.target.value)}
              />
            ) : selectedType === 'ObjectID' ? (
              <div className="flex flex-col gap-1.5">
                {currentRefInfo && (
                  <p className="text-[11px] text-slate-400 px-0.5">
                    Current reference: <span className="text-slate-600 font-medium">{currentRefInfo.collectionLabel}/{currentRefInfo.documentTitle}</span>
                  </p>
                )}
                <div className="flex gap-1">
                  <button
                    type="button"
                    className={cn(styles.typeTab, objectIdMode === 'generate' && styles.typeTabActive)}
                    onClick={() => setObjectIdMode('generate')}
                  >
                    <Zap size={12} />
                    Auto-generate
                  </button>
                  <button
                    type="button"
                    className={cn(styles.typeTab, objectIdMode === 'pick' && styles.typeTabActive)}
                    onClick={() => setObjectIdMode('pick')}
                  >
                    <Link size={12} />
                    Pick reference
                  </button>
                </div>
                {objectIdMode === 'generate' ? (
                  <div className="flex items-center gap-1.5">
                    <span className={styles.oidDisplay}>{generatedOid}</span>
                    <button
                      type="button"
                      className={cn(styles.actionBtn, styles.cancelBtn)}
                      onClick={() => setGeneratedOid(generateObjectId())}
                      title="Regenerate"
                    >
                      <RefreshCw size={16} />
                    </button>
                  </div>
                ) : (
                  <div className="flex gap-1.5">
                    <select
                      className={styles.valueInput}
                      value={refCollectionName}
                      onChange={(e) => { setRefCollectionName(e.target.value); setRefDocId(''); }}
                    >
                      <option value="">Select collection</option>
                      {refCollections.map((c) => (
                        <option key={c.name} value={c.name}>{c.label}</option>
                      ))}
                    </select>
                    <select
                      className={styles.valueInput}
                      value={refDocId}
                      onChange={(e) => setRefDocId(e.target.value)}
                      disabled={!refCollectionName}
                    >
                      <option value="">Select document</option>
                      {refDocs.map((d) => (
                        <option key={d.id} value={d.id}>{d.title}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            ) : selectedType === 'Date' ? (
              <div className="flex items-center gap-2">
                <input
                  type="datetime-local"
                  // 밀리초를 보일 때만 밀리초까지 입력(아니면 초까지)
                  step={dateWithMs ? '0.001' : '1'}
                  className={styles.valueInput}
                  value={dateValue}
                  onChange={(e) => setDateValue(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void handleSubmit(); if (e.key === 'Escape') onCancel(); }}
                />
                {/* 이 입력이 어느 시간대인지 — 설정 창의 Date 표시를 따른다 */}
                <span className="shrink-0 text-[11px] font-mono text-slate-400" data-tt="Time zone of this input — follows Settings › Display › Dates">
                  {dateInputZone(dateMode)}
                </span>
              </div>
            ) : selectedType === 'Decimal128' || selectedType === 'Long' ? (
              <div className="flex flex-col gap-1">
                <input
                  type="text"
                  inputMode="decimal"
                  className={cn(styles.valueInput, (selectedType === 'Decimal128' ? decimalError : longError) && styles.inputError)}
                  placeholder={selectedType === 'Decimal128' ? 'e.g. 9.99' : 'e.g. 123456789012'}
                  value={rawValue}
                  onChange={(e) => setRawValue(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void handleSubmit(); if (e.key === 'Escape') onCancel(); }}
                />
                {(selectedType === 'Decimal128' ? decimalError : longError) && (
                  <p className={styles.errorMsg}>
                    {selectedType === 'Decimal128' ? 'Must be a decimal number.' : 'Must be an integer.'}
                  </p>
                )}
              </div>
            ) : referenceFieldConfig && (selectedType === 'String' || selectedType === 'Number') ? (
              <div className="flex flex-col gap-1.5">
                <p className="text-[11px] text-slate-400 px-0.5">
                  Reference: <span className="text-cyan-600 font-medium font-mono">{referenceFieldConfig.targetCollection}.{referenceFieldConfig.targetKey}</span>
                </p>
                <div className="flex gap-1.5">
                  <input
                    type={selectedType === 'Number' ? 'number' : 'text'}
                    className={styles.valueInput}
                    placeholder="Value"
                    value={rawValue}
                    onChange={(e) => setRawValue(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void handleSubmit(); if (e.key === 'Escape') onCancel(); }}
                  />
                  {fieldRefCandidates.length > 0 && (
                    <select
                      className={styles.valueInput}
                      value=""
                      onChange={(e) => { if (e.target.value) setRawValue(e.target.value); }}
                    >
                      <option value="">Pick…</option>
                      {fieldRefCandidates.map((c, i) => (
                        <option key={i} value={displayValue(c.value)}>{c.title}</option>
                      ))}
                    </select>
                  )}
                </div>
              </div>
            ) : selectedType === 'String' ? (
              // 표시부와 동일하게 1줄 시작 → 내용 따라 최대 4줄 + 스크롤. Enter=제출,
              // Shift+Enter=줄바꿈(여러 줄 문자열 입력용), Escape=취소.
              <textarea
                ref={stringInputRef}
                rows={1}
                className={cn(styles.valueInput, 'block resize-none leading-relaxed overflow-hidden')}
                placeholder="Value"
                value={rawValue}
                onChange={(e) => { setRawValue(e.target.value); autoResizeStringEditor(e.currentTarget); }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handleSubmit(); }
                  if (e.key === 'Escape') onCancel();
                }}
              />
            ) : (
              <input
                type="number"
                className={styles.valueInput}
                placeholder="Value"
                value={rawValue}
                onChange={(e) => setRawValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleSubmit(); if (e.key === 'Escape') onCancel(); }}
              />
            )}
            </div>
          </>
        )}
      </div>
    </motion.div>
  );
}
