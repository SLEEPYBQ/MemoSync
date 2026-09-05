// MemoSync brand icon (user's Figma: "Layered Transfer Icon Recreation").
// Three full layered cards in the three memory-scope colors — green session,
// blue project, orange personal — each with an inset white keyline, and a
// white cross-context transfer glyph on the top card.
// Motion mirrors the Figma prototype's Folded ↔ Expanded card spread:
// `spread` (or hover with animated="hover") fans the cards out.
// Geometry is lifted verbatim from the Figma vector master (node 22:2).
import { cn } from "../lib/utils"

interface MemoSyncIconProps {
  className?: string
  /**
   * "hover" = fan out on hover; "loop" = slow ambient breathe (empty states);
   * "none" = static (still spreads when `spread` is set).
   */
  animated?: "hover" | "loop" | "none"
  /** Controlled expanded state (e.g. cycle it, or bind to an open/close toggle). */
  spread?: boolean
}

export function MemoSyncIcon({ className, animated = "hover", spread = false }: MemoSyncIconProps) {
  return (
    <svg
      viewBox="0 0 832 874"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      data-animated={animated}
      data-spread={spread ? "true" : "false"}
      className={cn("memosync-icon overflow-visible", className)}
    >
      <g className="msi-card msi-green">
        <rect x="82" y="83" width="447" height="510" rx="51" fill="#788C5D" />
        <rect x="89" y="90" width="433" height="496" rx="44" stroke="white" strokeWidth="14" fill="none" />
      </g>
      <g className="msi-card msi-blue">
        <rect x="205" y="186" width="456" height="511" rx="51" fill="#6A9BCC" />
        <rect x="212" y="193" width="442" height="497" rx="44" stroke="white" strokeWidth="14" fill="none" />
      </g>
      <g className="msi-card msi-orange">
        <rect x="325" y="289" width="456" height="510" rx="51" fill="#D97757" />
        <rect x="332" y="296" width="442" height="496" rx="44" stroke="white" strokeWidth="14" fill="none" />
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M610 394C614 394 618 395.667 622 399L685 453C691 458.333 691 464 685 470L622 525C618 528.333 613.667 529.333 609 528C601.667 525.333 598 520 598 512V482H455C441 482 428.333 486.333 417 495C411 499.667 408 498 408 490V485C408 471 413.667 460 425 452C435 446 446.667 443 460 443H598V407C598 398.333 602 394 610 394Z"
          fill="white"
        />
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M490.5 522C495.167 522 498.5 524.333 500.5 529V570H644.5C658.5 570 671.167 565.667 682.5 557C685.167 555 686.5 556.667 686.5 562V570C686.5 584 681.167 594.667 670.5 602C661.167 606.667 650.5 609 638.5 609H500.5V646C500.5 654 497.167 658 490.5 658C486.5 658 483.167 656.667 480.5 654L411.5 599C405.5 593 405.5 587.333 411.5 582L480.5 527C483.167 523.667 486.5 522 490.5 522Z"
          fill="white"
        />
      </g>
    </svg>
  )
}
