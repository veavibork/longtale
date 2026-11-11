interface TextFieldProps {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
}

/** Text input with label. */
export default function TextField({ label, value, onChange, placeholder }: TextFieldProps) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        type="text"
        className="field-input field-input-text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  )
}
