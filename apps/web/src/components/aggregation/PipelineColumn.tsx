// aggregation 모드의 Pipeline 컬럼 — 스테이지 카드(순서·켜짐·개수, 연필이면 카드 아래 편집기), 또는 통 JSON.
// 카드를 누르면 그 스테이지까지 돌린 출력이 오른쪽 컬럼에(services/aggregateRuns가 받아 둔다 — 같은 스테이지는 다시 묻지 않는다).
// 파이프라인은 컬렉션마다 이 브라우저에 저장된다(services/pipelines) — 사용자 MongoDB엔 아무것도 쓰지 않는다.
// 카드의 "31 → 12"는 스테이지마다 센 개수 — 파이프라인이 바뀌면(적용·켜고 끄기·순서) 잠깐 뒤 다시 센다.
// 데이터가 바뀌어도 저절로 다시 돌리지 않는다(출력 컬럼에 '낡았을 수 있음'만) — Run이 전부 다시.
// 탐색하며 모으기: 결과 필드의 메뉴('파이프라인에 넣기')가 고친 글자(초안, +N)와 새 점선 스테이지를 쌓는다(services/pipelineCollect).
// 그동안 출력·개수는 그대로 — Run이 초안과 새 스테이지를 한 번에 붙이고 돌린다. 맨 위 'Original documents'는 원본(빈 파이프라인).
import { useEffect, useMemo, useState } from 'react';
import { Reorder } from 'framer-motion';
import { Braces, Database, Folder, List, Play, Plus, Workflow } from 'lucide-react';
import {
  parsePipelineText,
  parseStageText,
  stageName,
  summarizeStage,
  validatePipeline,
  validatePipelineStage,
  type EjsonObject,
  type NormalActivePath,
  type StageCount,
} from '../../types/explorer';
import {
  INPUT_STAGE_ID,
  isRunnable,
  newStageId,
  pipelineKey,
  pipelineText,
  prefixPipeline,
  setPipelineStages,
  stageValue,
  stagesFromValues,
  usePipelineStages,
  type PipelineStage,
} from '../../services/pipelines';
import { pendingChangeCount, requestEditorFocus, updatePipelineDrafts, usePipelineDrafts, type PipelineDrafts } from '../../services/pipelineDrafts';
import { forgetRuns, loadCounts, setPreview, useCounts } from '../../services/aggregateRuns';
import { cn } from '../../utils/cn';
import { useNavRow } from '../../utils/keyboardNav';
import { HeaderTitle } from '../dashboard/columns/HeaderTitle';
import { columnListStyles as styles } from '../dashboard/columns/columnListStyles';
import { StageCard, type StageCardCount } from './StageCard';
import { MOD, PipelineTextEditor, StageEditor } from './StageEditor';

// ── 새 스테이지 틀 — «» 안이 처음 골라지는 자리(바로 고쳐 쓰게). 그대로 둬도 돌아가는 값이다 ──
const TEMPLATES = [
  '{ $match: { «» } }',
  '{ $group: { _id: «"$field"», count: { $sum: 1 } } }',
  '{ $project: { «field»: 1 } }',
  '{ $sort: { «field»: -1 } }',
  '{ $limit: «10» }',
  '{ $skip: «10» }',
  '{ $unwind: «"$field"» }',
  '{ $lookup: { from: «"collection"», localField: "field", foreignField: "_id", as: "joined" } }',
  '{ $addFields: { «field»: 1 } }',
  '{ $set: { «field»: 1 } }',
  '{ $unset: «"field"» }',
  '{ $count: «"count"» }',
  '{ $sortByCount: «"$field"» }',
  '{ $sample: { size: «10» } }',
  '{ $replaceRoot: { newRoot: «"$field"» } }',
].map((raw) => {
  const start = raw.indexOf('«');
  const end = raw.indexOf('»') - 1;
  const text = raw.replace('«', '').replace('»', '');
  return { name: /\$\w+/.exec(raw)![0], text, range: [start, end] as [number, number] };
});

// 탭 안에서 컬렉션을 오가도 남겨 둘 것 — 보기 방식, 통 JSON의 적용 안 한 글자
// (스테이지 초안·열린 편집기는 필드 메뉴도 쓰므로 services/pipelineDrafts에)
const modeMemory = new Map<string, 'cards' | 'text'>();
const textMemory = new Map<string, string>();

