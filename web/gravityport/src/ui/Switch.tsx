import Button from "./Button"

type Props = {
  label: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
}

export default function Switch({
  label,
  checked,
  onCheckedChange,
  disabled,
}: Props) {
  return (
    <Button
      variant="quiet"
      className="ui-switch"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
    >
      <span className="ui-switch-thumb" />
    </Button>
  )
}
