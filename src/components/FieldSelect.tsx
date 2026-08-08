import {
  Select as ShadSelect,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

/**
 * A thin wrapper over the Radix Select.
 *
 * It takes a flat option list rather than children, because the call sites here
 * were all built around `<option>` elements and this keeps the migration
 * mechanical.
 *
 * The empty string needs care, because the two kinds of call site want opposite
 * things from it. Radix shows the placeholder when the value is `''`, and it
 * refuses to let a SelectItem carry `value=""` at all:
 *
 *  - A *filter* ("All departments") has a real, selectable empty option, so the
 *    empty string is swapped for a sentinel in both the value and that item.
 *    Without it the option could not exist and the filter could never be
 *    cleared.
 *  - A *placeholder* select ("Select a department…") has no empty option, so
 *    `''` is passed straight through and Radix renders the placeholder. Using
 *    the sentinel here would set a value matching no item, and the trigger
 *    would render blank.
 *
 * Either way the caller only ever deals in `''`.
 */
const EMPTY = '__all__'

export interface SelectOption {
  value: string
  label: string
  /** Optional group heading; consecutive options sharing one are grouped. */
  group?: string
  disabled?: boolean
}

export function FieldSelect({
  id,
  value,
  onValueChange,
  options,
  placeholder = 'Select…',
  className = '',
  disabled = false,
  'aria-describedby': describedBy,
  'aria-invalid': invalid,
}: {
  id?: string
  value: string
  onValueChange: (next: string) => void
  options: SelectOption[]
  placeholder?: string
  className?: string
  disabled?: boolean
  'aria-describedby'?: string
  'aria-invalid'?: boolean
}) {
  const hasEmptyOption = options.some((o) => o.value === '')

  // Group in encounter order so the caller controls sequence, not a sort.
  const groups: { name: string | undefined; items: SelectOption[] }[] = []
  for (const opt of options) {
    const last = groups.at(-1)
    if (last && last.name === opt.group) last.items.push(opt)
    else groups.push({ name: opt.group, items: [opt] })
  }

  return (
    <ShadSelect
      value={value === '' && hasEmptyOption ? EMPTY : value}
      onValueChange={(next) => onValueChange(next === EMPTY ? '' : next)}
      disabled={disabled}
    >
      <SelectTrigger
        id={id}
        aria-describedby={describedBy}
        aria-invalid={invalid}
        className={`w-full ${className}`}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {groups.map((g, gi) =>
          g.name ? (
            <SelectGroup key={g.name}>
              <SelectLabel>{g.name}</SelectLabel>
              {g.items.map((o) => (
                <SelectItem key={o.value} value={o.value === '' ? EMPTY : o.value} disabled={o.disabled}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectGroup>
          ) : (
            g.items.map((o) => (
              <SelectItem
                key={`${gi}-${o.value}`}
                value={o.value === '' ? EMPTY : o.value}
                disabled={o.disabled}
              >
                {o.label}
              </SelectItem>
            ))
          )
        )}
      </SelectContent>
    </ShadSelect>
  )
}
