export interface SavedWork {
  jobId: string;
  ownerId: string;
  status: "in_progress" | "complete";
  checkedAt: number;
  scheduledAt: string | null;
  rooms: { key: string; label: string }[];
  confirmed: { roomKey: string; kind: string; revision?: string; supersedes?: string[] }[];
}
export const MAX_WORK_AGE: number;
export function openPhotoDatabase(): Promise<IDBDatabase>;
export function setWorkOwner(ownerId: string | null): Promise<void>;
export function safeWork(value: unknown): SavedWork | null;
export function workIsFresh(work: SavedWork, now?: number): boolean;
export function saveWork(work: SavedWork): Promise<boolean>;
export function removeWork(
  jobId: string,
  ownerId: string,
  checkedAt?: number,
): Promise<boolean>;
export function listWork(): Promise<SavedWork[]>;
export function readWorkPhotos(
  jobId: string,
  ownerId: string,
): Promise<import("../src/lib/offline/photo-store").StoredPhoto[]>;
export function saveWorkPhoto(
  jobId: string,
  ownerId: string,
  roomKey: string,
  kind: "before" | "after",
  blob: Blob,
): Promise<import("../src/lib/offline/photo-store").StoredPhoto>;
export function markWorkPhotoConfirmed(
  tx: IDBTransaction,
  photo: { jobId: string; roomKey: string; kind: string; revision?: string; supersedes?: string[] },
): void;

export function photoReplacements(
  photo: { roomKey: string; kind: string; revision?: string; supersedes?: string[] },
  previous?: import("../src/lib/offline/queue-policy").QueueItem,
  confirmed?: SavedWork["confirmed"],
): string[];

export class RetakeHistoryFull extends Error {}
