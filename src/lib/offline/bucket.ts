/**
 * The storage bucket job photos live in.
 *
 * Named in one place because both the browser upload and the migration that
 * creates the bucket have to agree, and a typo between them is a silent 404 on
 * every photo a cleaner takes.
 */
export const PHOTO_BUCKET = "job-photos";
