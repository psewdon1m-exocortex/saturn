export type StorageHistoryNavigation = {
  readonly canBack: boolean;
  readonly canForward: boolean;
  readonly onBack: () => void;
  readonly onForward: () => void;
};

export function StorageNewNavigation({ canBack, canForward, onBack, onForward, canUp, onUp, busy }: StorageHistoryNavigation & {
  readonly canUp: boolean;
  readonly onUp: () => void;
  readonly busy: boolean;
}) {
  return <div className="storage-new-navigation" role="group" aria-label="Folder navigation">
    <button type="button" aria-label="Back" title="Back" disabled={busy || !canBack} onClick={onBack}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M18 10H2m6-6-6 6 6 6" /></svg></button>
    <button type="button" aria-label="Forward" title="Forward" disabled={busy || !canForward} onClick={onForward}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2 10h16m-6-6 6 6-6 6" /></svg></button>
    <button type="button" aria-label="Up one level" title="Up one level" disabled={busy || !canUp} onClick={onUp}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 18V2m-6 6 6-6 6 6" /></svg></button>
  </div>;
}