const formatCount = (c: StageCount) => `${c.n.toLocaleString()}${c.capped ? '+' : ''}`;

type Checked = { ok: true; value: EjsonObject } | { ok: false; message: string; offset?: number };

const checkStage = (text: string): Checked => {
  const parsed = parseStageText(text);
  if (!parsed.ok) {
    const { message, line, column, offset } = parsed.error;
    return { ok: false, message: `${message} · line ${line}, col ${column}`, offset };
  }
  const invalid = validatePipelineStage(parsed.stage);
  if (invalid) return { ok: false, message: invalid.path ? `${invalid.message} · ${invalid.path}` : invalid.message };
  return { ok: true, value: parsed.stage };
};

// 통 JSON을 적용해도 아직 안 붙인(점선) 스테이지는 남긴다 — 원래 바로 앞에 있던 스테이지 뒤에(없어졌으면 맨 앞)
const keepPending = (next: PipelineStage[], previous: PipelineStage[]): PipelineStage[] => {
  const out = [...next];
  previous.forEach((stage, i) => {
    if (!stage.pending) return;
    const before = previous.slice(0, i).reverse().find((s) => out.some((o) => o.id === s.id));
    out.splice(before ? out.findIndex((o) => o.id === before.id) + 1 : 0, 0, stage);
  });
  return out;
};

interface PipelineColumnProps {
  path: NormalActivePath;
  // 키보드 탐색의 컬럼 번호(= 경로 번호)
  navIndex: number;
  // 출력 컬럼이 보여 주는 스테이지
  selectedStageId: string | null;
  // 출력 오른쪽에 결과 문서가 열려 있다(고른 스테이지를 다시 누르면 그걸 닫는다 — 없으면 아무것도 안 한다)
  resultOpen: boolean;
  reduceMotion: boolean;
  onSelectStage: (stageId: string) => void;
  // 고른 스테이지가 없어졌을 때 — 원본 문서로
  onClearStage: () => void;
}

