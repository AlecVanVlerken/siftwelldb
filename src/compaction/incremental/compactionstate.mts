// @author: Alec Van Vlerken
// @date: 2026-05-06

export type RecordCursorState = {
  collection?: string;
  id?: string | number;
};

export class CompactionState {
  // Historical diagnostics, not physical continuation positions. Logical ID
  // order cannot resume tail-priority traversal. DbmsBack retains the verified
  // location heaps across maintenance calls and updates them after relocation.
  private lastRecordCursor: RecordCursorState = {};
  private lastTailScanBlock: number | undefined;

  getLastRecordCursor(): RecordCursorState {
    return { ...this.lastRecordCursor };
  }

  setLastRecordCursor(cursor: RecordCursorState): void {
    this.lastRecordCursor = { ...cursor };
  }

  getLastTailScanBlock(): number | undefined {
    return this.lastTailScanBlock;
  }

  setLastTailScanBlock(block: number | undefined): void {
    this.lastTailScanBlock = block;
  }
}
