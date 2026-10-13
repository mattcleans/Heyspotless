export const isChoiceId = (id: unknown): id is string =>
  typeof id === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
export const choiceNote = (value: unknown): string => {
  if (typeof value !== "string" || value.length > 500)
    throw new Error("Keep your note to 500 characters.");
  return value.trim();
};
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Check your cleaner request.");
  return value as Record<string, unknown>;
};
export function parseCleanerRequest(value: unknown) {
  const b = record(value);
  if (
    !isChoiceId(b.cleanerId) ||
    !isChoiceId(b.id) ||
    (b.expectedLatest !== null && !isChoiceId(b.expectedLatest))
  )
    throw new Error("Refresh the visit and choose a cleaner.");
  return {
    cleanerId: b.cleanerId,
    id: b.id,
    note: choiceNote(b.note),
    expectedLatest: b.expectedLatest,
  };
}
export function parseBackupDecision(value: unknown) {
  const b = record(value);
  if (
    !isChoiceId(b.assignmentId) ||
    !isChoiceId(b.preferredCleanerId) ||
    !isChoiceId(b.backupCleanerId) ||
    !isChoiceId(b.id) ||
    typeof b.accept !== "boolean" ||
    (b.expectedLatest !== null && !isChoiceId(b.expectedLatest))
  )
    throw new Error("Refresh to review the current backup cleaner.");
  return {
    assignmentId: b.assignmentId,
    preferredCleanerId: b.preferredCleanerId,
    backupCleanerId: b.backupCleanerId,
    id: b.id,
    accept: b.accept,
    note: choiceNote(b.note),
    expectedLatest: b.expectedLatest,
  };
}
export function parseChoiceReview(value: unknown) {
  const b = record(value),
    note = choiceNote(b.note);
  if (typeof b.apply !== "boolean" || !note)
    throw new Error("Choose a decision and add a client-facing explanation.");
  return { apply: b.apply, note };
}

export function parseBackupRelease(value: unknown) {
  const b = record(value);
  if (
    !isChoiceId(b.assignmentId) ||
    !isChoiceId(b.preferredCleanerId) ||
    !isChoiceId(b.backupCleanerId) ||
    !isChoiceId(b.decisionId)
  )
    throw new Error("Refresh and review the current declined backup.");
  return {
    assignmentId: b.assignmentId,
    preferredCleanerId: b.preferredCleanerId,
    backupCleanerId: b.backupCleanerId,
    decisionId: b.decisionId,
  };
}
