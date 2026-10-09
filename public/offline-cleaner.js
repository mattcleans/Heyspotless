import {
  listWork,
  readWorkPhotos,
  saveWorkPhoto,
  workIsFresh,
} from "/offline-work.js";

const visits = document.getElementById("visits");
const message = document.getElementById("message");
const error = document.getElementById("error");
const camera = document.getElementById("camera");
const online = document.getElementById("online");
const requestedJob = /^\/cleaner\/job\/([0-9a-f-]{36})\/?$/.exec(
  location.pathname,
)?.[1];
let pending = null;
let saving = false;
let rendering = 0;
function report(text) {
  error.textContent = text;
  error.classList.toggle("hidden", !text);
}
function element(tag, text) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  return node;
}
function date(value) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

async function render() {
  const version = ++rendering;
  try {
    const saved = await listWork();
    const selected = requestedJob
      ? saved.filter((w) => w.jobId === requestedJob)
      : saved;
    const prepared = await Promise.all(
      selected.map(async (work) => ({
        work,
        photos: await readWorkPhotos(work.jobId, work.ownerId),
      })),
    );
    if (version !== rendering) return;
    visits.replaceChildren();
    online.href = requestedJob
      ? `/cleaner/job/${requestedJob}`
      : location.pathname === "/"
        ? "/"
        : "/cleaner";
    message.textContent = selected.length
      ? "Use this checklist only for work you already started."
      : "No checklist is saved here. Reconnect to open your account or assigned visit. Saved photos remain on this phone.";
    for (const { work, photos } of prepared) {
      const section = element("section");
      section.append(
        element(
          "h2",
          work.scheduledAt
            ? `Visit on ${date(work.scheduledAt)}`
            : "Previously opened visit",
        ),
      );
      section.append(
        element("small", `Last checked ${date(work.checkedAt)} Dallas time`),
      );
      const fresh = workIsFresh(work);
      const canCapture = fresh && work.status === "in_progress";
      if (!fresh)
        section.append(
          element(
            "p",
            "This checklist is more than a day old. Reopen the visit online before taking more photos.",
          ),
        );
      else if (work.status === "complete")
        section.append(
          element(
            "p",
            "The server previously confirmed this visit finished. Reopen online to upload any remaining photos.",
          ),
        );
      const taken = new Set(
        [...work.confirmed, ...photos].map((p) => `${p.roomKey}:${p.kind}`),
      );
      const rooms = element("ul");
      rooms.className = "rooms";
      for (const room of work.rooms) {
        const row = element("li");
        row.append(element("span", room.label));
        const pair = element("span");
        pair.className = "pair";
        for (const kind of ["before", "after"]) {
          const exists = taken.has(`${room.key}:${kind}`);
          const button = element(
            "button",
            `${kind === "before" ? "Before" : "After"}${exists ? " ✓" : ""}`,
          );
          button.type = "button";
          button.classList.toggle("saved", exists);
          button.disabled = saving || !canCapture;
          button.setAttribute(
            "aria-label",
            `${exists ? "Retake" : "Take"} ${kind} photo for ${room.label}`,
          );
          button.addEventListener("click", () => {
            pending = { work, roomKey: room.key, kind };
            report("");
            camera.click();
          });
          pair.append(button);
        }
        row.append(pair);
        rooms.append(row);
      }
      section.append(rooms);
      const waiting = photos.filter((p) => p.state !== "done").length;
      section.append(
        element(
          "p",
          waiting
            ? `${waiting} photo${waiting === 1 ? "" : "s"} saved on this phone, waiting to upload. A check means saved here or previously confirmed online.`
            : "A check means previously confirmed online. New photos stay on this phone until your live visit confirms upload.",
        ),
      );
      const link = element("a", "Open this visit online");
      link.href = `/cleaner/job/${work.jobId}`;
      link.className = "action secondary";
      section.append(link);
      visits.append(section);
    }
  } catch {
    report(
      "Saved work could not be opened. Keep this phone’s data and reconnect. Call the office if you cannot reopen the visit.",
    );
  }
}

async function compress(file) {
  try {
    const image = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(image.width, image.height));
    if (scale === 1) {
      image.close();
      return file;
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(image.width * scale);
    canvas.height = Math.round(image.height * scale);
    const context = canvas.getContext("2d");
    if (!context) {
      image.close();
      return file;
    }
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    image.close();
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.8),
    );
    return blob && blob.size < file.size ? blob : file;
  } catch {
    return file;
  }
}

camera.addEventListener("change", async () => {
  const target = pending;
  pending = null;
  const file = camera.files?.[0];
  camera.value = "";
  if (!target || !file) return;
  saving = true;
  message.textContent = "Saving photo on this phone…";
  await render();
  try {
    await saveWorkPhoto(
      target.work.jobId,
      target.work.ownerId,
      target.roomKey,
      target.kind,
      await compress(file),
    );
    report("");
  } catch (failure) {
    report(
      failure?.name === "QuotaExceededError"
        ? "This photo was not saved. Make space without clearing Spotless data, then retake it. Call the office if you need help."
        : `This photo was not saved. ${failure instanceof Error ? failure.message : "Reconnect and try again."}`,
    );
  } finally {
    saving = false;
    await render();
  }
});
window.addEventListener("online", () => {
  message.textContent =
    "A connection may be available. Open your live visit to check it and resume uploads.";
});
if (typeof BroadcastChannel !== "undefined") {
  const channel = new BroadcastChannel("spotless-work");
  channel.addEventListener("message", () => void render());
}
void render();
