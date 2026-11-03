// CollectionsColumn / DocumentsColumn 공용 리스트 레이아웃 스타일
export const columnListStyles = {
  container: 'relative flex flex-col min-h-0 flex-1',
  header: 'shrink-0 flex items-center gap-2 px-4 h-11 border-b border-slate-100',
  headerIcon: 'text-slate-400',
  headerTitle: 'text-[13px] font-semibold text-slate-700 truncate flex-1',
  headerCount: 'text-xs text-slate-400 font-mono',
  list: 'flex-1 overflow-y-auto overflow-x-hidden min-h-0 p-2 flex flex-col gap-0.5',
  addCard: 'group flex items-center gap-3 px-4 py-3.5 rounded-2xl cursor-pointer hover:bg-slate-50/80 active:bg-slate-100/50 transition-colors disabled:opacity-40 disabled:cursor-default',
  addCardIcon: 'shrink-0 w-9 h-9 rounded-xl flex items-center justify-center border border-dashed border-slate-300 text-slate-400 group-hover:border-emerald-300 group-hover:text-emerald-500 transition-colors',
  addCardText: 'text-sm font-medium text-slate-400 group-hover:text-emerald-600 transition-colors',
  empty: 'flex flex-col items-center justify-center flex-1 gap-2 text-slate-400 text-sm pb-20',
} as const;
