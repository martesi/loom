export interface CanvasBoardExecutor {
  execute<T>(action: () => Promise<T>): Promise<T>
  admit?<T>(action: () => Promise<T>, boardMutation?: boolean): Promise<T>
  cancelGesture?(): void
  isActive?(): boolean
  getLifetimeRevision?(): number
}
