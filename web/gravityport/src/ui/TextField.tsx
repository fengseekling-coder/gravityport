import { useId, type InputHTMLAttributes, type Ref } from "react"
import Text from "./Text"

type Props = InputHTMLAttributes<HTMLInputElement> & {
  label: string
  hint?: string
  error?: string
  ref?: Ref<HTMLInputElement>
}

export default function TextField({
  label,
  hint,
  error,
  id,
  className = "",
  ref,
  ...props
}: Props) {
  const generatedId = useId()
  const inputId = id || generatedId
  const message = error || hint
  const description = [
    props["aria-describedby"],
    message ? `${inputId}-message` : "",
  ]
    .filter(Boolean)
    .join(" ")
  return (
    <div className={`ui-field ${className}`}>
      <label className="ui-field-label" htmlFor={inputId}>
        {label}
      </label>
      <input
        {...props}
        ref={ref}
        id={inputId}
        className="ui-field-input"
        aria-invalid={error ? true : props["aria-invalid"]}
        aria-describedby={description || undefined}
      />
      {message && (
        <Text
          as="p"
          id={`${inputId}-message`}
          tone="secondary"
          className={error ? "ui-field-error" : ""}
          role={error ? "alert" : undefined}
        >
          {message}
        </Text>
      )}
    </div>
  )
}
