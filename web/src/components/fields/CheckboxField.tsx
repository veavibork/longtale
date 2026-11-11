interface CheckboxFieldProps {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}

/** Checkbox with label. */
export default function CheckboxField({ label, checked, onChange }: CheckboxFieldProps) {
  return (
    <label className="field field-checkbox">
      <input
        type="checkbox"
        className="field-input field-input-checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="field-label">{label}</span>
    </label>
  )
}
