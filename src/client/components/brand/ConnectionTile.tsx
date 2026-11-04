import { BrandTile, brandForConnection } from "./BrandIcon"
import { presetIcon } from "./preset-icons"

/** A connection's mark: its preset's, then a guess from its name, then its first letter. */
export function ConnectionTile({ connection }: { connection: { presetId?: string; id?: string; name: string } }) {
  const icon = presetIcon(connection.presetId ?? connection.id)
  const brand = icon ? null : brandForConnection(connection)
  if (!icon && brand) return <BrandTile brand={brand} />
  return (
    <BrandTile brand={null}>
      {icon ? (
        <svg
          aria-hidden="true"
          viewBox={icon.viewBox}
          fill="currentColor"
          // Static, in-repo constants (preset-icons.ts): never user or network content.
          dangerouslySetInnerHTML={{ __html: icon.markup }}
        />
      ) : (
        <span aria-hidden="true" className="text-[13px] font-semibold text-muted-foreground">{connection.name.trim().charAt(0).toUpperCase()}</span>
      )}
    </BrandTile>
  )
}
