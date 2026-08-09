# Loom's Wails v3 fork

This is a narrow source fork of `github.com/wailsapp/wails/v3` at
`v3.0.0-beta.4`. It contains the packages needed by Loom's build and keeps the
upstream implementation unchanged except for the server middleware hook:

- `application.ServerOptions.Middleware` accepts `func(http.Handler) http.Handler`.
- server mode applies it to the complete handler returned by `createHandler`.

Loom uses that hook to authenticate Wails' event WebSocket together with the
asset and RPC routes. The upstream Wails CLI remains pinned to the same beta
release for binding generation.
