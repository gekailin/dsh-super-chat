/**
 * Minimal local contracts for the DSH browser plugin surface this package uses.
 *
 * The runtime values are provided by DSH through the client slot/locale services; these types only
 * describe the small surface the panel relies on, so the package does not have to pin the internal
 * type packages of the host. They mirror the public registration shapes documented by DSH.
 */
import type { ReactNode } from 'react'
import type { WorkspaceGroupSnapshot } from '../workspace-group.ts'

/** Bare observable source behind the client Workspace snapshot. */
export interface WorkspaceSource {
  getSnapshot(): WorkspaceGroupSnapshot
  subscribe(listener: () => void): () => void
}

/** Translation function bound to this plugin's locale namespace. */
export type Translate = (key: string, values?: Record<string, string | number>) => string

/** The slot registration fields used by this plugin. */
export interface SlotSpec {
  name: string
  key?: string
  id?: string
  order?: number
  locale?: string
  label?: () => string
  inject?: () => Record<string, unknown>
}

/** The subset of a DSH browser plugin context this plugin uses. */
export interface ClientContext {
  effect(factory: () => (() => void) | undefined, label?: string): void
  locale: {
    register(namespace: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): () => void
    bind(namespace: string): Translate
  }
  slots: {
    inject(name: string, factory: () => (() => void) | undefined): void
    register<P>(spec: SlotSpec, component: (props: P) => ReactNode): () => void
  }
  layout: { selectPanel(id: string): void }
  /** Client Workspace state; absent only on hosts without the workspace browser. */
  workspaces?: { list: WorkspaceSource }
}
