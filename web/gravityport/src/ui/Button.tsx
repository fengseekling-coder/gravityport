import type { ButtonHTMLAttributes } from "react"

type IconOnlyProps = {
  iconOnly: true
  "aria-label": string
} | { iconOnly?: false }

type Props = ButtonHTMLAttributes<HTMLButtonElement> & IconOnlyProps & {
  variant?: "primary" | "neutral" | "quiet" | "danger"
  size?: "standard" | "small"
  loading?: boolean
}

export default function Button({
  variant = "neutral",
  size = "standard",
  loading = false,
  iconOnly,
  className = "",
  type = "button",
  disabled,
  children,
  ...props
}: Props) {
  return (
    <button
      {...props}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`ui-button ui-button--${variant} ui-button--${size} ${
        iconOnly ? "ui-button--icon" : ""
      } ${className}`}
    >
      {loading && <span className="ui-spinner" aria-hidden="true" />}
      {children}
    </button>
  )
}
