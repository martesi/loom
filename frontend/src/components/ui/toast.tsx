import { Toast } from '@base-ui-components/react/toast'
import { cn } from '../../lib/utils'

export const ToastProvider = Toast.Provider
export const useToast = Toast.useToastManager

export function Toaster() {
  return (
    <Toast.Portal>
      <Toast.Viewport className="fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
        <ToastList />
      </Toast.Viewport>
    </Toast.Portal>
  )
}

function ToastList() {
  const { toasts } = useToast()
  return toasts.map((toast) => (
    <Toast.Root
      key={toast.id}
      toast={toast}
      className={cn(
        'rounded-md border border-black/10 bg-ink px-3.5 py-3 text-white shadow-lg',
        'data-[type=danger]:border-danger/40'
      )}
    >
      <Toast.Title className="text-[12.5px] font-semibold" />
      <Toast.Description className="mt-0.5 text-[11.5px] text-white/70" />
    </Toast.Root>
  ))
}