export function PipelineColumn({ path, navIndex, selectedStageId, resultOpen, reduceMotion, onSelectStage, onClearStage }: PipelineColumnProps) {
  const database = path.databaseName ?? '';
  const collection = path.collectionName ?? null;
  const target = collection ? pipelineKey(database, collection) : '';
  const stages = usePipelineStages(database, collection);

  const [mode, setModeState] = useState<'cards' | 'text'>(() => modeMemory.get(target) ?? 'cards');
  const setMode = (next: 'cards' | 'text') => {
    modeMemory.set(target, next);
    setModeState(next);
    if (next === 'text') setTextFocus((n) => n + 1);
  };
  // 적용 안 한 글자(초안)·모은 횟수(+N)·열린 편집기(한 번에 하나, 고르기와 따로)·커서 요청 — 필드 메뉴도 쓰는 저장소
  const draftState = usePipelineDrafts(database, collection);
  const { drafts, collected, editingId, focus: focusRequest } = draftState;
  const updateDrafts = (update: (current: PipelineDrafts) => PipelineDrafts) => {
    if (collection) updatePipelineDrafts(database, collection, update);
  };
  const setEditingId = (id: string | null) => updateDrafts((current) => ({ ...current, editingId: id }));
  const requestFocus = (id: string, range: [number, number] | null = null) => {
    if (collection) requestEditorFocus(database, collection, id, range);
  };
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  // 끄는 동안의 순서 — 놓을 때 한 번 저장한다(끄는 중에 저장하면 개수를 계속 다시 센다)
  const [order, setOrder] = useState<string[] | null>(null);
  const [textDraft, setTextDraftState] = useState<string | null>(() => textMemory.get(target) ?? null);
  const setTextDraft = (next: string | null) => {
    if (next === null) textMemory.delete(target);
    else textMemory.set(target, next);
    setTextDraftState(next);
  };
  const [textError, setTextError] = useState<string | null>(null);
  const [textFocus, setTextFocus] = useState(0);

  // 지우기 확인은 잠깐만
  useEffect(() => {
    if (!confirmDelete) return;
    const timer = setTimeout(() => setConfirmDelete(null), 3000);
    return () => clearTimeout(timer);
  }, [confirmDelete]);

  const save = (next: PipelineStage[]) => {
    if (collection) setPipelineStages(database, collection, next);
  };
  const clearPreview = () => {
    if (collection) setPreview(database, collection, null);
  };

  // ── 스테이지별 개수 — 파이프라인이 바뀐 뒤 잠깐 기다렸다가(연달아 고칠 때 매번 세지 않게) ──
  const fullPipeline = useMemo(() => prefixPipeline(stages, stages.length - 1), [stages]);
  const fullKey = JSON.stringify(fullPipeline);
  const [countsPipeline, setCountsPipeline] = useState(fullPipeline);
  const countsKey = JSON.stringify(countsPipeline);
  useEffect(() => {
    if (fullKey === countsKey) return;
    const timer = setTimeout(() => setCountsPipeline(fullPipeline), 350);
    return () => clearTimeout(timer);
  }, [fullKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // 빈 파이프라인도 센다 — 맨 위 'Original documents'의 개수(counts[0])
  const counts = useCounts(database, collection ?? '', collection && countsPipeline ? countsPipeline : null);
  useEffect(() => {
    if (!collection || !countsPipeline || counts) return;
    loadCounts(database, collection, countsPipeline);
  }, [database, collection, countsKey, counts]); // eslint-disable-line react-hooks/exhaustive-deps

  const cardCounts = useMemo(() => {
    const out: Record<string, StageCardCount> = {};
    const settled = countsKey === fullKey;
    const data = settled && counts?.status === 'done' ? counts.data : null;
    const counting = !settled || counts?.status === 'loading';
    let j = 0;
    for (const stage of stages) {
      // 꺼진 것·아직 안 붙인 것은 돌리지 않으니 세지도 않는다
      if (!isRunnable(stage)) continue;
      const c: StageCardCount = { counting };
      if (data) {
        if (data.counts[j]) c.input = formatCount(data.counts[j]);
        if (data.counts[j + 1]) c.output = formatCount(data.counts[j + 1]);
        if (data.error?.stage === j) c.error = data.error.message;
      }
      out[stage.id] = c;
      j += 1;
    }
    return out;
  }, [stages, counts, countsKey, fullKey]);
  const countsFailure = countsKey === fullKey && counts?.status === 'error' ? counts.message : null;
  const inputCount = countsKey === fullKey && counts?.status === 'done' && counts.data.counts[0] ? formatCount(counts.data.counts[0]) : null;
  const pendingIds = stages.filter((s) => s.pending).map((s) => s.id);
  const changeCount = pendingChangeCount(draftState, pendingIds);

  // ── 카드 동작 ────────────────────────────────────────────────────────────
  const selectedIndex = stages.findIndex((s) => s.id === selectedStageId);

  const select = (id: string) => {
    // 아직 안 붙인 스테이지는 출력이 없다 — 편집기를 연다
    if (stages.find((s) => s.id === id)?.pending) return edit(id);
    // 이미 고른 스테이지이고 그 출력이 경로의 끝이면 아무것도 안 한다(미리보기도 그대로) — 문서 탐색과 같은 규칙
    if (id === selectedStageId && !resultOpen) return;
    setConfirmDelete(null);
    // 다른 스테이지의 미리보기는 거둔다
    clearPreview();
    onSelectStage(id);
  };
  // 편집기 열기만 — 고르지 않는다(오른쪽 출력·결과는 그대로). Preview / Apply를 하면 그 스테이지의 출력으로 간다
  const edit = (id: string) => {
    setConfirmDelete(null);
    setEditingId(id);
    requestFocus(id);
  };
  const toggleEdit = (id: string) => {
    if (editingId === id) setEditingId(null);
    else edit(id);
  };

  const setDraft = (id: string, text: string) => {
    const stage = stages.find((s) => s.id === id);
    updateDrafts((current) => {
      const nextDrafts = { ...current.drafts };
      const nextCollected = { ...current.collected };
      // 원래 글자로 돌아오면 초안이 아니다(모은 표시도 거둔다)
      if (stage && text === stage.text) {
        delete nextDrafts[id];
        delete nextCollected[id];
      } else nextDrafts[id] = text;
      return { ...current, drafts: nextDrafts, collected: nextCollected };
    });
    setErrors((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const showError = (id: string, failure: Extract<Checked, { ok: false }>) => {
    setErrors((prev) => ({ ...prev, [id]: failure.message }));
    if (failure.offset !== undefined) requestFocus(id, [failure.offset, failure.offset]);
  };

  const dropDraft = (id: string) => {
    updateDrafts((current) => {
      if (!(id in current.drafts) && !(id in current.collected)) return current;
      const nextDrafts = { ...current.drafts };
      const nextCollected = { ...current.collected };
      delete nextDrafts[id];
      delete nextCollected[id];
      return { ...current, drafts: nextDrafts, collected: nextCollected };
    });
    setErrors((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const apply = (id: string) => {
    const stage = stages.find((s) => s.id === id);
    if (!stage) return;
    const text = drafts[id] ?? stage.text;
    const checked = checkStage(text);
    if (!checked.ok) return showError(id, checked);
    // 아직 안 붙인 스테이지면 이걸로 붙인다(pending을 뗀다)
    save(stages.map((s) => (s.id === id ? { id: s.id, text: text.trim(), enabled: s.enabled } : s)));
    dropDraft(id);
    clearPreview();
    // 적용하면 닫는다(필드 편집기의 ✓처럼) — 새 출력으로(열려 있던 결과 문서는 닫힌다)
    if (editingId === id) setEditingId(null);
    onSelectStage(id);
  };

  const preview = (id: string) => {
    const index = stages.findIndex((s) => s.id === id);
    if (index < 0 || !collection) return;
    const checked = checkStage(drafts[id] ?? stages[index].text);
    if (!checked.ok) return showError(id, checked);
    const before = prefixPipeline(stages, index - 1) ?? [];
    if (selectedStageId !== id) onSelectStage(id);
    setPreview(database, collection, { stageId: id, pipeline: [...before, checked.value] });
  };

  const revert = (id: string) => {
    dropDraft(id);
    clearPreview();
  };

  const move = (id: string, dir: -1 | 1) => {
    const index = stages.findIndex((s) => s.id === id);
    const to = index + dir;
    if (index < 0 || to < 0 || to >= stages.length) return;
    const next = [...stages];
    [next[index], next[to]] = [next[to], next[index]];
    save(next);
  };

  const duplicate = (id: string) => {
    const index = stages.findIndex((s) => s.id === id);
    if (index < 0) return;
    const copy: PipelineStage = { ...stages[index], id: newStageId() };
    save([...stages.slice(0, index + 1), copy, ...stages.slice(index + 1)]);
    select(copy.id);
    if (editingId === id) setEditingId(copy.id);
  };

  const remove = (id: string) => {
    // 처음 누르면 카드(와 편집기)에 'Delete?' — 한 번 더 누르면 지운다
    if (confirmDelete !== id) {
      setConfirmDelete(id);
      return;
    }
    const index = stages.findIndex((s) => s.id === id);
    const next = stages.filter((s) => s.id !== id);
    save(next);
    dropDraft(id);
    setConfirmDelete(null);
    if (editingId === id) setEditingId(null);
    clearPreview();
    if (selectedStageId === id) {
      const neighbor = next[index - 1] ?? next[index] ?? null;
      if (neighbor) onSelectStage(neighbor.id);
      else onClearStage();
    }
  };

  const toggle = (id: string) => save(stages.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)));

  const addStage = (template: (typeof TEMPLATES)[number]) => {
    const stage: PipelineStage = { id: newStageId(), text: template.text, enabled: true };
    // 고른 스테이지 바로 뒤(원본을 보고 있으면 맨 앞, 아무것도 안 골랐으면 맨 끝)
    const at = selectedStageId === INPUT_STAGE_ID ? 0 : selectedIndex >= 0 ? selectedIndex + 1 : stages.length;
    save([...stages.slice(0, at), stage, ...stages.slice(at)]);
    setShowAdd(false);
    select(stage.id);
    setEditingId(stage.id);
    requestFocus(stage.id, template.range);
  };

  const commitOrder = () => {
    if (!order) return;
    const byId = new Map(stages.map((s) => [s.id, s]));
    const next = order.map((id) => byId.get(id)).filter((s): s is PipelineStage => !!s);
    setOrder(null);
    if (next.length === stages.length && next.some((s, i) => s.id !== stages[i].id)) save(next);
  };

  // Run — 초안(고친 글자·모은 조건)과 아직 안 붙인 스테이지를 먼저 붙이고(하나라도 틀리면 그 편집기를 열고 멈춘다),
  // 받아 둔 출력·개수를 버리고 다시. 모은 게 있으면 마지막으로 모은 스테이지의 출력으로 간다. 열려 있던 결과 문서는 닫는다
  const run = () => {
    if (!collection) return;
    const next: PipelineStage[] = [];
    for (const stage of stages) {
      const draft = drafts[stage.id];
      if (draft === undefined && !stage.pending) {
        next.push(stage);
        continue;
      }
      const text = draft ?? stage.text;
      const checked = checkStage(text);
      if (!checked.ok) {
        setEditingId(stage.id);
        showError(stage.id, checked);
        return;
      }
      next.push({ id: stage.id, text: text.trim(), enabled: stage.enabled });
    }
    const changed = next.some((s, i) => s !== stages[i]);
    if (changed) save(next);
    const lastCollected = draftState.lastCollectedId;
    updateDrafts((current) => ({ ...current, drafts: {}, collected: {}, lastCollectedId: null, editingId: changed ? null : current.editingId }));
    setErrors({});
    clearPreview();
    forgetRuns(database, collection);
    setCountsPipeline(prefixPipeline(next, next.length - 1));
    const show = [lastCollected, selectedStageId].find((id) => id === INPUT_STAGE_ID || next.some((s) => s.id === id));
    onSelectStage(show ?? next[next.length - 1]?.id ?? INPUT_STAGE_ID);
  };

  // ── 통 JSON 모드 ────────────────────────────────────────────────────────
  // 통 JSON은 붙인 스테이지만 — 아직 안 붙인 것·초안은 카드에 있고 Run이 붙인다
  const appliedStages = useMemo(() => stages.filter((s) => !s.pending), [stages]);
  const savedText = useMemo(() => pipelineText(appliedStages), [appliedStages]);
  const text = textDraft ?? savedText;
  const offCount = appliedStages.filter((s) => !s.enabled).length;

  const checkText = (): { ok: true; next: PipelineStage[] } | { ok: false } => {
    const parsed = parsePipelineText(text);
    if (!parsed.ok) {
      const { message, line, column } = parsed.error;
      setTextError(`${message} · line ${line}, col ${column}`);
      return { ok: false };
    }
    const invalid = validatePipeline(parsed.pipeline);
    if (invalid) {
      const [first, ...rest] = invalid.path.split('.');
      const at = /^\d+$/.test(first) ? `Stage ${Number(first) + 1}${rest.length ? ` · ${rest.join('.')}` : ''}` : invalid.path;
      setTextError(at ? `${invalid.message} · ${at}` : invalid.message);
      return { ok: false };
    }
    return { ok: true, next: keepPending(stagesFromValues(parsed.pipeline, appliedStages), stages) };
  };

  const applyText = () => {
    const checked = checkText();
    if (!checked.ok) return;
    save(checked.next);
    setTextDraft(null);
    setTextError(null);
    clearPreview();
    const runnable = checked.next.filter((s) => !s.pending);
    if (selectedStageId === INPUT_STAGE_ID) return;
    const keep = runnable.find((s) => s.id === selectedStageId) ?? runnable[runnable.length - 1];
    if (keep) onSelectStage(keep.id);
    else onClearStage();
  };

  const previewText = () => {
    const checked = checkText();
    if (!checked.ok || !collection) return;
    const pipeline = checked.next.filter(isRunnable).map(stageValue).filter((v): v is EjsonObject => !!v);
    // 출력 컬럼이 없으면 열어 둔다('*' = 통 JSON 미리보기)
    if (!selectedStageId) onSelectStage(stages[stages.length - 1]?.id ?? '*');
    setPreview(database, collection, { stageId: '*', pipeline });
  };

  // ── 렌더 ────────────────────────────────────────────────────────────────
  const ids = order ?? stages.map((s) => s.id);
  const byId = new Map(stages.map((s) => [s.id, s]));

  return (
    <div data-nav-col={navIndex} className={styles.container}>
      {/* 헤더 — 제목·스테이지 수 / 카드⇄글자 / Run */}
      <div className={styles.header}>
        <Workflow size={15} className={cn(styles.headerIcon, 'shrink-0')} />
        <HeaderTitle title="Pipeline" total={stages.length} />
        {collection && (
          <>
            <div className="flex shrink-0 items-center rounded-lg bg-slate-100 p-0.5" role="group" aria-label="Pipeline view">
              <button
                type="button"
                aria-pressed={mode === 'cards'}
                aria-label="Edit as stage cards"
                data-tt="Stage cards"
                className={cn('rounded-md p-1 transition-colors', mode === 'cards' ? 'bg-white text-slate-700 shadow-sm' : 'text-slate-400 hover:text-slate-600')}
                onClick={() => setMode('cards')}
              >
                <List size={13} />
              </button>
              <button
                type="button"
                aria-pressed={mode === 'text'}
                aria-label="Edit as text"
                data-tt="Whole pipeline as text"
                className={cn('rounded-md p-1 transition-colors', mode === 'text' ? 'bg-white text-slate-700 shadow-sm' : 'text-slate-400 hover:text-slate-600')}
                onClick={() => setMode('text')}
              >
                <Braces size={13} />
              </button>
            </div>
            {/* Run — 모은 것·고친 것이 있으면 그 수(붙이고 돌린다) */}
            <button
              type="button"
              className="flex shrink-0 items-center gap-1 rounded-lg bg-emerald-500 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-emerald-600"
              data-tt={changeCount
                ? `Apply ${changeCount} change${changeCount > 1 ? 's' : ''} and run`
                : 'Run again — recount every stage and refresh the output'}
              onClick={run}
            >
              <Play size={11} className="fill-current" />
              Run
              {changeCount > 0 && (
                <span className="ml-0.5 rounded-md bg-white/25 px-1 font-mono text-[10px] font-semibold tabular-nums">{changeCount}</span>
              )}
            </button>
          </>
        )}
      </div>

      {!collection ? (
        <div className={styles.empty}>
          <Folder size={28} className="opacity-30" />
          <span>Pick a collection on the left</span>
          <span className="text-xs text-slate-300">its pipeline opens here</span>
        </div>
      ) : mode === 'text' ? (
        <PipelineTextEditor
          text={text}
          dirty={textDraft !== null}
          error={textError}
          focusSignal={textFocus}
          hint={changeCount
            ? `${changeCount} change${changeCount > 1 ? 's' : ''} on the cards ${changeCount > 1 ? 'are' : 'is'} not in this text — Run applies them`
            : offCount ? `${offCount} stage${offCount > 1 ? 's are' : ' is'} off — kept off if unchanged` : `${MOD}+Enter to apply`}
          onChange={(next) => {
            setTextDraft(next === savedText ? null : next);
            setTextError(null);
          }}
          onApply={applyText}
          onPreview={previewText}
          onRevert={() => {
            setTextDraft(null);
            setTextError(null);
            clearPreview();
          }}
        />
      ) : (
        <>
          <div className={styles.list}>
            {countsFailure && (
              <p className="mx-2 mb-1 rounded-lg bg-rose-50 px-2.5 py-1.5 text-xs text-rose-600" role="alert">
                Couldn’t count: {countsFailure}
              </p>
            )}
            {/* 맨 위 — 원본 문서(파이프라인 앞, 컬렉션 그대로). 여기서도 필드 메뉴로 모아 시작할 수 있다 */}
            <OriginalRow selected={selectedStageId === INPUT_STAGE_ID} count={inputCount} onSelect={() => select(INPUT_STAGE_ID)} />
            <Reorder.Group as="div" axis="y" values={ids} onReorder={setOrder} className="flex flex-col gap-0.5">
              {ids.map((id) => {
                const stage = byId.get(id);
                if (!stage) return null;
                const index = stages.indexOf(stage);
                const value = stageValue(stage);
                return (
                  <StageCard
                    key={id}
                    id={id}
                    index={index}
                    name={value ? stageName(value) : 'stage'}
                    summary={value ? summarizeStage(value) : stage.text}
                    enabled={stage.enabled}
                    selected={id === selectedStageId}
                    edited={id in drafts}
                    editing={id === editingId}
                    editor={id === editingId && (
                      <StageEditor
                        key="editor"
                        text={drafts[id] ?? stage.text}
                        dirty={id in drafts}
                        error={errors[id] ?? null}
                        focusSignal={focusRequest?.id === id ? focusRequest.seq : 0}
                        selectRange={focusRequest?.id === id ? focusRequest.range : null}
                        onFocused={() => updateDrafts((current) => ({ ...current, focus: null }))}
                        canMoveUp={index > 0}
                        canMoveDown={index < stages.length - 1}
                        confirmingDelete={confirmDelete === id}
                        onChange={(next) => setDraft(id, next)}
                        onApply={() => apply(id)}
                        onPreview={() => preview(id)}
                        onRevert={() => revert(id)}
                        onClose={() => setEditingId(null)}
                        onMove={(dir) => move(id, dir)}
                        onDuplicate={() => duplicate(id)}
                        onDelete={() => remove(id)}
                      />
                    )}
                    confirmingDelete={confirmDelete === id}
                    pending={!!stage.pending}
                    collectedCount={collected[id] ?? 0}
                    count={cardCounts[id] ?? null}
                    reduceMotion={reduceMotion}
                    onSelect={() => select(id)}
                    onEdit={() => edit(id)}
                    onToggleEdit={() => toggleEdit(id)}
                    onRemove={() => remove(id)}
                    onToggle={() => toggle(id)}
                    onDragEnd={commitOrder}
                  />
                );
              })}
            </Reorder.Group>

            {/* 스테이지 추가 — 누르면 자주 쓰는 스테이지 틀. 고른 스테이지 바로 뒤에(없으면 맨 끝) 넣는다 */}
            <button
              type="button"
              aria-expanded={showAdd}
              className="mt-1 flex items-center justify-center gap-1.5 rounded-2xl border border-dashed border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-400 transition-colors hover:border-emerald-300 hover:text-emerald-600"
              onClick={() => setShowAdd((v) => !v)}
            >
              <Plus size={14} />
              Add Stage
            </button>
            {showAdd && (
              <div className="mt-1.5 flex flex-wrap gap-1 px-1" role="menu" aria-label="Stage to add">
                {TEMPLATES.map((template) => (
                  <button
                    key={template.name}
                    type="button"
                    role="menuitem"
                    className="rounded-lg bg-slate-100 px-2 py-1 font-mono text-xs text-slate-600 transition-colors hover:bg-emerald-50 hover:text-emerald-700"
                    data-tt={template.text}
                    onClick={() => addStage(template)}
                  >
                    {template.name}
                  </button>
                ))}
              </div>
            )}
            {stages.length === 0 && !showAdd && (
              <p className="px-4 pt-6 text-center text-xs leading-relaxed text-slate-400">
                No stages yet — add one, collect from a field’s menu while exploring, or switch to <Braces size={11} className="inline" /> to paste a whole pipeline
              </p>
            )}
          </div>

        </>
      )}
    </div>
  );
}

// 맨 위 '원본 문서' 줄 — 누르면 출력 컬럼이 컬렉션 그대로(빈 파이프라인). 선택 표시는 스테이지 카드와 같다
function OriginalRow({ selected, count, onSelect }: { selected: boolean; count: string | null; onSelect: () => void }) {
  const navRef = useNavRow({ open: onSelect });
  return (
    <div
      ref={navRef}
      data-nav-row=""
      data-nav-active={selected ? '' : undefined}
      className={cn(
        'relative mb-0.5 flex cursor-pointer select-none items-center gap-3 rounded-2xl py-2.5 pl-4 pr-3 transition-colors',
        selected ? 'bg-selected' : 'hover:bg-slate-50/80 active:bg-slate-100/50',
      )}
      data-tt="The collection as it is — before any stage"
      onClick={onSelect}
    >
      {selected && <span className="absolute inset-y-0 left-1.5 my-auto h-8 w-1 rounded-full bg-emerald-500" />}
      <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-xl', selected ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500')}>
        <Database size={15} />
      </span>
      <div className="min-w-0 flex-1">
        <p className={cn('truncate text-sm font-semibold', selected ? 'text-emerald-700' : 'text-slate-700')}>Original documents</p>
        <p className={cn('mt-0.5 truncate font-mono text-[11px] tabular-nums', selected ? 'text-emerald-600' : 'text-slate-400')}>
          {count ? `${count} ${count === '1' ? 'doc' : 'docs'}` : 'before any stage'}
        </p>
      </div>
    </div>
  );
}
