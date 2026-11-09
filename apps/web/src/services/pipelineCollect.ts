// 필드 메뉴의 '파이프라인에 넣기'(Collect) — 모으는 자리를 정하고, 규칙(shared collectInto)대로 그 스테이지의 초안에 쌓거나
// 바로 뒤에 새(점선, 아직 안 돌린) 스테이지를 만든다. 아무것도 실행하지 않는다 — Run이 초안과 새 스테이지를 한 번에 붙이고 돌린다.
// 모으는 자리: 편집기가 열린 스테이지 > 출력을 보고 있는 스테이지 > 원본 문서(맨 앞). 그 뒤에 아직 안 붙인 스테이지가 이어져 있으면 그 끝.
import { collectInto, describeCollectAction, formatStageText, parseStageText, type CollectAction } from '@mongolive/shared';
import { getPipelineStages, newStageId, setPipelineStages, stageLabel, type PipelineStage } from './pipelines';
import { getPipelineDrafts, requestEditorFocus, updatePipelineDrafts } from './pipelineDrafts';

export type CollectOutcome =
  // undo가 없으면 바뀐 게 없다(이미 그대로 있던 조건)
  | { ok: true; message: string; undo: (() => void) | null }
  | { ok: false; message: string };

export const collectToPipeline = (
  database: string,
  collection: string,
  selectedStageId: string | null,
  action: CollectAction,
): CollectOutcome => {
  const stages = getPipelineStages(database, collection);
  const before = getPipelineDrafts(database, collection);
  const exists = (id: string | null): id is string => !!id && stages.some((s) => s.id === id);
  const anchor = exists(before.editingId) ? before.editingId : exists(selectedStageId) ? selectedStageId : null;
  let last = anchor ? stages.findIndex((s) => s.id === anchor) : -1;
  while (stages[last + 1]?.pending) last += 1;
  const target = last >= 0 ? stages[last] : null;

  // 쌓을 수도 있는 동작이면 그 스테이지를 읽어 본다(꺼진 스테이지에는 쌓지 않는다 — 결과에 안 보이니까)
  let value = null;
  const mayMerge = action.kind === 'match' || action.kind === 'sort' || action.kind === 'project';
  if (target && target.enabled && mayMerge) {
    const parsed = parseStageText(before.drafts[target.id] ?? target.text);
    if (!parsed.ok) return { ok: false, message: `Stage ${stageLabel(stages, target.id)} has an error — fix it before adding to it` };
    value = parsed.stage;
  }

  const result = collectInto(value, action);
  const what = describeCollectAction(action);
  const undo = () => {
    setPipelineStages(database, collection, stages);
    updatePipelineDrafts(database, collection, () => ({ ...before, focus: null }));
  };
  const counted = (id: string) => (current: typeof before) => ({
    ...current,
    collected: { ...current.collected, [id]: (current.collected[id] ?? 0) + 1 },
    lastCollectedId: id,
  });

  if (result.mode === 'merge') {
    const id = target!.id;
    const label = stageLabel(stages, id);
    if (result.unchanged) return { ok: true, message: `${what} is already in ${label}`, undo: null };
    const text = formatStageText(result.stage);
    // 안 붙인 스테이지는 글자 자체를, 붙인 스테이지는 초안을 고친다(편집기에 고친 글자가 있으면 그 초안)
    if (target!.pending && !(id in before.drafts)) {
      setPipelineStages(database, collection, stages.map((s) => (s.id === id ? { ...s, text } : s)));
    } else {
      updatePipelineDrafts(database, collection, (current) => ({ ...current, drafts: { ...current.drafts, [id]: text } }));
    }
    updatePipelineDrafts(database, collection, counted(id));
    const message = result.replaced.length
      ? `Replaced the ${result.replaced.join(', ')} condition in ${label} — Run to apply`
      : `Added ${what} to ${label} — Run to apply`;
    return { ok: true, message, undo };
  }

  const stage: PipelineStage = { id: newStageId(), text: formatStageText(result.stage), enabled: true, pending: true };
  const next = [...stages.slice(0, last + 1), stage, ...stages.slice(last + 1)];
  setPipelineStages(database, collection, next);
  updatePipelineDrafts(database, collection, counted(stage.id));
  // $lookup은 결과에 붙일 이름(as)을 바로 고칠 수 있게 편집기를 열고 그 글자를 골라 둔다
  if (action.kind === 'lookup') {
    const at = stage.text.lastIndexOf(JSON.stringify(action.as));
    updatePipelineDrafts(database, collection, (current) => ({ ...current, editingId: stage.id }));
    requestEditorFocus(database, collection, stage.id, at >= 0 ? [at + 1, at + 1 + action.as.length] : null);
  }
  return { ok: true, message: `New stage ${stageLabel(next, stage.id)} — ${what} · Run to apply`, undo };
};
