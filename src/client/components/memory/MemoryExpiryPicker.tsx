import { useState } from "react"
import { Check, ChevronDown, Clock3 } from "lucide-react"
import { getLocale, t, useI18n } from "../../i18n"
import { localDateValue, localEndOfDay, relativeExpiry } from "../../lib/memoryExpiry"
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover"
import { Button } from "../ui/button"

export function MemoryExpiryPicker({ value, onChange, disabled, label }: { value?: string | null; onChange: (value: string | null) => void; disabled?: boolean; label?: string }) {
  useI18n()
  const [open, setOpen] = useState(false)
  const [custom, setCustom] = useState(false)
  const [date, setDate] = useState("")
  const parsed = localEndOfDay(date)
  const valid = Boolean(parsed && Date.parse(parsed) > Date.now())
  const title = value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString(getLocale()) : t("memory:forever")
  const selectedDate = value && Number.isFinite(Date.parse(value)) ? localDateValue(new Date(value)) : null
  const options = [
    { text: t("memory:forever"), days: null, selected: !value },
    ...[0, 7, 30].map(days => {
      const next = relativeExpiry(days)
      return { text: t(days === 0 ? "memory:endOfToday" : days === 7 ? "memory:sevenDays" : "memory:thirtyDays"), days, selected: selectedDate === localDateValue(new Date(next)) }
    }),
  ]
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <button type="button" disabled={disabled} className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted disabled:opacity-40">
        <Clock3 className="h-3 w-3" /> {label ?? t("memory:keep")}: {title} <ChevronDown className="h-3 w-3" />
      </button>
    </PopoverTrigger>
    <PopoverContent align="start" className="w-56 p-1.5">
      {options.map(option => <button key={option.text} type="button" className="flex w-full items-center rounded px-2 py-1.5 text-left text-xs hover:bg-muted"
        onClick={() => { onChange(option.days === null ? null : relativeExpiry(option.days)); setCustom(false); setOpen(false) }}>
        {option.text}{option.selected ? <Check className="ml-auto h-3 w-3" /> : null}
      </button>)}
      <button type="button" className="flex w-full items-center rounded px-2 py-1.5 text-left text-xs hover:bg-muted" onClick={() => setCustom(true)}>
        {t("memory:customDate")}{value && !options.some(option => option.selected) ? <Check className="ml-auto h-3 w-3" /> : null}
      </button>
      {custom ? <div className="space-y-1.5 px-2 py-1.5">
        <label className="block text-xs text-muted-foreground" htmlFor="expiry-date">{t("memory:customDate")}</label>
        <input id="expiry-date" type="date" value={date} onChange={event => setDate(event.target.value)} className="w-full rounded border border-border bg-background px-1 py-1 text-xs" />
        {date && !valid ? <p className="text-xs text-destructive">{t("memory:expiryDateFuture")}</p> : null}
        <Button size="xs" disabled={!valid} onClick={() => { if (parsed && valid) { onChange(parsed); setCustom(false); setOpen(false) } }}>{t("memory:applyDate")}</Button>
      </div> : null}
    </PopoverContent>
  </Popover>
}
