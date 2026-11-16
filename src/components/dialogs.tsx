"use client";

// Promise-based confirm / prompt dialogs built on the accessible Modal, so no
// screen needs window.confirm or window.prompt (unstyled, blocking, and
// unusable in some mobile WebViews):
//
//   const dialogs = useDialogs();
//   if (!(await dialogs.confirm({ title: "Delete index.html?" }))) return;
//   const path = await dialogs.prompt({ title: "New file", label: "Path" });
//   …
//   return <>{…}{dialogs.element}</>;

import { useCallback, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Modal } from "@/components/modal";
import { cn } from "@/lib/utils";

export type ConfirmOptions = { title: string; body?: string; confirmLabel?: string; tone?: "danger" | "primary" };
export type PromptOptions = {
  title: string;
  label: string;
  initial?: string;
  placeholder?: string;
  hint?: string;
  confirmLabel?: string;
  /** Explains what entering the value does, above the field. */
  body?: string;
  /** `password` hides the value and lets a password manager fill it. */
  inputType?: "text" | "password";
  /** `danger` when confirming the value does something irreversible. */
  tone?: "danger" | "primary";
};

type DialogState = ({ kind: "confirm" } & ConfirmOptions) | ({ kind: "prompt" } & PromptOptions) | null;

export function useDialogs(): {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  prompt: (options: PromptOptions) => Promise<string | null>;
  element: ReactNode;
} {
  const [state, setState] = useState<DialogState>(null);
  const [value, setValue] = useState("");
  const resolver = useRef<((result: boolean | string | null) => void) | null>(null);

  const settle = useCallback((result: boolean | string | null) => {
    const resolve = resolver.current;
    resolver.current = null;
    setState(null);
    resolve?.(result);
  }, []);

  const confirm = useCallback((options: ConfirmOptions) => new Promise<boolean>((resolve) => {
    resolver.current?.(false);
    resolver.current = (result) => resolve(result === true);
    setState({ kind: "confirm", ...options });
  }), []);

  const prompt = useCallback((options: PromptOptions) => new Promise<string | null>((resolve) => {
    resolver.current?.(null);
    resolver.current = (result) => resolve(typeof result === "string" ? result : null);
    setValue(options.initial ?? "");
    setState({ kind: "prompt", ...options });
  }), []);

  let element: ReactNode = null;
  if (state?.kind === "confirm") {
    element = (
      <Modal
        open
        onClose={() => settle(false)}
        title={state.title}
        size="sm"
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className="btn btn-outline" onClick={() => settle(false)}>Cancel</button>
            <button type="button" className={cn("btn", state.tone === "primary" ? "btn-primary" : "btn-danger")} onClick={() => settle(true)}>
              {state.confirmLabel ?? "Confirm"}
            </button>
          </div>
        }
      >
        <p className="text-sm leading-relaxed text-ink-2">{state.body ?? "This can't be undone."}</p>
      </Modal>
    );
  } else if (state?.kind === "prompt") {
    const secret = state.inputType === "password";
    const submit = (event: FormEvent) => {
      event.preventDefault();
      // A password is sent exactly as typed; anything else is trimmed.
      const next = secret ? value : value.trim();
      if (next) settle(next);
    };
    element = (
      <Modal open onClose={() => settle(null)} title={state.title} size="sm">
        <form onSubmit={submit} className="space-y-4">
          {state.body ? <p className="text-sm leading-relaxed text-ink-2">{state.body}</p> : null}
          <label className="block">
            <span className="mb-1.5 block text-[13px] font-medium text-ink-2">{state.label}</span>
            <input
              type={secret ? "password" : "text"}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={state.placeholder}
              autoComplete={secret ? "current-password" : "off"}
              autoCapitalize="off"
              spellCheck={false}
              data-autofocus
              className={cn("input-base w-full", !secret && "font-mono text-[13px]")}
            />
            {state.hint ? <span className="mt-1.5 block text-xs text-ink-3">{state.hint}</span> : null}
          </label>
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className="btn btn-outline" onClick={() => settle(null)}>Cancel</button>
            <button type="submit" className={cn("btn", state.tone === "danger" ? "btn-danger" : "btn-primary")} disabled={!(secret ? value : value.trim())}>{state.confirmLabel ?? "Create"}</button>
          </div>
        </form>
      </Modal>
    );
  }

  return { confirm, prompt, element };
}
