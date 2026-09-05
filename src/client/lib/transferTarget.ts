// Target defaults for the transfer dialog. Transferring within the same scope
// is a no-op for personal memories (there is only one personal board), so they
// default to — and can only pick — project. Project memories may still target
// "project" (another project); session memories may target either.

export type TransferTargetScope = "personal" | "project"

export function defaultTransferScope(itemScope: string): TransferTargetScope {
  return itemScope === "personal" ? "project" : "personal"
}

export function transferScopeDisabled(itemScope: string, target: TransferTargetScope): boolean {
  return target === "personal" && itemScope === "personal"
}
