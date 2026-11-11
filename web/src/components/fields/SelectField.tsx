interface SelectOption<T extends string> {
  value: T
  label: string
}

interface SelectFieldProps<T extends string> {
  label: string
  value: T
  options: SelectOption<T>[]
  onChange: (value: T) => void
}

/** Generic select dropdown. */
export default function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
}: SelectFieldProps<T>) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <select
        className="field-input field-input-select"
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  )
}
