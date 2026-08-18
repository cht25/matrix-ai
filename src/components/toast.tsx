"use client";

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

type Toast = { id: number; message: string };
const ToastCtx = createContext<(message: string) => void>(() => {});

export function useToast() {
  return useContext(ToastCtx);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);

  const push = useCallback((message: string) => {
    const id = ++idRef.current;
    setToasts((t) => [...t, { id, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2600);
  }, []);

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-20 left-1/2 z-[90] flex -translate-x-1/2 flex-col items-center gap-2 lg:bottom-6" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="card fade-in !rounded-full px-4 py-2 text-sm font-medium text-ink shadow-[var(--shadow-pop)]">
            {t.message}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
