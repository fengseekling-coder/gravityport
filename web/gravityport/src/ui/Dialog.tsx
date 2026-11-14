import { useEffect, useId, useRef, type ReactNode } from "react"
import Icon from "../Icon"
import Button from "./Button"
import Text from "./Text"

type Props = {
  open: boolean
  title: string
  description?: string
  closeLabel: string
  onClose: () => void
  children: ReactNode
  actions?: ReactNode
}

export default function Dialog({
  open,
  title,
  description,
  closeLabel,
  onClose,
  children,
  actions,
}: Props) {
  const ref = useRef<HTMLDialogElement>(null)
  const id = useId()
  useEffect(() => {
    const dialog = ref.current
    if (!open || !dialog) return
    const previous = document.activeElement as HTMLElement | null
    dialog.showModal()
    const input = dialog.querySelector<HTMLInputElement>("input[type='text'], input:not([type])")
    if (input) {
      input.focus()
      input.select()
    }
    return () => {
      dialog.close()
      if (previous?.isConnected) previous.focus()
    }
  }, [open])

  if (!open) return null
  return (
    <dialog
      ref={ref}
      className="ui-dialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={description ? `${id}-description` : undefined}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key !== "Tab") return
        const controls = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
          ),
        ).filter((element) => element.getClientRects().length > 0)
        const first = controls[0]
        const last = controls[controls.length - 1]
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last?.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first?.focus()
        }
      }}
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return
        const rect = event.currentTarget.getBoundingClientRect()
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          onClose()
      }}
    >
      <div className="ui-dialog-heading">
        <Text as="h2" variant="title" id={`${id}-title`}>
          {title}
        </Text>
        <Button
          variant="quiet"
          size="small"
          iconOnly
          aria-label={closeLabel}
          onClick={onClose}
        >
          <Icon name="close" size={12} />
        </Button>
      </div>
      {description && (
        <Text
          as="p"
          tone="secondary"
          id={`${id}-description`}
          className="ui-dialog-description"
        >
          {description}
        </Text>
      )}
      {children}
      {actions && <div className="ui-dialog-actions">{actions}</div>}
    </dialog>
  )
}
