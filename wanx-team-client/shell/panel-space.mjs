// Only upload progress is needed by the quick panel; never send local paths,
// download destinations, credentials or the rest of the storage overview.
export function panelSpaceState(state) {
  return {
    phase: state.phase, scope: state.scope, accountId: state.accountId, boxId: state.boxId, error: state.error,
    storageError: state.storageError,
    imports: (state.imports || []).map(({ id, name, phase, files, folders, completed, pending, failed, size, offset, scanComplete }) => ({ id, name, phase, files, folders, completed, pending, failed, size, offset, scanComplete })),
    tasks: (state.tasks || []).filter(task => task.direction === "upload").map(task => ({
      id: task.id, name: task.name, size: task.size, offset: task.offset,
      phase: task.phase, error: task.error, kind: task.kind, relativePath: task.relativePath, batchId: task.batchId,
    })),
  };
}
