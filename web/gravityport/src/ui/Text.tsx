import type { HTMLAttributes } from "react"

type Props = HTMLAttributes<HTMLElement> & {
  as?: "span" | "p" | "h1" | "h2" | "h3" | "h4"
  variant?: "body" | "label" | "title" | "page" | "code"
  tone?: "default" | "secondary" | "muted"
}

export default function Text({
  as: Element = "span",
  variant = "body",
  tone = "default",
  className = "",
  ...props
}: Props) {
  return (
    <Element
      {...props}
      className={`ui-text ui-text--${variant} ui-text--${tone} ${className}`}
    />
  )
}
