export interface CanvasBoardExecutor {
  execute<T>(action: () => Promise<T>): Promise<T>
  cancelGesture?(): void
  isActive?(): boolean
}
