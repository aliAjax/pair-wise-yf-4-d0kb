import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react'

type ToastKind = 'success' | 'error' | 'info'

interface ToastOptions {
  kind: ToastKind
  message: string
  actionLabel?: string
  onAction?: () => void
}

const ToastContext = createContext<{ showToast: (t: ToastOptions) => void } | null>(null)

const AUTO_DISMISS_MS = 8000

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastOptions | null>(null)
  const timerRef = useRef<number | undefined>(undefined)

  const showToast = useCallback((t: ToastOptions) => {
    setToast(t)
    window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => setToast(null), AUTO_DISMISS_MS)
  }, [])

  const close = useCallback(() => setToast(null), [])

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {toast && (
        <div className="fixed bottom-20 md:bottom-6 left-1/2 -translate-x-1/2 z-[60] w-[min(92vw,28rem)] animate-slide-up">
          <div
            className={`flex items-start gap-3 rounded-xl border p-3.5 shadow-2xl backdrop-blur-md ${
              toast.kind === 'error'
                ? 'border-red-400/40 bg-red-950/90 text-red-100'
                : toast.kind === 'success'
                  ? 'border-dusk-400/40 bg-teal-900/95 text-mist-100'
                  : 'border-teal-700 bg-teal-900/95 text-mist-100'
            }`}
          >
            {toast.kind === 'error' ? (
              <AlertTriangle className="mt-0.5 w-5 h-5 shrink-0 text-red-400" />
            ) : toast.kind === 'success' ? (
              <CheckCircle2 className="mt-0.5 w-5 h-5 shrink-0 text-dusk-400" />
            ) : (
              <Info className="mt-0.5 w-5 h-5 shrink-0 text-mist-400" />
            )}
            <p className="flex-1 text-sm leading-relaxed">{toast.message}</p>
            {toast.actionLabel && (
              <button
                onClick={() => {
                  toast.onAction?.()
                  close()
                }}
                className="shrink-0 rounded-lg bg-dusk-400 px-3 py-1.5 text-xs font-medium text-teal-950 transition hover:bg-dusk-300"
              >
                {toast.actionLabel}
              </button>
            )}
            <button
              onClick={close}
              className="shrink-0 text-mist-400 transition hover:text-mist-100"
              aria-label="关闭提示"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </ToastContext.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within ToastProvider')
  return ctx
}
