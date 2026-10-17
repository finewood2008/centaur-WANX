// Only upload progress is needed by the quick panel; never send local paths,
// download destinations, credentials or the rest of the storage overview.
export function panelSpaceState(state) {
  return {
    phase: state.phase, scope: state.scope, accountId: state.accountId, boxId: state.boxId, error: state.error,
    storageError: state.storageError,
    tasks: (state.tasks || []).filter(task => task.direction === "upload").map(task => ({
      id: task.id, name: task.name, size: task.size, offset: task.offset,
      phase: task.phase, error: task.error,
    })),
  };
}
