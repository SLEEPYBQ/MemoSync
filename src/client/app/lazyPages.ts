import { lazy } from "react"

export const LazyMemoryBoardPage = lazy(() => import("./MemoryBoardPage").then(module => ({ default: module.MemoryBoardPage })))
export const LazySettingsPage = lazy(() => import("./SettingsPage").then(module => ({ default: module.SettingsPage })))
