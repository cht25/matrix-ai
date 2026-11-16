"use client";

// Share a piece of conversation text: the system share sheet where the
// browser has one (phones), the clipboard everywhere else.

export type ShareOutcome = "shared" | "copied" | "cancelled" | "failed";

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the legacy path */ }
  try {
    // Older WebViews and non-secure contexts have no async clipboard.
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

export async function shareText(text: string, title = "QORVYNA"): Promise<ShareOutcome> {
  const payload = { title, text };
  if (typeof navigator.share === "function" && (!navigator.canShare || navigator.canShare(payload))) {
    try {
      await navigator.share(payload);
      return "shared";
    } catch (error) {
      // The user closed the sheet — that is not a failure and not a copy.
      if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
    }
  }
  return (await copyText(text)) ? "copied" : "failed";
}
